# herdr-web-service

Plugin de Herdr: cliente web tipo chat para los agentes, con login propio y HTTPS, pensado para
un VPS público e instalable con `herdr plugin install` sin pasos manuales.

## Comandos

```
bun install              # deps
bun run dev              # servidor (watch) + Vite con proxy a /api y /ws
bun run build            # web → dist/ (lo sirve el servidor Bun)
bun run typecheck
bun test
bun scripts/plugin.ts start|stop|status|setup|set-password|uninstall|url
```

`bun run dev` arranca el servidor con `DEV_ORIGIN=http://localhost:5173` (el origen de Vite pasa
la política de Origin). `set-password` no recibe argumentos: pide la password sin eco (o lee una
línea de un pipe).

Verbos de `scripts/plugin.ts`: `start` (usa la unidad de servicio si existe; si no, servidor
suelto con pid en el state dir), `stop`, `status`, `setup` (asistente), `set-password`,
`uninstall` (quita túnel, unidades y la status line; conserva `auth.json` y `.env`), `url`.

Para desarrollo, enlázalo desde la carpeta del repo: `herdr plugin link "$PWD"`.
`herdr plugin link` no ejecuta `[[build]]`: tras cambios en `web/` hay que `bun run build`.

## Estructura

- `herdr-plugin.toml` — manifiesto (build, startup, acciones, pane popup `setup`). Sus comandos
  pasan por `scripts/bun.sh`: Herdr los lanza con el PATH de su servidor, que suele no tener
  `~/.bun/bin` (el instalador de Bun solo lo añade al rc de la shell).
- `server/` — `Bun.serve`: `index.ts` (rutas, WS, fan-out), `herdr/client.ts` (NDJSON sobre el
  socket Unix de Herdr), `config.ts` (dirs y `.env` del plugin).
  - `access.ts` — política por petición (funciones puras sobre `RequestFacts`): proxy de
    confianza, Host/Origin, transporte del login, cabeceras de seguridad. No importa `config.ts`.
  - `ws.ts` — selectores puros de los WebSocket abiertos (por sesión, caducados).
  - `fsbrowse.ts` — explorador de carpetas de "Nueva sesión" (`GET /api/fs`), limitado al home.
  - `herdr/roster.ts` — `session.snapshot` → roster (workspaces + paneles) que dibuja la web.
  - `herdr/launch.ts` — crea sesiones (`POST /api/sessions`): pestaña en el workspace de esa
    carpeta o workspace nuevo; arranca shell o agente; el primer mensaje espera a que el agente
    quede `idle` (si no, caería en el aviso de confianza de Claude) y `deliverFirstPrompt` lo
    confirma: el agente avisa `idle` 1–2 s antes de aceptar teclas (OpenCode pierde el texto,
    Claude se queda sin el Enter); sin cambio de `state_change_seq` en 5 s, mira la pantalla y
    reenvía o pulsa Enter. El servidor sigue a Herdr desde que arranca (no solo con un navegador
    conectado), para que ese mensaje salga aunque nadie mire. Permisos por agente
    (`KIND_PERMISSIONS`): Claude `ask|edits|plan|bypass` (`--dangerously-skip-permissions`),
    OpenCode `ask|bypass` (`--auto`), shell y Codex solo `ask`. La web nunca recuerda el bypass.
  - `chat/` — chat de Claude Code (`GET /api/panes/:id/chat?v=`, `POST …/prompt`, `POST …/choose`):
    `store.ts` localiza el transcript (el `agent_session` que reporta la integración de Herdr
    —`herdr integration install claude`, hook `SessionStart`— o, si falta, el JSONL más reciente
    de la carpeta) solo dentro de `~/.claude/projects` y lo lee por incrementos; `transcript.ts`
    lo convierte en mensajes, herramientas, diffs, plan y preguntas, y lleva la cuenta de lo que el
    agente dejó corriendo (`tasks`: subagentes, comandos en background, monitores con su último
    evento): nace con la tool (o con el `agentId`/`backgroundTaskId`/`taskId` de su resultado) y
    acaba con su `<task-notification>` con `<status>` o un `TaskStop`; la web lo muestra en la
    pestaña "N running" sobre el input (`RunningTasks.tsx`). `prompt.ts` lee de la
    pantalla el menú que espera el agente (permisos, preguntas, /model, el deslizador de /effort)
    y lo responde con flechas + Enter. Los comandos de barra se escriben con `pane.send_input`
    (`agent.prompt` los rechaza). `opencode.ts` lee las sesiones de OpenCode de su SQLite
    (`~/.local/share/opencode/opencode.db`, solo lectura); su integración de Herdr reporta el
    `ses_…` de cada panel.
    `usage.ts`: contexto y límites del plan (5 h y semana, con su reinicio) de Claude Code. Los
    entrega a su status line: `scripts/statusline.ts` (lo registra `setup` en `settings.json` →
    `statusLine` de Claude Code) los guarda en `<state dir>/claude-status/<session_id>.json` y pinta
    `ctx 62% · 5h 34% · wk 12%` al pie de la terminal. Si ya había otra status line, `setup` la
    guarda en `<config dir>/claude-statusline.json` y la encadena (se ejecuta con la misma entrada y
    su salida va delante); `uninstall` la restaura.
    `opencode-controls.ts`: modelo y variante (esfuerzo) de OpenCode y su uso (contexto % con el
    catálogo `~/.cache/opencode/models.json`, coste de sesión y de 7 días). Su diálogo de modelos
    no se puede leer (la fila elegida solo se marca con color): la web ofrece los modelos recientes
    y el servidor escribe `/models`, busca el nombre y pulsa Enter; la variante se cambia con
    `ctrl+t` hasta que el pie del prompt la muestra. El modelo y la variante actuales también se leen
    de ese pie (el último mensaje de la base se queda atrás tras un `ctrl+t` y una sesión nueva no
    tiene). Ctrl+C cierra OpenCode: no usarlo.
  - `uploads.ts` — imágenes del chat (`POST /api/uploads`, `GET /api/uploads/<nombre>`): solo PNG,
    JPEG, GIF y WebP reconocidos por sus bytes, hasta 10 MB, nombre aleatorio, en
    `<tmpdir>/herdr-web-uploads` (el sistema la limpia; el servidor borra lo de más de 7 días).
    El mensaje lleva `[image: <ruta>]` y el agente la lee; Claude arranca con `--add-dir` de esa
    carpeta para no pedir permiso.
  - `herdr/panes.ts` — vista de terminal: `GET /api/panes/:id/screen`, `POST …/input` (texto y
    teclas de una lista blanca), `POST …/close`.
  - `notify.ts` — qué cambios del roster merecen aviso (`NoticeWatch`, puro): un panel con agente
    que pasa a `blocked` ("needs you") o deja de trabajar (`working` → `done`/`idle`, "finished").
    El primer roster solo fija la base. `index.ts` (`announce`) manda cada aviso por `/ws`
    (frame `notify`: toast y sonido en la web) y por Web Push a las suscripciones vivas, salvo a la
    del navegador que tiene la web visible (frames `presence`). El cuerpo de un "needs you" es la
    pregunta del menú que espera.
  - `push/` — Web Push sin dependencias: `webpush.ts` (VAPID ES256 y cifrado aes128gcm del
    RFC 8291 sobre WebCrypto; el test reproduce byte a byte el ejemplo del RFC) y `store.ts`
    (claves VAPID en `<config dir>/vapid.json`, suscripciones en `<state dir>/push.json`, ambas
    0600; rutas `GET /api/push/key`, `POST /api/push/subscribe|unsubscribe`). 404/410 del
    servicio push borra la suscripción.
  - `auth/` — `password.ts` (argon2id), `sessions.ts` (sesiones con hash), `ratelimit.ts`
    (límite de login, módulo puro), `login.ts` (`POST /api/auth/login`).
