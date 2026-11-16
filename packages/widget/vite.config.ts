import { resolve } from "node:path";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// Dev: serves the Playground (playground/index.html) and the widget source with live reload.
// Build (default): one self-contained IIFE file the server hosts at /widget/widget.js.
// Build --mode preview: the same widget plus the Design menu hooks, at /widget/widget-preview.js, for
// a site's own dev and preview pages (its Design menu lists the chat's rows). Never loaded on a live site.
// Build --mode playground: the Playground page the server hosts at /playground/ (owner only).
export default defineConfig(({ command, mode }) => {
  const playground = command === "serve" || mode === "playground";
  const preview = mode === "preview";
  return {
    plugins: [preact()],
    define: { __WCB_PLAYGROUND__: JSON.stringify(playground), __WCB_DESIGN__: JSON.stringify(playground || preview) },
    root: playground ? resolve(__dirname, "playground") : __dirname,
    envDir: __dirname,
    base: mode === "playground" ? "/playground/" : "/",
    server: { fs: { allow: [resolve(__dirname, "../..")] }, cors: true },
    build:
      mode === "playground"
        ? { outDir: resolve(__dirname, "../server/public/playground"), emptyOutDir: true, target: "es2020" }
        : {
            outDir: resolve(__dirname, "../server/public/widget"),
            // The preview build runs second and adds its file next to widget.js.
            emptyOutDir: !preview,
            target: "es2020",
            lib: {
              entry: resolve(__dirname, "src/main.tsx"),
              formats: ["iife"],
              name: "WebsiteChatbot",
              fileName: () => (preview ? "widget-preview.js" : "widget.js"),
            },
            rollupOptions: { output: { inlineDynamicImports: true } },
          },
  };
});
