#!/bin/sh
# Runs Bun for the manifest commands. Herdr spawns them with its server's PATH, which often lacks
# ~/.bun/bin: the Bun installer only adds it to the shell rc files. Bun's dir goes first in PATH so
# package scripts (`bun --bun vite`) and other children find it too.
for bin in "$(command -v bun 2>/dev/null)" "${BUN_INSTALL:-$HOME/.bun}/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -n "$bin" ] && [ -x "$bin" ]; then
    PATH="$(dirname "$bin"):$PATH"
    export PATH
    exec "$bin" "$@"
  fi
done
echo "Bun not found: install it with 'curl -fsSL https://bun.sh/install | bash'." >&2
exit 127
