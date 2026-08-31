"""Ephemeral Facebook -> NotebookLM media bridge for Google Colab.

The public Gradio endpoint is a token-protected control plane only. Media bytes
move directly from Colab to the one-time Google upload URL supplied by the
extension and are never exposed as Gradio files.
"""

import concurrent.futures
import hashlib
import importlib.metadata
import json
import mimetypes
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests

GRADIO_VERSION = "6.26.0"
YT_DLP_VERSION = "2026.8.19"
LOCALTUNNEL_VERSION = "2.0.2"
CLOUDFLARED_VERSION = "2026.8.3"
CLOUDFLARED_SHA256 = "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e"


def _require_python_package(distribution, requirement):
    try:
        if importlib.metadata.version(distribution) == requirement.split("==", 1)[1]:
            return
    except importlib.metadata.PackageNotFoundError:
        pass
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", requirement])


_require_python_package("gradio", f"gradio=={GRADIO_VERSION}")
_require_python_package("yt-dlp", f"yt-dlp=={YT_DLP_VERSION}")

import gradio as gr
from yt_dlp import YoutubeDL

PROTOCOL = 1
SESSION_ID = str(globals().get("NLM_SESSION_ID") or "").strip()
TOKEN = secrets.token_urlsafe(48)
ROOT = Path("/content/notebooklm_facebook_bridge") / (SESSION_ID or uuid.uuid4().hex)
ROOT.mkdir(parents=True, exist_ok=True)
MAX_TASKS = 30
MAX_WORKERS = 3
MAX_MEDIA_BYTES = 200 * 1024 * 1024
UPLOAD_SESSION_TIMEOUT = 15 * 60

_lock = threading.RLock()
_events = []
_sequence = 0
_batch_running = False
_started_task_ids = ()
_batch_start_cursor = 0
_cancelled = threading.Event()
_upload_sessions = {}
_tunnel_process = None


def _clean(value, limit=500):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _safe_name(value, fallback):
    name = re.sub(r"[\x00-\x1f\x7f\\/:*?\"<>|]+", "_", str(value or "")).strip(" ._")
    return (name[:120].rstrip(" ._") or fallback)


def _authorized(token):
    if not secrets.compare_digest(str(token or ""), TOKEN):
        raise gr.Error("Unauthorized control request")


def _emit(event_type, **payload):
    global _sequence
    with _lock:
        _sequence += 1
        event = {
            "event_id": uuid.uuid4().hex,
            "sequence": _sequence,
            "type": event_type,
            **payload,
        }
        _events.append(event)
        if len(_events) > 1000:
            del _events[:-800]
        return event


def _is_facebook_url(value):
    try:
        url = urlparse(str(value))
        host = (url.hostname or "").lower()
        return url.scheme == "https" and (host == "facebook.com" or host.endswith(".facebook.com") or host == "fb.watch")
    except Exception:
        return False


def _is_google_upload_url(value):
    try:
        url = urlparse(str(value))
        host = (url.hostname or "").lower()
        return url.scheme == "https" and (
            host == "google.com"
            or host.endswith(".google.com")
            or host == "googleusercontent.com"
            or host.endswith(".googleusercontent.com")
        )
    except Exception:
        return False


def _find_media_file(task_dir):
    ignored = {".part", ".ytdl", ".tmp", ".temp"}
    files = [item for item in task_dir.iterdir() if item.is_file() and item.suffix.lower() not in ignored]
    return max(files, key=lambda item: item.stat().st_mtime) if files else None


def _probe_media(path):
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(path)],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("ffprobe 无法识别下载文件")
    streams = json.loads(result.stdout or "{}").get("streams") or []
    kinds = {item.get("codec_type") for item in streams}
    if not kinds.intersection({"audio", "video"}):
        raise RuntimeError("下载结果不是音频或视频")
    mime = mimetypes.guess_type(path.name)[0] or ("video/mp4" if "video" in kinds else "audio/mpeg")
    if not re.match(r"^(audio|video)/", mime, flags=re.I):
        mime = "video/mp4" if "video" in kinds else "audio/mpeg"
    return mime


def _download(task, task_dir):
    post_id = _safe_name(task.get("postId"), f"facebook_{task['taskId']}")

    def enforce_size(progress):
        downloaded = int(progress.get("downloaded_bytes") or 0)
        estimated = int(progress.get("total_bytes") or progress.get("total_bytes_estimate") or 0)
        if max(downloaded, estimated) > MAX_MEDIA_BYTES:
            raise RuntimeError(f"媒体超过 {MAX_MEDIA_BYTES // (1024 * 1024)} MB 上限")

    options = {
        "outtmpl": str(task_dir / f"{post_id}.%(ext)s"),
        "format": "bestvideo[height<=480]+bestaudio/best[height<=480]/best",
        "merge_output_format": "mp4",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
        "max_filesize": MAX_MEDIA_BYTES,
        "progress_hooks": [enforce_size],
    }
    with YoutubeDL(options) as downloader:
        downloader.extract_info(task["url"], download=True)
    path = _find_media_file(task_dir)
    if not path:
        raise RuntimeError("下载完成但没有找到媒体文件")
    if path.stat().st_size > MAX_MEDIA_BYTES:
        raise RuntimeError(f"媒体超过 {MAX_MEDIA_BYTES // (1024 * 1024)} MB 上限")
    return path, _probe_media(path)


