import { createServer } from "vite";
import { resolve } from "node:path";
const server = await createServer({ configFile: false, root: process.cwd(), publicDir: false,
  resolve: { alias: { "@": resolve("src") } }, server: { host: "127.0.0.1", port: 4177, strictPort: true } });
await server.listen();
console.log("Workspace preview: http://127.0.0.1:4177/tests/fixtures/workspace.html");
