import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "../../shared/protocol.ts";
import { Icon } from "./Home.tsx";

/**
 * The address a phone should open, or why there is none. Local mode only listens on this
 * computer, so a phone cannot reach it whatever the QR says.
 */
export function phoneUrl(access: SessionInfo["access"], hash: string): { url: string } | { reason: string } {
  if (!access || access.mode === "local") return { reason: "local" };
  let base: URL;
  try {
    base = new URL(access.url ?? "");
  } catch {
    return { reason: "no-url" };
  }
  return { url: `${base.origin}/${hash && hash !== "#/" ? hash : ""}` };
}

/** Desktop-only button that shows a QR code to continue on the phone. */
export function OpenOnPhone({ access, className = "" }: { access: SessionInfo["access"]; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`hidden min-h-10 cursor-pointer items-center gap-2 text-sm text-muted hover:text-ink lg:flex ${className}`}>
        <Icon d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2" size={16} />
        Open on phone
      </button>
      {/* portal: the button lives in a sticky sidebar, whose stacking context would trap the dialog */}
      {open && createPortal(<PhoneDialog access={access} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

export function PhoneDialog({ access, onClose }: { access: SessionInfo["access"]; onClose: () => void }) {
  const target = phoneUrl(access, location.hash);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async (url: string) => {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(url);
      else {
        // plain HTTP (LAN mode) has no async clipboard: the old select-and-copy still works
        const field = document.createElement("textarea");
        field.value = url;
        document.body.append(field);
        field.select();
        const ok = document.execCommand("copy");
        field.remove();
        if (!ok) throw new Error("copy");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard permission: the URL is on screen anyway */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-[clamp(16px,10vh,96px)] pb-10">
      <div aria-hidden="true" className="fixed inset-0 bg-dialog-scrim" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="phone-title" className="relative flex w-full max-w-[420px] flex-col gap-5 rounded-3xl border border-line bg-surface p-6 shadow-dialog">
        <div className="flex items-center gap-3">
          <h2 id="phone-title" className="text-[26px] font-extrabold tracking-[-0.03em]">Open on phone</h2>
          <button type="button" onClick={onClose} aria-label="Close" autoFocus className="ml-auto flex size-11 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink">
            <Icon d="M6 6l12 12M18 6L6 18" size={18} width={2.2} />
          </button>
        </div>

        {"url" in target ? (
          <>
            <p className="text-[15px] text-muted">Scan it with your phone's camera and sign in with your password.</p>
            <div className="self-center rounded-2xl bg-white p-4">
              <Qr text={target.url} size={232} />
            </div>
            <button type="button" onClick={() => void copy(target.url)} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line bg-inset px-3.5 text-left font-mono text-[13px]" title="Copy">
              <span className="min-w-0 flex-1 truncate">{target.url}</span>
              <span className="font-sans text-sm font-semibold text-accent-ink">{copied ? "Copied" : "Copy"}</span>
            </button>
            {access?.mode === "lan" ? (
              <p className="text-[13px] text-muted">
                The phone must be on the same Wi-Fi. Installing it as an app needs HTTPS: turn on remote mode with <code className="font-mono">setup</code>.
              </p>
            ) : (
              <p className="text-[13px] text-muted">
                To use it as an app: on iPhone, Share → “Add to Home Screen”; on Android, menu → “Install app”.
              </p>
            )}
          </>
        ) : (
          <p className="text-[15px] text-muted">
            {target.reason === "local"
              ? "Right now Herdr Web only accepts connections from this computer, so your phone couldn't open it. Run the Herdr setup action and choose Wi-Fi (home) or remote mode."
              : "No public address is configured. Run the Herdr setup action to set one."}
          </p>
        )}
      </div>
    </div>
  );
}

/** QR as SVG squares (no innerHTML, so the page's CSP and React stay happy) */
function Qr({ text, size }: { text: string; size: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark: string[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push(`M${c} ${r}h1v1h-1z`);
    return { n, d: dark.join("") };
  }, [text]);
  return (
    <svg role="img" aria-label={`QR code for ${text}`} width={size} height={size} viewBox={`0 0 ${cells.n} ${cells.n}`} shapeRendering="crispEdges">
      <path d={cells.d} fill="#16161a" />
    </svg>
  );
}
