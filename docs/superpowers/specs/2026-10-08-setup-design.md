# Setup del plugin: diseño

Fecha: 2026-10-08. Estado: aprobado en conversación.

## Objetivo

Que un usuario instale el plugin con `herdr plugin install` y, tras una sola acción de setup
dentro de Herdr, tenga el cliente web accesible desde su celular con contraseña y HTTPS, sin
editar archivos, sin abrir puertos, sin VPN en el teléfono, y sin volver a tocar nada tras un
reinicio.

## Decisiones ya tomadas

- Sin dominio propio ni DNS del usuario. Sin Caddy ni ningún proxy que compita con un nginx
  existente. El acceso remoto se resuelve con un túnel que sale desde la máquina.
- Túneles: **Tailscale Funnel** por defecto (URL estable `https://<máquina>.<tailnet>.ts.net`,
  certificado real, TLS termina en la máquina, el teléfono no instala nada). **Portal**
  (`gosuda/portal-tunnel`) como alternativa sin cuenta ni sudo, con TLS de extremo a extremo.
- Firewall: solo una sugerencia impresa al final, nunca se aplica.
- Contraseña: mínimo 6 caracteres, un signo, un número y una mayúscula. Se fija solo desde el
  host (popup de Herdr o terminal), nunca por HTTP. Prompt sin eco con indicadores en vivo.
- La misma seguridad en todos los modos: nunca "en casa no hace falta contraseña".
- Push y passkeys quedan **fuera de este spec**: cada uno tendrá el suyo. El setup no genera
  llaves VAPID hasta que exista la función de push.

## Modos de acceso

| Modo | Clave `ACCESS_MODE` | Escucha | URL canónica | HTTPS |
|---|---|---|---|---|
| Solo este equipo | `local` | `127.0.0.1` | `http://localhost:<port>` | No hace falta |
| En casa por Wi-Fi | `lan` | IP de la LAN detectada | `http://<ip>:<port>` | No disponible. El resumen avisa: sin app instalable, sin push, sin passkeys, contraseña en claro dentro de la red |
| Desde cualquier sitio | `remote` | `127.0.0.1` | La del túnel | Sí, por el túnel |

## Pasos del setup

Se ejecuta con `bun scripts/plugin.ts setup` (la acción `Web: setup` lo abre en un popup de
Herdr). Requiere TTY. Cada paso es idempotente: detecta lo hecho y lo salta o repara.

| # | Paso | Hace | Pregunta | Sudo | local | lan | remote |
|---|---|---|---|---|---|---|---|
| 0 | Preflight | Herdr ≥ 0.9.0, Bun ≥ 1.3, `dist/index.html`, `ping` al socket. Si falla, mensaje y salida 1 | — | No | ✓ | ✓ | ✓ |
| 1 | Modo | Menú numerado de tres opciones; preselecciona el `ACCESS_MODE` guardado | Modo | No | ✓ | ✓ | ✓ |
| 2 | Contraseña | Como ya está implementado. Si existe, pregunta "¿Cambiarla? [s/N]" | Contraseña | No | ✓ | ✓ | ✓ |
| 3 | Túnel | Menú Tailscale/Portal. Instala el cliente si falta, guía login y habilitación, publica `127.0.0.1:<port>`, obtiene la URL | Proveedor, abrir links | Tailscale en Linux sí; Portal no | – | – | ✓ |
| 4 | URL canónica | Según modo. Guarda `PUBLIC_URL`. Si cambia respecto a la guardada, avisa de que invalida passkeys y push y pide confirmar | Confirmar | No | ✓ | ✓ | ✓ |
| 5 | Escucha | Escribe `HOST`, `PORT`, `ACCESS_MODE`, `TUNNEL` en `.env` | — | No | ✓ | ✓ | ✓ |
| 6 | Servicio | Unidad `systemd --user` (Linux, con `loginctl enable-linger`) o LaunchAgent (macOS) para el servidor; otra para Portal si aplica | — | No (si `enable-linger` falla, imprime el comando con sudo) | ✓ | ✓ | ✓ |
| 7 | Reinicio | Reinicia el servicio (o el proceso suelto si no hay servicio) | — | No | ✓ | ✓ | ✓ |
| 8 | Verificación | `GET <PUBLIC_URL>/api/health` desde la máquina, 10 s, certificado validado. Si falla: motivo, ruta del log y "¿Reintentar? [S/n]" | Reintentar | No | ✓ | ✓ | ✓ |
| 9 | Resumen | URL, QR ASCII, pasos en el celular, limitaciones del modo, sugerencia de firewall (`sudo ufw default deny incoming && sudo ufw allow 22`), Enter para cerrar | Enter | No | ✓ | ✓ | ✓ |

### Paso 3 en detalle