def _process_task(task):
    task_id = task["taskId"]
    task_dir = ROOT / _safe_name(task_id, uuid.uuid4().hex)
    task_dir.mkdir(parents=True, exist_ok=False)
    try:
        if _cancelled.is_set():
            raise RuntimeError("任务已取消")
        _emit("task", task_id=task_id, status="downloading")
        path, mime_type = _download(task, task_dir)
        size = path.stat().st_size
        _emit("task", task_id=task_id, status="downloaded", file_name=path.name, mime_type=mime_type, size=size)

        session_queue = _upload_sessions.setdefault(task_id, queue.Queue(maxsize=1))
        try:
            upload = session_queue.get(timeout=UPLOAD_SESSION_TIMEOUT)
        except queue.Empty:
            raise RuntimeError("等待 NotebookLM 上传会话超时")
        if upload.get("error"):
            raise RuntimeError(_clean(upload.get("error")))
        if _cancelled.is_set():
            raise RuntimeError("任务已取消")
        if not _is_google_upload_url(upload.get("uploadUrl")):
            raise RuntimeError("NotebookLM 上传地址无效")

        source_id = str(upload.get("sourceId") or "")
        _emit("task", task_id=task_id, status="uploading", source_id=source_id)
        with path.open("rb") as media:
            response = requests.post(
                upload["uploadUrl"],
                data=media,
                headers={
                    "Content-Type": mime_type,
                    "X-Goog-Upload-Command": "upload, finalize",
                    "X-Goog-Upload-Offset": "0",
                },
                timeout=(30, 60 * 60),
            )
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f"Google 上传失败（HTTP {response.status_code}）")
        _emit("task", task_id=task_id, status="uploaded", source_id=source_id, file_name=path.name, mime_type=mime_type, size=size)
        return True
    except Exception as error:
        _emit("task", task_id=task_id, status="failed", error=_clean(error))
        return False
    finally:
        with _lock:
            _upload_sessions.pop(task_id, None)
        shutil.rmtree(task_dir, ignore_errors=True)


def _run_batch(tasks):
    global _batch_running
    succeeded = 0
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(tasks))) as executor:
            futures = [executor.submit(_process_task, task) for task in tasks]
            for future in concurrent.futures.as_completed(futures):
                succeeded += 1 if future.result() else 0
        _emit("complete", total=len(tasks), succeeded=succeeded, failed=len(tasks) - succeeded)
    except Exception as error:
        _emit("fatal", code="BATCH_CRASH", message=_clean(error))
    finally:
        with _lock:
            _batch_running = False


def start_batch(tasks_json, token):
    global _batch_running, _started_task_ids, _batch_start_cursor
    _authorized(token)
    with _lock:
        tasks = json.loads(str(tasks_json or "[]"))
        if not isinstance(tasks, list) or not 1 <= len(tasks) <= MAX_TASKS:
            raise gr.Error(f"Task count must be between 1 and {MAX_TASKS}")
        clean_tasks = []
        seen = set()
        for item in tasks:
            task_id = str(item.get("taskId") or "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", task_id) or task_id in seen or not _is_facebook_url(item.get("url")):
                raise gr.Error("Invalid Facebook task payload")
            seen.add(task_id)
            clean_tasks.append({"taskId": task_id, "postId": _safe_name(item.get("postId"), task_id), "url": item["url"]})
        task_ids = tuple(item["taskId"] for item in clean_tasks)
        if _batch_running:
            if task_ids == _started_task_ids:
                return json.dumps({"ok": True, "accepted": len(task_ids), "duplicate": True, "cursor": _batch_start_cursor}, separators=(",", ":"))
            return json.dumps({"ok": False, "error": "batch_in_progress"})
        _cancelled.clear()
        _batch_start_cursor = _sequence
        for item in clean_tasks:
            task_id = item["taskId"]
            _upload_sessions[task_id] = queue.Queue(maxsize=1)
            _emit("task", task_id=task_id, status="queued")
        _batch_running = True
        _started_task_ids = task_ids
    threading.Thread(target=_run_batch, args=(clean_tasks,), daemon=True).start()
    return json.dumps({"ok": True, "accepted": len(clean_tasks), "cursor": _batch_start_cursor}, separators=(",", ":"))


def health(token):
    _authorized(token)
    return json.dumps({
        "ok": True,
        "protocol": PROTOCOL,
        "sessionId": SESSION_ID,
        "busy": _batch_running,
    }, separators=(",", ":"))


