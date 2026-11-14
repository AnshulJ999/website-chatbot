import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Review tools (Notes, Design menu) load only when a notes server is set in a local, git-ignored .env.local.
if (import.meta.env.VITE_NOTES_SERVER) void import("./dev-notes").then((m) => m.loadDevTools(import.meta.env.VITE_NOTES_SERVER as string));
