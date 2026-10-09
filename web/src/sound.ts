/**
 * The notice sounds, made with WebAudio (no audio files): two rising notes when a session needs
 * you, one falling note when one finishes. Browsers only allow sound after the person interacted
 * with the page, so the audio context starts on the first tap or key.
 */
let context: AudioContext | null = null;

function unlock(): void {
  try {
    context ??= new AudioContext();
    void context.resume();
  } catch {
    /* no WebAudio: notices stay silent */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
}

function note(ctx: AudioContext, frequency: number, start: number, length: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  // a soft attack and an exponential tail: a chime, not a beep
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

export function playNoticeSound(kind: "blocked" | "finished"): void {
  if (!context || context.state !== "running") return;
  const now = context.currentTime;
  if (kind === "blocked") {
    note(context, 660, now, 0.18);
    note(context, 880, now + 0.14, 0.32);
  } else {
    note(context, 784, now, 0.16);
    note(context, 587, now + 0.12, 0.34);
  }
}
