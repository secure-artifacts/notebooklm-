import test from "node:test";
import assert from "node:assert/strict";
import {
  FACEBOOK_BATCH_SIZE,
  FACEBOOK_MAX_TASKS,
  NOTEBOOK_SOURCE_LIMIT,
  createFacebookJob,
  facebookTaskFingerprint,
  formatFacebookTasks,
  nextFacebookBatch,
  removeFacebookJobTasks,
  retainedSourceCapacity
} from "../src/lib/facebookQueue";
import type { FacebookDownloadTask } from "../src/lib/colabProvider";

function tasks(count: number): FacebookDownloadTask[] {
  return Array.from({ length: count }, (_, index) => ({
    taskId: `fb-${index + 1}`,
    postId: `post-${index + 1}`,
    url: `https://www.facebook.com/watch/?v=${index + 1}`
  }));
}

test("Facebook queue accepts 1000 tasks and defaults to paused", () => {
  const job = createFacebookJob("d36d4c4f-4e72-424f-829c-7f92d8436aeb", tasks(FACEBOOK_MAX_TASKS), {
    autoDelete: true,
    translate: false,
    autoRegister: false
  }, 1000);
  assert.equal(job.tasks.length, 1000);
  assert.equal(job.nextIndex, 0);
  assert.equal(job.activeBatchStart, 0);
  assert.deepEqual(job.activeSourceIds, []);
  assert.equal(job.status, "paused");
  assert.throws(() => createFacebookJob(job.notebookId, tasks(1001), {
    autoDelete: true,
    translate: false,
    autoRegister: false
  }), /1 到 1000/u);
});

test("next batch respects both batch size and remaining NotebookLM capacity", () => {
  const job = createFacebookJob("d36d4c4f-4e72-424f-829c-7f92d8436aeb", tasks(45), {
    autoDelete: true,
    translate: false,
    autoRegister: false
  });
  assert.equal(nextFacebookBatch(job, 0).length, FACEBOOK_BATCH_SIZE);
  assert.equal(nextFacebookBatch(job, 47).length, 3);
  assert.equal(nextFacebookBatch(job, NOTEBOOK_SOURCE_LIMIT).length, 0);
  job.nextIndex = 40;
  assert.equal(nextFacebookBatch(job, 0).length, 5);
});

test("retained capacity never exceeds the NotebookLM source limit", () => {
  assert.equal(retainedSourceCapacity(0), 50);
  assert.equal(retainedSourceCapacity(49), 1);
  assert.equal(retainedSourceCapacity(80), 0);
});

test("task formatting round-trips stable queue identity", () => {
  const input = tasks(3);
  assert.equal(facebookTaskFingerprint(input), facebookTaskFingerprint(input.map((task) => ({ ...task }))));
  assert.match(formatFacebookTasks(input), /^post-1 https:\/\/www\.facebook\.com/u);
});

test("removing persisted tasks keeps queue offsets valid", () => {
  const job = createFacebookJob("d36d4c4f-4e72-424f-829c-7f92d8436aeb", tasks(5), {
    autoDelete: true,
    translate: false,
    autoRegister: false
  }, 1_000);
  job.nextIndex = 4;
  job.activeBatchStart = 4;
  job.status = "completed";
  job.records = [{ sourceId: "source-1", sourceName: "post-1", transcript: "text" }];

  const updated = removeFacebookJobTasks(job, new Set(["fb-2", "fb-4"]), 2_000);
  assert.deepEqual(updated.tasks.map((task) => task.taskId), ["fb-1", "fb-3", "fb-5"]);
  assert.equal(updated.nextIndex, 2);
  assert.equal(updated.activeBatchStart, 2);
  assert.equal(updated.status, "paused");
  assert.equal(updated.records.length, 1);
  assert.equal(updated.updatedAt, 2_000);
});

test("removing every persisted task leaves a completed empty editor queue", () => {
  const job = createFacebookJob("d36d4c4f-4e72-424f-829c-7f92d8436aeb", tasks(2), {
    autoDelete: true,
    translate: false,
    autoRegister: false
  });
  job.nextIndex = 2;
  job.activeBatchStart = 2;
  job.status = "completed";
  const updated = removeFacebookJobTasks(job, new Set(["fb-1", "fb-2"]));
  assert.equal(updated.tasks.length, 0);
  assert.equal(updated.nextIndex, 0);
  assert.equal(updated.activeBatchStart, 0);
  assert.equal(updated.status, "completed");
});
