/**
 * PWA install offer. Chromium browsers fire `beforeinstallprompt` (only over HTTPS or localhost):
 * it is kept so our own banner can open the native install dialog. Safari on iPhone/iPad has no
 * such event, so there the banner explains the share-sheet gesture instead.
 */
import { useEffect, useState } from "react";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "herdr-web.install-dismissed";
const DISMISS_MS = 14 * 24 * 3600 * 1000;

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** call once at startup: the event can fire before any component mounts */
export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Safari on iPhone/iPad (iPadOS reports itself as a Mac with touch) */
export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function dismissedRecently(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(DISMISS_KEY) ?? 0) < DISMISS_MS;
  } catch {
    return false;
  }
}

export type InstallOffer = { kind: "native"; install: () => Promise<void> } | { kind: "ios" } | null;

/** what to offer right now, and a way to say "not now" */
export function useInstallOffer(): { offer: InstallOffer; dismiss: () => void } {
  const [, rerender] = useState(0);
  const [hidden, setHidden] = useState(() => isStandalone() || dismissedRecently());

  useEffect(() => {
    const update = () => rerender((n) => n + 1);
    listeners.add(update);
    return () => void listeners.delete(update);
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* private mode: hidden for this page only */
    }
    setHidden(true);
  };

  if (hidden || isStandalone()) return { offer: null, dismiss };
  if (deferred) {
    const event = deferred;
    return {
      offer: {
        kind: "native",
        install: async () => {
          await event.prompt();
          const { outcome } = await event.userChoice;
          deferred = null;
          if (outcome === "dismissed") dismiss();
          else setHidden(true);
          notify();
        },
      },
      dismiss,
    };
  }
  return { offer: isIosSafari() ? { kind: "ios" } : null, dismiss };
}