- `web/` — Vite + React 19 + Tailwind 4. Build a `dist/`. Sigue el canvas de Claude Design
  "Herdr Web — Sistema visual": colores como variables en `index.css` (utilidades `bg-canvas`,
  `text-ink`…; claro/oscuro por sistema o `data-theme`, ver `theme.ts`), fuentes servidas en local.
  Pantallas: `Login.tsx`, `Home.tsx` (Inicio), `NewSession.tsx` (diálogo), `SessionView.tsx`
  (terminal; en escritorio la cabecera lleva modelo y esfuerzo, en móvil están en el menú ⋯).
  Rutas por hash: `#/` y `#/session/<pane>` (acepta también el antiguo `#/sesion/`).
  Avisos: `alerts.ts` (sonido silenciado por navegador, compartido entre Inicio y el ⋯ del chat;
  estado y alta/baja de Web Push), `sound.ts` (WebAudio, sin archivos; arranca con el primer toque),
  `Toasts.tsx` (nada para la sesión que tienes delante), `AlertSettings.tsx` (barra de Inicio).
  PWA: `web/public/` (manifiesto, `sw.js` que nunca cachea `/api` ni `/ws` y muestra los push;
  al tocar uno, la ventana abierta cambia de sesión por `postMessage`, iconos). El service
  worker solo se registra en HTTPS o localhost. `OpenOnPhone.tsx`: QR "Abrir en el móvil", solo
  en escritorio, con la URL de `PUBLIC_URL` (en modo local explica que el móvil no llega).
- `shared/protocol.ts` — tipos compartidos servidor/cliente.
- `scripts/plugin.ts` — control (start/stop/status/setup/set-password/url/uninstall); único
  entrypoint de las acciones. `scripts/tui.ts` — prompts de terminal.
