#!/usr/bin/env sh
# One-command installer for agy-cmd (supports both `curl -fsSL .../install.sh | sh` and local repo runs)
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 20 is required. Install Node.js first: https://nodejs.org/" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PY_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PY_BIN="python"
else
  echo "Error: Python 3 is required to configure agy-cmd." >&2
  exit 1
fi

SCRIPT_DIR=""
case "${0:-}" in
  */*)
    if [ -f "$0" ]; then
      SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    fi
    ;;
esac

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skills/agy-cmd/scripts/setup_auto_router.py" ]; then
  exec "$PY_BIN" "$SCRIPT_DIR/skills/agy-cmd/scripts/setup_auto_router.py" --install "$@"
fi

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'agy-cmd-install')"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

REPO_DIR="$TMP_DIR/repo"
if command -v git >/dev/null 2>&1; then
  echo "[agy-cmd] Fetching latest release from GitHub..."
  git clone --depth 1 --quiet "https://github.com/zou172866/Antigravity-agy-cmd.git" "$REPO_DIR"
elif command -v curl >/dev/null 2>&1; then
  echo "[agy-cmd] Downloading archive from GitHub..."
  mkdir -p "$REPO_DIR"
  curl -fsSL "https://github.com/zou172866/Antigravity-agy-cmd/archive/refs/heads/main.tar.gz" | tar -xz --strip-components=1 -C "$REPO_DIR"
elif command -v wget >/dev/null 2>&1; then
  echo "[agy-cmd] Downloading archive from GitHub..."
  mkdir -p "$REPO_DIR"
  wget -qO- "https://github.com/zou172866/Antigravity-agy-cmd/archive/refs/heads/main.tar.gz" | tar -xz --strip-components=1 -C "$REPO_DIR"
elif command -v tar >/dev/null 2>&1; then
  echo "[agy-cmd] Downloading archive from GitHub via Node.js..."
  mkdir -p "$REPO_DIR"
  node -e 'fetch("https://github.com/zou172866/Antigravity-agy-cmd/archive/refs/heads/main.tar.gz").then(r=>{if(!r.ok)process.exit(1);return r.arrayBuffer()}).then(b=>process.stdout.write(Buffer.from(b))).catch(()=>process.exit(1))' | tar -xz --strip-components=1 -C "$REPO_DIR"
else
  echo "Error: git, curl, wget, or tar is required for remote installation." >&2
  exit 1
fi

"$PY_BIN" "$REPO_DIR/skills/agy-cmd/scripts/setup_auto_router.py" --install "$@"
