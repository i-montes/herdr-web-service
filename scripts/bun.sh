#!/bin/sh
# Runs Bun for the manifest commands. Herdr spawns them with its server's PATH, which often lacks
# ~/.bun/bin: the Bun installer only adds it to the shell rc files.
for bin in "$(command -v bun 2>/dev/null)" "${BUN_INSTALL:-$HOME/.bun}/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -n "$bin" ] && [ -x "$bin" ]; then exec "$bin" "$@"; fi
done
echo "No encuentro Bun: instálalo con 'curl -fsSL https://bun.sh/install | bash'." >&2
exit 127
