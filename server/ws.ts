/**
 * Pure selectors over the open WebSockets. A socket remembers the session hash it was opened
 * with; logout and the periodic sweep in index.ts use these to close sockets whose session is gone.
 */
export interface SessionSocket {
  data: { sessionId: string };
}

/** sockets opened with a session that is no longer alive (revoked or expired) */
export function staleSockets<T extends SessionSocket>(clients: Iterable<T>, isAlive: (idHash: string) => boolean): T[] {
  return [...clients].filter((ws) => !isAlive(ws.data.sessionId));
}

/** every socket opened with the session `idHash` */
export function socketsOfSession<T extends SessionSocket>(clients: Iterable<T>, idHash: string): T[] {
  return [...clients].filter((ws) => ws.data.sessionId === idHash);
}
