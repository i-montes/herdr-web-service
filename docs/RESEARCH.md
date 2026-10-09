# Investigación: clientes web para Herdr (2026-10-08)

Objetivo del plugin: UI tipo chat (no un espejo de terminal), con login real y HTTPS,
instalable en un VPS público con un solo comando y sin pasos manuales después.

## Resumen del panorama

Casi todos los plugins web existentes comparten el mismo modelo de seguridad:
**escuchan solo en loopback y delegan la autenticación a Tailscale** (`tailscale serve`).
Ninguno está diseñado para un VPS expuesto a internet con dominio propio. Los que tienen
alguna forma de auth la tratan como opcional o secundaria.

| Repo | ★ | UI | Auth propia | Expuesto a internet | Stack | Notas |
|---|---|---|---|---|---|---|
| AltanS/collie | 1261 | Chat (transcript) + terminal, PWA | Pairing de dispositivo (token por request) | No: "never funnel" | Bun + React Router + shadcn | Asume tailnet. systemd --user. Fork base de setnet y sightr |
| devswha/herdr-web-ui | 661 | Chat por turnos + terminal xterm, PWA | Token compartido opcional (`HERDR_WEB_TOKEN`) + pairing con código de 6 dígitos | Sí, con proxy manual (Caddy/nginx) + token | Bun + Vite + React + node-pty | El más completo. Lee transcripts JSONL de Claude/Codex/etc. Backoff en login. Setup de VPS es manual |
| 0cv/herdr-mobile-relay | 287 | App móvil | Token de dispositivo de un solo uso (QR) | Vía relay (Cloudflare tunnel / gateway propio) | Go | Arquitectura relay, no servidor directo |
| powerfooI/roamgate | 282 | Terminal + archivos/diffs | Ninguna ("no token or password") | No | Bun | Solo loopback |
| lamngockhuong/termote | 58 | Terminal xterm + chat para Claude | **Basic Auth** con password cifrada, servicio systemd | Sí, pensado como servicio | Go binario único + React | No es plugin herdr primero; herdr es un backend opcional |
| frizynn/nenu | 1 | Workbench web | Autorización de escritura por dispositivo | No | Bun | Tailscale |
| afloury/wherdr | 1 | Chat + terminal, PWA | Passkey (WebAuthn) como "lock" | No: "never expose" | Nuxt 4 | Passkey ligado a la dirección |
| zlxlabs/herdweb | 5 | Espejo TUI | Ninguna | No | Node | Fork de remobi |
| barnuri/herdr-web | 12 | Espejo TUI xterm, PWA | Ninguna | No | Node + xterm | HTTPS autofirmado |
| mttzzz/herdr-web | 1 | Espejo TUI 1:1 | Token en cookie HttpOnly | Puede (HOST=0.0.0.0) | Bun + PTY | Buen patrón de token/estado, pero es terminal |
| Orchard-Robotics/herdview | 1 | Espejo móvil | Token de pairing + cookie, allowlist de Host/Origin | Puede | Go | Buen diseño anti DNS-rebinding |
| spad-0x/herdr-mobile-pro | 3 | Dashboard "cyber-dark" | Password SHA-256+salt, HTTPS con CA propia | LAN | Python sin deps | Prueba de concepto |
| JefeLabs/herdr-web-broker | 0 | Sin UI (API + SDK React) | Bearer tokens, multiusuario, admin | Sí | Node | Útil como referencia de API; no es cliente |
| tigorlazuardi/herdr-web-tui | 2 | Espejo TUI | Ninguna por diseño (delega al gateway) | Con proxy autenticado | Go + Nix | |
| dibin666/herdr-remote | 3 | Chat/keybar móvil | Código de pairing de 6 chars + tokens por workstation + relays | Vía relay | Node (npm) | Sin manifiesto de plugin en root |
| lab486/herdr-watcher | 0 | Dashboard | Ninguna | No | Node + React | SSE + polling snapshot |

## Qué aprender de cada uno

- **devswha/herdr-web-ui**: referencia principal. Cómo obtiene el chat: lee el transcript del
  propio agente (Claude Code: `~/.claude/projects/<cwd codificado>/<session>.jsonl`, la sesión la
  reporta Herdr en `agent_session`). Terminal: `herdr terminal attach <terminal_id>` dentro de un
  PTY (`@lydell/node-pty`) → xterm.js; fallback por `pane.read` cuando no hay attach. Daemon:
  spawn detached + pid file desde el hook `[[startup]]`. Auth: `server/auth.ts` (constant-time,
  cookie HttpOnly+Strict+Secure, backoff por IP y por proxy).
- **collie**: `systemd --user` para que el bridge sobreviva reinicios de Herdr; acciones
  `update`/`uninstall` dentro del manifiesto; VAPID para push como acción.
- **termote**: la única con instalación como servicio y password desde el instalador
  (`termote start` registra systemd/launchd y guarda la password cifrada). Es el flujo de
  instalación que queremos, pero en Go y centrado en terminal.
- **herdview / mttzzz**: validación de `Host`/`Origin` contra DNS rebinding; token en archivo 600.
- **wherdr**: passkeys (WebAuthn) como segundo factor opcional, más cómodo que TOTP en móvil.

## Decisiones para este plugin

1. **Auth propia, obligatoria**: password única (argon2id vía `Bun.password`), sesión en cookie
   HttpOnly/Strict/Secure, backoff por IP. El servidor **no acepta nada** hasta que exista
   password; la password solo se fija desde el host (acción `setup` o `set-password`), nunca por
   HTTP. Segundo factor (passkey/TOTP) después.
2. **HTTPS por túnel, sin dominio propio ni Caddy**: Tailscale Funnel por defecto (URL estable,
   certificado real, cuenta de Tailscale; en Linux puede pedir `sudo` para instalar Tailscale y para `tailscale up`/`set --operator`; en macOS se instala la app) y Portal como
   alternativa (sin cuenta ni sudo). El servidor Bun queda en loopback (o en la IP de la LAN en
   modo red local) y el túnel hace de front; no se abre ningún puerto entrante.
3. **Servicio persistente de usuario**: unidad `systemd --user` (Linux, con `linger`) /
   LaunchAgent (macOS) escrita por el plugin, más una segunda unidad para Portal; además del hook
   `[[startup]]` de Herdr. Los servicios no requieren root.
4. **UI chat primero**: transcript por agente (Claude Code JSONL, luego Codex), tarjetas para
   aprobaciones/preguntas (`blocked`), composer para `agent.prompt`. Terminal xterm como vista
   secundaria vía `herdr terminal attach` en PTY.
5. **Tiempo real**: una suscripción `events.subscribe` en el servidor, fan-out por WebSocket.
6. **Stack**: Bun 1.3+, `Bun.serve` (HTTP+WS nativo), Vite + React 19 + Tailwind 4 (shadcn
   cuando haga falta), TypeScript estricto. Sin Node.

## Referencias

- Docs Herdr 0.9.3: plugins, socket API y esquema JSON (`herdr api schema --json`).
- Eventos útiles: `pane.agent_status_changed`, `pane.agent_detected`, `pane.updated`,
  `pane.created/closed`, `workspace.*`.
- Métodos clave: `agent.list`, `agent.get`, `agent.read`, `agent.prompt` (con `wait`),
  `agent.send_keys`, `pane.read`, `session.snapshot`, `notification.show`.
