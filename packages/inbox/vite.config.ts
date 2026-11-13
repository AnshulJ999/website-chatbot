import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: /admin/api is proxied to the local server (wrangler dev on 8790).
// Build: static files served by the server's assets at /admin/.
export default defineConfig({
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { "/admin/api": { target: "http://127.0.0.1:8790", ws: true, changeOrigin: true } },
    fs: { allow: [resolve(__dirname, "../..")] },
  },
  build: { outDir: resolve(__dirname, "../server/public/admin"), emptyOutDir: true },
});
