import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Dev: serves the Playground (playground/index.html) and the widget source with live reload.
// Build: one self-contained IIFE file the server hosts at /widget/widget.js.
export default defineConfig(({ command }) => ({
  plugins: [preact()],
  root: command === "serve" ? resolve(__dirname, "playground") : __dirname,
  server: { fs: { allow: [resolve(__dirname, "../..")] }, cors: true },
  build: {
    outDir: resolve(__dirname, "../server/public/widget"),
    emptyOutDir: true,
    target: "es2020",
    lib: {
      entry: resolve(__dirname, "src/main.tsx"),
      formats: ["iife"],
      name: "WebsiteChatbot",
      fileName: () => "widget.js",
    },
  },
}));
