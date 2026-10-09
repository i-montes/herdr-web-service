import { useState } from "react";
import { disablePush, enablePush, setSoundMuted, usePushState, useSoundMuted, type PushState } from "./alerts.ts";
import { Icon } from "./Home.tsx";

export const BELL_ICON = "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0";
export const SOUND_ON_ICON = "M4 10v4h4l5 4V6l-5 4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11";
export const SOUND_OFF_ICON = "M4 10v4h4l5 4V6l-5 4zM17 10l4 4M21 10l-4 4";

/** what the notifications row says for each state, and whether it can be pressed */
export const PUSH_LABEL: Record<PushState, { label: string; hint?: string; enabled: boolean }> = {
  on: { label: "Notifications on", enabled: true },
  off: { label: "Turn on notifications", enabled: true },
  loading: { label: "Notifications", enabled: false },
  denied: { label: "Notifications blocked", hint: "Allow them in this browser's site settings.", enabled: false },
  insecure: { label: "Notifications need HTTPS", hint: "Set up remote access (HTTPS) to get them.", enabled: false },
  unsupported: { label: "No notifications here", hint: "On an iPhone, add the app to the home screen and open it from there.", enabled: false },
};

/** turns push on or off on this device; the error, if any, is for the person */
export function usePushToggle(): { state: PushState; busy: boolean; error: string | null; toggle: () => Promise<void> } {
  const state = usePushState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      if (state === "on") await disablePush();
      else setError(await enablePush());
    } finally {
      setBusy(false);
    }
  };
  return { state, busy, error, toggle };
}

/** Home's sidebar: notifications on this device, and the sound */
export function AlertSettings() {
  const { state, busy, error, toggle } = usePushToggle();
  const muted = useSoundMuted();
  const push = PUSH_LABEL[state];
  const row = "flex min-h-11 cursor-pointer items-center gap-2 text-left text-sm text-muted hover:text-ink disabled:cursor-default disabled:hover:text-muted lg:min-h-10";
  return (
    <>
      <button type="button" disabled={!push.enabled || busy} onClick={() => void toggle()} aria-pressed={state === "on"} title={push.hint} className={row}>
        <Icon d={BELL_ICON} size={16} />
        <span className="flex-1">{busy ? "Working on it…" : push.label}</span>
        {state === "on" && <span className="size-2 rounded-full bg-ok-dot" aria-hidden="true" />}
      </button>
      {(error ?? (!push.enabled && push.hint)) && <p className="-mt-1 text-xs text-muted">{error ?? push.hint}</p>}
      <button type="button" onClick={() => setSoundMuted(!muted)} aria-pressed={!muted} className={row}>
        <Icon d={muted ? SOUND_OFF_ICON : SOUND_ON_ICON} size={16} />
        {muted ? "Sound off" : "Sound on"}
      </button>
    </>
  );
}
