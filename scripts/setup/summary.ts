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
  const lines: string[] = ["", "Listo.", "", `URL: ${s.url}`, "", qrAscii(s.url), ""];
  if (s.mode === "local") {
    lines.push(
      "Solo este equipo:",
      "  1. Abre la URL en el navegador de este equipo.",
      "  2. Entra con tu contraseña.",
      "  No es accesible desde el celular ni desde otros equipos.",
    );
  } else if (s.mode === "lan") {
    lines.push(
      "En el celular:",
      "  1. Conéctalo al mismo Wi-Fi que este equipo.",
      "  2. Escanea el QR (o escribe la URL) y entra con tu contraseña.",
      "",
      "Limitaciones de este modo (sin HTTPS):",
      "  - sin app instalable",
      "  - sin push",
      "  - sin passkeys",
      "  - la contraseña viaja en claro dentro de la red",
      "",
      "Si cambia la IP de este equipo, vuelve a ejecutar la configuración.",
    );
  } else {
    lines.push(
      `Túnel: ${s.tunnel ? TUNNEL_NAME[s.tunnel] : "-"} (HTTPS)`,
      "",
      "En el celular:",
      "  1. Escanea el QR (o escribe la URL) desde cualquier red.",
      "  2. Entra con tu contraseña.",
      "  3. Opcional: \"Añadir a pantalla de inicio\" en el menú del navegador.",
      "",
      "Sugerencia (no se aplica sola): si este equipo es un servidor con ufw, cierra los puertos entrantes",
      "salvo SSH; el túnel no necesita ninguno abierto:",
      "  sudo ufw default deny incoming && sudo ufw allow 22",
    );
  }
  const service = s.serviceKind === "launchd" ? "LaunchAgent de macOS" : "servicio systemd de usuario";
  lines.push("", `El servidor corre como ${service} y arranca solo tras un reinicio.`, `Registro: ${s.logFile}`, "");
  return lines.join("\n");
}
