import { useEffect, useState } from "react";
import { ago } from "./home.ts";

/**
 * "hace 12 s" that keeps counting by itself: ticks every second during the first minute,
 * then every 15 s, so each label stays current without re-rendering the page.
 */
export function Ago({ at, className, fallback = null }: { at: number | null; className?: string; fallback?: React.ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      timer = setTimeout(tick, t - at < 60_000 ? 1000 : 15_000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [at]);
  const text = ago(at, now);
  if (text === null) return <>{fallback}</>;
  return (
    <time dateTime={new Date(at!).toISOString()} className={className}>
      {text}
    </time>
  );
}
