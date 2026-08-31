import { resolve } from "node:path";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest";

export default defineConfig({
  publicDir: "assets",
  resolve: {
    alias: {
      "@": resolve(__dirname, "src")
    }
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  plugins: [
    crx({ manifest })
  ]
});