- `scripts/setup/` — asistente de `setup`: `wizard.ts` (flujo; todo efecto entra por `WizardDeps`
  para probarlo con fakes), `preflight.ts`, `env.ts` (lee/escribe `.env`), `network.ts` (IP LAN y
  URL canónica), `password.ts`, `service.ts` (unidades `systemd --user` / LaunchAgent: `server`
  y `tunnel`), `statusline.ts` (registra, encadena y restaura la status line de Claude Code),
  `loose.ts` (servidor suelto), `verify.ts` (health), `summary.ts` (URL, QR, límites del modo),
  `uninstall.ts`.
- `scripts/setup/tunnel/` — `index.ts` (`setupTunnel`/`teardownTunnel`/`funnelServes`),
  `tailscale.ts` (Funnel), `portal.ts` (Portal; corre como unidad `tunnel`), `run.ts` (runner de
  procesos inyectable).
- `tests/pty.py` — prueba el asistente en un pty (solo desarrollo).
- `docs/RESEARCH.md` — comparativa de los plugins existentes y decisiones de diseño.

## Reglas

- Solo Bun (nada de Node). TypeScript estricto, `verbatimModuleSyntax`, imports con `.ts`.
- Estado del usuario en `HERDR_PLUGIN_CONFIG_DIR` (`.env`, `auth.json`) y runtime en
  `HERDR_PLUGIN_STATE_DIR` (pid, sesiones, log). Nunca en el root del plugin.
- La password solo se fija desde el host, nunca por HTTP. Todo `/api/*` y `/ws` salvo
  `health`, `session` y `login` exige sesión.
- `.env` (en `HERDR_PLUGIN_CONFIG_DIR`, escrito por `setup`; el entorno del proceso manda):
  `ACCESS_MODE` (`local`|`lan`|`remote`, por defecto `local`), `HOST` (por defecto `127.0.0.1`;
  en `lan` la IP de red), `PORT` (por defecto 7340), `PUBLIC_URL` (URL canónica: cookies, QR,
  Host/Origin permitidos), `TUNNEL` (`tailscale`|`portal`, solo en remote; también marca un Funnel
  a medio configurar), `DEV_ORIGIN` (Origin extra para Vite; lo pone `bun run dev`).
- Reglas de seguridad que aplica el servidor (H1–H9):
  - H1 `X-Forwarded-For/Proto` solo se confían si el peer TCP es loopback.
  - H2 login: remote exige HTTPS, lan acepta HTTP, local solo desde loopback.
  - H3 `Host` debe ser localhost/loopback, el de `PUBLIC_URL` o (lan) el `HOST`.
  - H4 `Origin` presente debe coincidir exacto con uno permitido; exigido en métodos no GET/HEAD y en `/ws`.
  - H5 `sessions.json` guarda solo el SHA-256 del token; la cookie lleva el token.
  - H6 límite de login: 5 fallos libres y backoff 1 s, 2 s, 4 s... hasta 15 min; IPv6 por /64;
    ventana global de 50 fallos en 10 min frena a toda dirección no admitida (admitida = acertó
    la password en los últimos 30 días).
  - H7 `/api/session` sin sesión solo da `authenticated` y `setup_required`; `herdr.connected`
    solo con sesión.
  - H8 CSP, `nosniff`, `Referrer-Policy: no-referrer` en todo; HSTS en HTTPS.
  - H9 sesión: 30 días inactiva, 180 absoluta. Un WebSocket se cierra (1008) al cerrar sesión y,
    cada 60 s, si su sesión ya no vive.
  - H10 push: solo endpoints `https` de servicios push conocidos (FCM, Mozilla, Apple, Windows; sin
    puerto ni credenciales), para que el servidor no haga POST a direcciones arbitrarias. Cada
    suscripción pertenece a la sesión que la creó y muere con ella. El contenido va cifrado de
    extremo a extremo.
- Probar el asistente: `python3 -I tests/pty.py setup <teclas...>` (envía cada tecla con pausa;
  imprime código de salida y la cola de la salida). Usa siempre `HERDR_PLUGIN_CONFIG_DIR` y
  `HERDR_PLUGIN_STATE_DIR` temporales (y un `HOME` temporal si llegara a instalar unidades) para
  no tocar la configuración ni los servicios reales. Los tests unitarios (`bun test`) cubren el
  flujo con fakes.
- Herdr cierra la conexión tras cada respuesta: `HerdrClient.request` abre una por petición.
  `pane.agent_status_changed` exige `pane_id` (no va en la suscripción global) y es el único
  aviso de que un agente terminó o se bloqueó: `pane.updated` no se emite entonces. El servidor
  abre una suscripción por panel con agente (`watchStatuses`); un `pane_id` inexistente cierra la
  suscripción entera con `pane_not_found`.
- Llamadas a Herdr: socket directo para request/response y suscripciones; `HERDR_BIN_PATH` para
  comandos que el CLI envuelve mejor (attach de terminal).
- Textos de UI (web, asistente, CLI) en inglés; código y comentarios también en inglés.
