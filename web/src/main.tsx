import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import { captureInstallPrompt } from "./install.ts";
import { initTheme } from "./theme.ts";

initTheme();
captureInstallPrompt();

// installable app; browsers only allow service workers on HTTPS or localhost
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