**Tailscale**
1. `tailscale version` falla → Linux: `curl -fsSL https://tailscale.com/install.sh | sh`
   (el script pide sudo; se explica antes). macOS: imprime instrucciones de instalar la app
   y para.
2. `tailscale status --json` → `BackendState`. Si `NeedsLogin`: `sudo tailscale up` con la
   terminal heredada para que el usuario abra el link. Luego `sudo tailscale set
   --operator=$USER` para que los pasos siguientes no pidan sudo.
3. `tailscale funnel --bg <port>`. Si la salida contiene un link de habilitación (Funnel no
   activo en el tailnet o HTTPS no habilitado), se muestra y se pide Enter para reintentar.
4. URL = `https://` + `Self.DNSName` sin el punto final. Se guarda `TUNNEL=tailscale`.
5. Deshacer: `tailscale funnel --bg <port> off`.

**Portal**
1. `portal` ausente → `curl -fsSL https://github.com/gosuda/portal-tunnel/releases/latest/download/install.sh | bash` (instala en el usuario, sin sudo).
2. Nombre: `herdr-<hostname corto>` salvo que el usuario escriba otro. Comando persistente:
   `portal expose --name <name> --http-route /=http://127.0.0.1:<port> --discovery=false`.
   La identidad queda en el archivo que Portal crea en el home; la URL es estable mientras
   exista.
3. Se arranca una vez en primer plano hasta leer `service ready at https://…`, se captura la
   URL, se para, y el paso 6 lo deja como servicio. `TUNNEL=portal`.
4. Deshacer: parar y borrar la unidad del túnel.

## Endurecimiento del servidor (requisito previo al modo remote)

| Id | Regla |
|---|---|
| H1 | `X-Forwarded-For` y `X-Forwarded-Proto` solo se creen cuando el peer TCP es loopback |
| H2 | Login: en `remote` solo por HTTPS (`isSecure`); en `local` solo desde loopback; en `lan` se permite HTTP. Si no, 403 `insecure_transport` |
| H3 | `Host` debe ser el de `PUBLIC_URL`, o `localhost`/`127.0.0.1`/`[::1]` con cualquier puerto, o en `lan` la IP de `HOST`. Si no, 421 `invalid_host` |
| H4 | `Origin`, cuando viene, se compara como origen exacto (esquema, host y puerto) contra: el origen de `PUBLIC_URL`; `http://localhost:<PORT>`, `http://127.0.0.1:<PORT>`, `http://[::1]:<PORT>`; en `lan`, `http://<HOST>:<PORT>`; y el valor de `DEV_ORIGIN` si está definido (lo fija `bun run dev` para Vite). Aplica a toda petición que no sea GET/HEAD y al upgrade de `/ws`; en `/ws` es obligatorio. Si no, 403 `invalid_origin`. (Otro puerto de `localhost` es el mismo *site* para la cookie `SameSite=Strict`, por eso el puerto cuenta.) |
| H5 | `sessions.json` guarda SHA-256 del id; la cookie lleva el id. Leer el archivo no sirve para entrar |
| H6 | Límite de login: IPv6 agrupado por `/64`; además una ventana global de 50 fallos en 10 min que frena a toda dirección no admitida (una dirección admitida es la que presentó la contraseña correcta en los últimos 30 días) |
| H7 | `/api/session` sin sesión devuelve solo `authenticated` y `setup_required`; `herdr.connected` solo con sesión |
| H8 | Cabeceras: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; en HTTPS `Strict-Transport-Security: max-age=31536000` |
| H9 | Sesión: 30 días inactiva, 180 días absoluta |

## Servicio persistente

- Linux: `~/.config/systemd/user/herdr-web-service.service` (`Restart=on-failure`,
  `WorkingDirectory=<plugin root>`, `ExecStart=<bun> server/index.ts`, env
  `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_SOCKET_PATH`), `systemctl --user
  daemon-reload && enable --now`, `loginctl enable-linger`. Portal: `herdr-web-service-tunnel.service`.
- macOS: `~/Library/LaunchAgents/dev.herdr-web-service.plist` con `KeepAlive` y `RunAtLoad`,
  cargado con `launchctl bootstrap gui/$UID`.
- `plugin.ts start|stop|status` detectan si hay unidad instalada y la usan; si no, el proceso
  suelto de hoy. El hook `[[startup]]` de Herdr sigue llamando a `start`, que no hace nada si
  el servicio ya responde.

## Acción `uninstall`

Nueva acción del manifiesto: para el servicio y el túnel, borra las unidades, apaga Funnel.
Conserva `auth.json` y `.env`. No desinstala Tailscale ni Portal.

## Fuera de alcance

Push (VAPID, suscripciones), passkeys, Windows, instalación sin TTY del setup completo (solo
`set-password` acepta tubería).
