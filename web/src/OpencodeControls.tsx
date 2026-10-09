import { useEffect, useRef, useState } from "react";
import { api, type OpencodeOptions } from "./api.ts";
import { Icon } from "./Home.tsx";

export const variantLabel = (v: string | null) => v ?? "default";

/**
 * OpenCode's model and variant (its effort) for a pane, and a way to change them: picking drives
 * OpenCode's own dialog (model) or ctrl+t (variant) on the server. One change at a time.
 */
export function useOpencodeOptions(paneId: string, busy: boolean) {
  const [options, setOptions] = useState<OpencodeOptions | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  const load = () => api.opencodeOptions(paneId).then(setOptions).catch(() => {});
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, busy]);

  /** true when OpenCode took the change */
  const apply = async (change: () => Promise<void>): Promise<boolean> => {
    if (locked.current) return false;
    locked.current = true;
    setWorking(true);
    setError(null);
    try {
      await change();
      return true;
    } catch {
      setError("OpenCode rejected the change");
      return false;
    } finally {
      await load();
      setWorking(false);
      locked.current = false;
    }
  };
  const setModel = (provider: string, model: string) => apply(() => api.opencodeModel(paneId, provider, model));
  const setVariant = (variant: string | null) => apply(() => api.opencodeVariant(paneId, variant));
  const current = options?.models.find((m) => m.model === options.current.model);
  const modelLabel = current?.name ?? options?.current.model ?? "Model";
  return { options, working, error, setModel, setVariant, modelLabel };
}

/** the model list, then a note: OpenCode's dialog can only reach the recent ones */
export function OpencodeModelList({ options, onPick, item }: { options: OpencodeOptions; onPick: (provider: string, model: string) => void; item: string }) {
  return (
    <>
      {options.models.map((m) => {
        const on = m.model === options.current.model;
        return (
          <button key={`${m.provider}/${m.model}`} type="button" role="menuitemradio" aria-checked={on} onClick={() => onPick(m.provider, m.model)} className={item}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-semibold">{m.name}</span>
              <span className="truncate text-xs text-muted">{m.providerName}</span>
            </span>
            {on && <Icon d="M5 12l5 5 9-10" size={16} width={2.4} className="shrink-0 text-accent-ink" />}
          </button>
        );
      })}
      <p className="px-3 pt-1.5 pb-1 text-xs text-muted">Your recent OpenCode models. For others, use /models in the terminal.</p>
    </>
  );
}

export function OpencodeVariantList({ options, onPick, item }: { options: OpencodeOptions; onPick: (variant: string | null) => void; item: string }) {
  return (
    <>
      {options.variants.map((v) => {
        const on = v === options.current.variant;
        return (
          <button key={v ?? "default"} type="button" role="menuitemradio" aria-checked={on} onClick={() => onPick(v)} className={item}>
            <span className="flex-1">{variantLabel(v)}</span>
            {on && <Icon d="M5 12l5 5 9-10" size={16} width={2.4} className="shrink-0 text-accent-ink" />}
          </button>
        );
      })}
    </>
  );
}

/** Desktop header: OpenCode's model and variant as two buttons, each opening its list. */
export function OpencodeControls({ paneId, busy }: { paneId: string; busy: boolean }) {
  const { options, working, error, setModel, setVariant, modelLabel } = useOpencodeOptions(paneId, busy);
  const [open, setOpen] = useState<"model" | "variant" | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  if (!options || options.models.length === 0) return null;
  const disabled = busy || working;
  const why = busy ? "Available when OpenCode is ready" : working ? "Applying…" : undefined;
  const chevron = <Icon d="M6 9l6 6 6-6" size={14} width={2.2} className="text-muted" />;
  const button = "flex h-9 cursor-pointer items-center gap-1.5 px-3 text-[13px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
  const item = "flex w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-sunken";

  return (
    <div ref={root} className="relative hidden shrink-0 lg:block">
      <div className="flex overflow-hidden rounded-full border border-line">
        <button type="button" disabled={disabled} title={why ?? "Change model"} aria-expanded={open === "model"} onClick={() => setOpen(open === "model" ? null : "model")} className={button}>
          {working ? "Applying…" : modelLabel}
          {chevron}
        </button>
        <span className="w-px bg-line" aria-hidden="true" />
        <button type="button" disabled={disabled || options.variants.length < 2} title={why ?? "Change variant"} aria-expanded={open === "variant"} onClick={() => setOpen(open === "variant" ? null : "variant")} className={button}>
          <span className="font-normal text-muted">effort</span>
          {variantLabel(options.current.variant)}
          {chevron}
        </button>
      </div>
      {error && <span className="absolute top-11 right-0 rounded-lg bg-danger px-2 py-1 text-xs whitespace-nowrap text-danger-ink">{error}</span>}
      {open && (
        <div role="menu" className="absolute top-11 right-0 z-30 flex max-h-[60vh] w-72 flex-col gap-0.5 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-dialog">
          {open === "model" ? (
            <OpencodeModelList options={options} item={item} onPick={(provider, model) => { setOpen(null); void setModel(provider, model); }} />
          ) : (
            <OpencodeVariantList options={options} item={item} onPick={(v) => { setOpen(null); void setVariant(v); }} />
          )}
        </div>
      )}
    </div>
  );
}
