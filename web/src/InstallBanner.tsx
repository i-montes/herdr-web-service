import { useState } from "react";
import { Icon } from "./Home.tsx";
import { useInstallOffer } from "./install.ts";

/** "Instala Herdr": the native install dialog where the browser allows it, instructions on iOS */
export function InstallBanner() {
  const { offer, dismiss } = useInstallOffer();
  const [busy, setBusy] = useState(false);
  if (!offer) return null;

  return (
    <aside
      role="dialog"
      aria-labelledby="install-title"
      className="fixed inset-x-4 bottom-[calc(96px+env(safe-area-inset-bottom))] z-30 flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-dialog lg:inset-x-auto lg:right-6 lg:bottom-6 lg:w-[380px]"
    >
      <div className="flex items-start gap-3">
        <img src="/icon-192.png" alt="" width={44} height={44} className="size-11 shrink-0 rounded-xl" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="install-title" className="text-[17px] font-bold">Instala Herdr</h2>
          {offer.kind === "native" ? (
            <p className="text-sm text-muted">Ábrela como una app desde tu pantalla de inicio o tu escritorio, sin la barra del navegador.</p>
          ) : (
            <p className="text-sm text-muted">
              En Safari toca <Icon d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" size={15} className="inline-block align-[-2px] text-accent-ink" /> Compartir y luego «Añadir a pantalla de inicio».
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={dismiss} className="min-h-10 cursor-pointer rounded-full px-4 text-sm font-semibold text-muted hover:text-ink">
          {offer.kind === "native" ? "Ahora no" : "Entendido"}
        </button>
        {offer.kind === "native" && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await offer.install();
              } finally {
                setBusy(false);
              }
            }}
            className="min-h-10 cursor-pointer rounded-full bg-accent px-5 text-sm font-semibold text-white disabled:opacity-70"
          >
            Instalar
          </button>
        )}
      </div>
    </aside>
  );
}
