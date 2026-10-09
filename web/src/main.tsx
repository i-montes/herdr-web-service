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
  // a tapped notification: the service worker hands over the session to open
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<{ type?: string; url?: string }>) => {
    if (event.data?.type !== "open" || !event.data.url) return;
    const target = new URL(event.data.url, location.origin);
    if (target.origin === location.origin) location.hash = target.hash;
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
