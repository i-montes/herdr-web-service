import { useEffect, useState } from "react";
import { ago } from "./home.ts";

/**
 * "12s ago" that keeps counting by itself: ticks every second during the first minute,
 * then every 15 s, so each label stays current without re-rendering the page. `format` changes
 * the wording ("open 3h", "working for 4 min"); returning null shows the fallback.
 */
export function Ago({ at, className, fallback = null, format = ago, title }: { at: number | null; className?: string; fallback?: React.ReactNode; format?: (at: number | null, now: number) => string | null; title?: string }) {
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
  const text = format(at, now);
  if (text === null) return <>{fallback}</>;
  return (
    <time dateTime={new Date(at!).toISOString()} className={className} title={title}>
      {text}
    </time>
  );
}
