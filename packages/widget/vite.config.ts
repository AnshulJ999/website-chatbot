import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Dev: serves the Playground (playground/index.html) and the widget source with live reload.
// Build (default): one self-contained IIFE file the server hosts at /widget/widget.js.
// Build --mode playground: the Playground page the server hosts at /playground/ (owner only).
export default defineConfig(({ command, mode }) => {
  const playground = command === "serve" || mode === "playground";
  return {
    plugins: [preact()],
    define: { __WCB_PLAYGROUND__: JSON.stringify(playground) },
    root: playground ? resolve(__dirname, "playground") : __dirname,
    envDir: __dirname,
    base: mode === "playground" ? "/playground/" : "/",
    server: { fs: { allow: [resolve(__dirname, "../..")] }, cors: true },
    build:
      mode === "playground"
        ? { outDir: resolve(__dirname, "../server/public/playground"), emptyOutDir: true, target: "es2020" }
        : {
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
  };
});
