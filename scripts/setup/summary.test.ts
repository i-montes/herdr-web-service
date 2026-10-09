import { describe, expect, test } from "bun:test";
import { qrAscii, renderSummary } from "./summary.ts";

const base = { logFile: "/st/server.log", serviceKind: "launchd" as const };

describe("renderSummary", () => {
  test("lan lists its limitations and no firewall hint", () => {
    const s = renderSummary({ ...base, mode: "lan", url: "http://192.168.1.20:7340" });
    expect(s).toContain("http://192.168.1.20:7340");
    expect(s).toContain("sin push");
    expect(s).toContain("sin passkeys");
    expect(s).not.toContain("ufw");
    expect(s).toContain("Si cambia la IP de este equipo, vuelve a ejecutar la configuración.");
  });
  test("remote suggests the firewall and names the tunnel", () => {
    const s = renderSummary({ ...base, mode: "remote", url: "https://m.t.ts.net", tunnel: "tailscale" });
    expect(s).toContain("sudo ufw default deny incoming && sudo ufw allow 22");
    expect(s).toContain("Tailscale");
  });
  test("local shows the URL, the QR and no firewall hint", () => {
    const s = renderSummary({ ...base, mode: "local", url: "http://localhost:7340" });
    expect(s).toContain("http://localhost:7340");
    expect(s).toContain(qrAscii("http://localhost:7340"));
    expect(s).not.toContain("ufw");
    expect(s).toContain("/st/server.log");
  });
});

describe("qrAscii", () => {
  test("is a square block of text", () => {
    const lines = qrAscii("https://x").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
  });
});
