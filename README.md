# Herdr Web Service

Cliente web para [Herdr](https://herdr.dev): chat con tus agentes desde el navegador o el móvil,
con contraseña propia. Funciona en tu equipo o en un VPS.

## Instalación

```
herdr plugin install i-montes/herdr-web-service
```

Después, dentro de Herdr, ejecuta la acción **Web: setup**. Es un asistente interactivo que
elige el modo de acceso, fija la contraseña, prepara el túnel si hace falta, instala el servicio
y comprueba que responde. Se puede repetir cuando quieras.

## Modos de acceso

| Modo | Para qué | HTTPS | Pide |
|---|---|---|---|
| Solo este equipo | usarlo en la misma máquina | no (`localhost`) | nada |
| Red local (Wi-Fi) | abrirlo desde el celular en casa | no | una IP de la red local |
| Desde cualquier sitio | abrirlo desde cualquier red | sí (túnel) | un túnel, ver abajo |

Las notificaciones push y las passkeys están previstas, todavía no disponibles.

En modo red local la contraseña viaja sin cifrar dentro de la red.

Túneles del modo "desde cualquier sitio":

- **Tailscale Funnel** (recomendado): URL estable y certificado real. Necesita cuenta de Tailscale.
  En Linux el asistente puede usar `sudo` (te lo pide) para instalar Tailscale, para
  `tailscale up` si no has iniciado sesión y para `tailscale set --operator`. En macOS no instala
  Tailscale: instala tú la app. La primera vez puede hacer falta activar Funnel en tu tailnet; el
  asistente muestra el enlace.
- **Portal**: sin cuenta y nunca necesita `sudo`; se instala en tu usuario. La URL la asigna Portal.

No hace falta dominio propio ni abrir puertos.

## En el celular

1. Al terminar, el asistente muestra la URL y un QR.
2. Escanea el QR (en red local, con el celular en el mismo Wi-Fi).
3. Entra con tu contraseña.
4. Opcional: "Añadir a pantalla de inicio" desde el menú del navegador (en modo túnel).

## Firewall

En un servidor con `ufw`, el asistente sugiere cerrar los puertos entrantes salvo SSH, porque el
túnel no necesita ninguno abierto. Nunca lo aplica por su cuenta:

```
sudo ufw default deny incoming && sudo ufw allow 22
```

## Servicio

El servidor corre como servicio de usuario (`systemd --user` en Linux, LaunchAgent en macOS) y
arranca solo tras un reinicio. En Linux el asistente intenta activar `linger`; si falla, te dice
que ejecutes `sudo loginctl enable-linger <usuario>`. En Portal hay un segundo servicio para el
túnel.

Acciones de Herdr: **Web: start server**, **stop**, **status**, **setup** y **uninstall**.

## Desinstalar

La acción **Web: uninstall** apaga Tailscale Funnel (si lo usabas), quita los servicios y para
cualquier servidor suelto. Conserva la contraseña y la configuración, y no desinstala Tailscale
ni Portal.

## Dónde queda todo

- Configuración y contraseña: `~/.config/herdr/plugins/config/imontes.herdr-web-service/` (`.env`, `auth.json`).
- Estado y registro: `~/.local/state/herdr/plugins/imontes.herdr-web-service/` (`sessions.json`, `server.log`).
- Si Herdr define `HERDR_PLUGIN_CONFIG_DIR` y `HERDR_PLUGIN_STATE_DIR`, se usan esas rutas.
- Registro del servicio en Linux: `journalctl --user -u herdr-web-service.service`. En macOS, `server.log`.

Más contexto y decisiones de diseño: `docs/RESEARCH.md`.