def provide_upload(payload_json, token):
    _authorized(token)
    payload = json.loads(str(payload_json or "{}"))
    task_id = str(payload.get("taskId") or "")
    target = _upload_sessions.get(task_id)
    if target is None:
        raise gr.Error("Unknown task")
    if target.full():
        return json.dumps({"ok": True, "duplicate": True})
    target.put_nowait({
        "sourceId": str(payload.get("sourceId") or ""),
        "uploadUrl": str(payload.get("uploadUrl") or ""),
        "error": _clean(payload.get("error")),
    })
    return json.dumps({"ok": True}, separators=(",", ":"))


def poll_events(after_sequence, token):
    _authorized(token)
    try:
        cursor = max(0, int(after_sequence or 0))
    except Exception:
        cursor = 0
    with _lock:
        values = [event for event in _events if int(event.get("sequence") or 0) > cursor]
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def cancel_batch(token):
    _authorized(token)
    _cancelled.set()
    return json.dumps({"ok": True}, separators=(",", ":"))


def _start_localtunnel(local_url):
    global _tunnel_process
    port = urlparse(str(local_url)).port
    if not port:
        raise RuntimeError("本地控制端口无效")
    _tunnel_process = subprocess.Popen(
        ["npx", "--yes", f"localtunnel@{LOCALTUNNEL_VERSION}", "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    output = queue.Queue()

    def read_output():
        for line in _tunnel_process.stdout:
            output.put(line)

    threading.Thread(target=read_output, daemon=True).start()
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            line = output.get(timeout=1)
        except queue.Empty:
            if _tunnel_process.poll() is not None:
                break
            continue
        match = re.search(r"https://[a-z0-9-]+\.loca\.lt", line, flags=re.I)
        if match:
            return match.group(0)
    raise RuntimeError("LocalTunnel 临时控制通道启动失败")


def _start_cloudflare_tunnel(local_url):
    global _tunnel_process
    binary = Path("/content/cloudflared")
    binary_valid = binary.exists() and hashlib.sha256(binary.read_bytes()).hexdigest() == CLOUDFLARED_SHA256
    if not binary_valid:
        binary.unlink(missing_ok=True)
        response = requests.get(
            f"https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/cloudflared-linux-amd64",
            timeout=(20, 120),
        )
        response.raise_for_status()
        payload = response.content
        digest = hashlib.sha256(payload).hexdigest()
        if digest != CLOUDFLARED_SHA256:
            raise RuntimeError("cloudflared 下载校验失败")
        binary.write_bytes(payload)
        binary.chmod(0o755)
    _tunnel_process = subprocess.Popen(
        [str(binary), "tunnel", "--url", str(local_url), "--no-autoupdate"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    output = queue.Queue()

    def read_output():
        for line in _tunnel_process.stdout:
            output.put(line)

    threading.Thread(target=read_output, daemon=True).start()
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            line = output.get(timeout=1)
        except queue.Empty:
            if _tunnel_process.poll() is not None:
                break
            continue
        match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line, flags=re.I)
        if match:
            return match.group(0)
    raise RuntimeError("Cloudflare 临时控制通道启动失败")


with gr.Blocks(title="NotebookLM Facebook bridge") as app:
    gr.Markdown("### NotebookLM 临时媒体桥\n此页面仅为当前扩展任务提供控制通道。请保持标签页与运行时开启。")
    tasks_input = gr.Textbox(visible=False)
    upload_input = gr.Textbox(visible=False)
    cursor_input = gr.Number(visible=False)
    token_input = gr.Textbox(visible=False)
    result_output = gr.Textbox(visible=False)
    start_button = gr.Button(visible=False)
    health_button = gr.Button(visible=False)
    upload_button = gr.Button(visible=False)
    poll_button = gr.Button(visible=False)
    cancel_button = gr.Button(visible=False)
    start_button.click(start_batch, [tasks_input, token_input], result_output, api_name="start_batch")
    health_button.click(health, [token_input], result_output, api_name="health")
    upload_button.click(provide_upload, [upload_input, token_input], result_output, api_name="provide_upload")
    poll_button.click(poll_events, [cursor_input, token_input], result_output, api_name="poll_events")
    cancel_button.click(cancel_batch, [token_input], result_output, api_name="cancel_batch")

_, local_url, _ = app.queue(default_concurrency_limit=8, max_size=64).launch(
    share=False,
    prevent_thread_lock=True,
    quiet=True,
    show_error=True,
    inline=False,
    footer_links=[],
)
try:
    share_url = _start_localtunnel(local_url)
except Exception:
    share_url = _start_cloudflare_tunnel(local_url)

control_event = {
    "event_id": uuid.uuid4().hex,
    "type": "control",
    "protocol": PROTOCOL,
    "session_id": SESSION_ID,
    "base_url": share_url,
    "token": TOKEN,
}
print("NLM_BRIDGE:" + json.dumps(control_event, ensure_ascii=False, separators=(",", ":")), flush=True)
try:
    from IPython.display import Javascript, display
    browser_message = json.dumps(
        {"channel": "nlm-colab-output", "event": control_event},
        ensure_ascii=True,
        separators=(",", ":"),
    )
    display(Javascript(f"window.parent.postMessage({browser_message}, '*');"))
except Exception:
    # The printed bridge record remains as a compatibility fallback.
    pass
