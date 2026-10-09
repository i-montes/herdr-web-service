/** Herdr's roster kept live over /ws, shared by every signed-in screen. */
import { useEffect, useState } from "react";
import type { Roster, ServerFrame } from "../../shared/protocol.ts";
import { api } from "./api.ts";

/**
 * The live roster. The socket reconnects on its own (backoff up to 15 s, at once when the tab
 * becomes visible or the network returns): a phone suspends tabs and Wi-Fi drops, and a page
 * that silently stopped updating is worse than one that says it is reconnecting.
 */
export function useRoster(initiallyConnected: boolean): { roster: Roster; connected: boolean; loaded: boolean; live: boolean } {
  const [roster, setRoster] = useState<Roster>({ workspaces: [], panes: [] });
  const [connected, setConnected] = useState(initiallyConnected);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(true);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    let stopped = false;

    const load = () =>
      api.roster().then((r) => {
        setRoster(r);
        setLoaded(true);
      }).catch(() => setConnected(false));

    const connect = () => {
      clearTimeout(retry);
      if (stopped || (ws && ws.readyState <= WebSocket.OPEN)) return;
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${location.host}/ws`);
      ws = socket;
      socket.onopen = () => {
        delay = 1000;
        setLive(true);
        void load();
      };
      socket.onmessage = (event) => {
        const frame = JSON.parse(event.data) as ServerFrame;
        if (frame.type === "roster") {
          setRoster(frame.roster);
          setLoaded(true);
          setConnected(true);
        } else if (frame.type === "herdr") setConnected(frame.connected);
      };
      socket.onclose = (event) => {
        if (ws !== socket || stopped) return;
        ws = null;
        setLive(false);
        // 1008: the server ended this sign-in; reload to show the password page
        if (event.code === 1008) {
          location.reload();
          return;
        }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15_000);
      };
    };

    const wake = () => {
      if (document.visibilityState === "visible") {
        delay = 1000;
        connect();
      }
    };

    void load();
    connect();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    return () => {
      stopped = true;
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      ws?.close();
    };
  }, []);

  return { roster, connected, loaded, live };
}

/** hash routes: `#/` is Inicio, `#/sesion/<pane id>` a session */
export function useRoute(): { paneId: string | null; go: (paneId: string | null) => void } {
  const read = () => {
    const m = /^#\/sesion\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]!) : null;
  };
  const [paneId, setPaneId] = useState(read);
  useEffect(() => {
    const onHash = () => setPaneId(read());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (id: string | null) => {
    location.hash = id ? `#/sesion/${encodeURIComponent(id)}` : "#/";
  };
  return { paneId, go };
}

export const sessionHref = (paneId: string) => `#/sesion/${encodeURIComponent(paneId)}`;
