/** Step 9: what to open, how, and what the chosen mode cannot do. */
import qrcode from "qrcode-generator";
import type { AccessMode } from "../../server/access.ts";
import type { TunnelKind } from "./tunnel/index.ts";

export function qrAscii(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createASCII(1, 1);
}

export interface Summary {
  mode: AccessMode;
  url: string;
  tunnel?: TunnelKind;
  /** a file, or the command that shows the service log */
  logFile: string;
  serviceKind: "launchd" | "systemd";
}

const TUNNEL_NAME: Record<TunnelKind, string> = { tailscale: "Tailscale Funnel", portal: "Portal" };

export function renderSummary(s: Summary): string {
  const lines: string[] = ["", "Done.", "", `URL: ${s.url}`, "", qrAscii(s.url), ""];
  if (s.mode === "local") {
    lines.push(
      "This machine only:",
      "  1. Open the URL in this machine's browser.",
      "  2. Sign in with your password.",
      "  It cannot be reached from your phone or other machines.",
    );
  } else if (s.mode === "lan") {
    lines.push(
      "On your phone:",
      "  1. Connect it to the same Wi-Fi as this machine.",
      "  2. Scan the QR code (or type the URL) and sign in with your password.",
      "",
      "Limitations of this mode (no HTTPS):",
      "  - no installable app",
      "  - no push notifications",
      "  - no passkeys",
      "  - the password travels unencrypted over the network",
      "",
      "If this machine's IP changes, run setup again.",
    );
  } else {
    lines.push(
      `Tunnel: ${s.tunnel ? TUNNEL_NAME[s.tunnel] : "-"} (HTTPS)`,
      "",
      "On your phone:",
      "  1. Scan the QR code (or type the URL) from any network.",
      "  2. Sign in with your password.",
      "  3. Optional: \"Add to Home Screen\" from the browser menu.",
      "",
      "Suggestion (not applied automatically): if this machine is a server with ufw, close incoming",
      "ports except SSH; the tunnel needs none open:",
      "  sudo ufw default deny incoming && sudo ufw allow 22",
    );
  }
  const service = s.serviceKind === "launchd" ? "macOS LaunchAgent" : "systemd user service";
  lines.push("", `The server runs as a ${service} and starts on its own after a reboot.`, `Log: ${s.logFile}`, "");
  return lines.join("\n");
}
