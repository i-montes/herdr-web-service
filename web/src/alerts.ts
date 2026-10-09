/**
 * How this browser hears about sessions: toasts and a sound while the app is open, push
 * notifications while it is not. The sound can be muted from Home or a session's "⋯" menu (one
 * setting, per browser); push is turned on per device, needs HTTPS, and on an iPhone the app
 * installed on the home screen.
 */
import { useSyncExternalStore } from "react";
import type { Notice } from "../../shared/protocol.ts";
import { api } from "./api.ts";

const MUTED_KEY = "herdr-web.sound-muted";

type Listener = () => void;
const listeners = new Set<Listener>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// --- sound ----------------------------------------------------------------------------------

let muted = (() => {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
})();

export function soundMuted(): boolean {
  return muted;
}

export function setSoundMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(MUTED_KEY, value ? "1" : "0");
  } catch {
    /* private mode: muted until the page reloads */
  }
  changed();
}

export function useSoundMuted(): boolean {
  return useSyncExternalStore(subscribe, soundMuted);
}

/**
 * Whether the person is looking at the app: the tab in view and its window focused. A desktop
 * browser keeps a tab "visible" behind another app's window; only the focus tells it apart.
 */
export function attending(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

// --- notices from the server ----------------------------------------------------------------

const noticeListeners = new Set<(notice: Notice) => void>();

export function emitNotice(notice: Notice): void {
  noticeListeners.forEach((l) => l(notice));
}

export function onNotice(listener: (notice: Notice) => void): () => void {
  noticeListeners.add(listener);
  return () => noticeListeners.delete(listener);
}

// --- push -----------------------------------------------------------------------------------

/**
 * on: this device gets pushes. off: it could. denied: the browser blocks them (only its own
 * settings undo that). insecure: plain HTTP. unsupported: no Push API here (an iPhone outside the
 * installed app, an old browser).
 */
export type PushState = "on" | "off" | "denied" | "insecure" | "unsupported" | "loading";

let pushState: PushState = "loading";
let endpoint: string | null = null;

export function pushEndpoint(): string | null {
  return endpoint;
}

function setPush(state: PushState, sub: PushSubscription | null): void {
  pushState = state;
  endpoint = sub?.endpoint ?? null;
  changed();
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** where push stands on this device; a subscription the server lost (its sign-in ended) is sent again */
export async function refreshPush(): Promise<void> {
  if (!window.isSecureContext) return setPush("insecure", null);
  if (!supported()) return setPush("unsupported", null);
  if (Notification.permission === "denied") return setPush("denied", null);
  const reg = await registration();
  const sub = (await reg?.pushManager.getSubscription()) ?? null;
  if (sub) await api.pushSubscribe(sub.toJSON()).catch(() => {});
  setPush(sub ? "on" : "off", sub);
}

const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** asks for permission (it must follow a tap) and subscribes this device; the error says why not */
export async function enablePush(): Promise<string | null> {
  if (!window.isSecureContext) return "Notifications need HTTPS.";
  if (!supported()) return "This browser can't receive notifications. On an iPhone, add the app to the home screen first.";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setPush(permission === "denied" ? "denied" : "off", null);
    return permission === "denied" ? "Notifications are blocked in this browser's settings." : null;
  }
  const reg = await navigator.serviceWorker.ready;
  try {
    const { key } = await api.pushKey();
    let sub = await reg.pushManager.getSubscription();
    // a subscription made for another server key (the keys were remade) cannot be reused
    const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    const wanted = fromB64url(key);
    if (sub && (!current || current.length !== wanted.length || current.some((b, i) => b !== wanted[i]))) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    await api.pushSubscribe(sub.toJSON());
    setPush("on", sub);
    return null;
  } catch (error) {
    await refreshPush().catch(() => {});
    return error instanceof Error ? `Couldn't turn on notifications: ${error.message}` : "Couldn't turn on notifications.";
  }
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  setPush("off", null);
}

export function usePushState(): PushState {
  return useSyncExternalStore(subscribe, () => pushState);
}

/** roster.ts listens: a new or dropped subscription goes to the server with the next presence */
export function onAlertsChange(listener: Listener): () => void {
  return subscribe(listener);
}
