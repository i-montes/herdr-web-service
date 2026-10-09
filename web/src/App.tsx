import { useEffect, useState } from "react";
import type { SessionInfo } from "../../shared/protocol.ts";
import { api } from "./api.ts";
import { Home } from "./Home.tsx";
import { Login } from "./Login.tsx";
import { useRoster, useRoute } from "./roster.ts";
import { SessionView } from "./SessionView.tsx";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.session().then(setSession).catch((e: Error) => setError(e.message));
  useEffect(() => void refresh(), []);

  if (error) return <Centered><p className="text-danger-ink">{error}</p></Centered>;
  if (!session) return <Centered><p className="text-muted">Loading…</p></Centered>;
  if (session.setup_required) {
    return (
      <Centered>
        <h1 className="text-xl font-semibold">Password not set yet</h1>
        <p className="mt-2 max-w-sm text-sm text-muted">In Herdr, run the plugin's <b>Web: setup</b> action (or <code>bun scripts/plugin.ts setup</code>) and reload.</p>
      </Centered>
    );
  }
  if (!session.authenticated) return <Login onDone={refresh} />;
  return <Signed session={session} onLogout={() => api.logout().then(refresh)} />;
}

function Signed({ session, onLogout }: { session: SessionInfo; onLogout: () => void }) {
  const { roster, connected, loaded, live } = useRoster(session.herdr?.connected !== false);
  const { paneId, go } = useRoute();
  if (paneId) return <SessionView key={paneId} paneId={paneId} roster={roster} loaded={loaded} access={session.access} onBack={() => go(null)} />;
  return <Home session={session} roster={roster} connected={connected} live={live} onLogout={onLogout} onCreated={go} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center p-6 text-center">{children}</main>;
}
