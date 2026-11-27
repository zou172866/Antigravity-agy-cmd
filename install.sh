#!/usr/bin/env sh
# Pinned-release, SHA-256-verified POSIX installer for agy-cmd.
# Supports:
#   - Pinned remote release install:
#       curl -fsSL https://raw.githubusercontent.com/zou172866/Antigravity-agy-cmd/v2.7.6/install.sh | sh
#   - Local checkout / extracted archive install:
#       sh ./install.sh
#   - Offline SHA-256-verified ZIP install:
#       sh ./install.sh --archive ./agy-cmd-v2.7.6.zip --checksums ./SHA256SUMS.txt
set -eu

DEFAULT_VERSION="v2.7.6"
RELEASE_DOWNLOAD_BASE="https://github.com/zou172866/Antigravity-agy-cmd/releases/download"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 20 is required. Install Node.js first: https://nodejs.org/" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  PY_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PY_BIN="python"
else
  echo "Error: Python 3.8+ is required to configure agy-cmd." >&2
  exit 1
fi

TARGET_VERSION="${AGY_CMD_VERSION:-}"
ARCHIVE_PATH=""
CHECKSUMS_PATH=""
EXPLICIT_SHA256=""

# Separate installer-specific options while preserving all remaining arguments for setup_auto_router.py
ORIG_COUNT="$#"
IDX=0
while [ "$IDX" -lt "$ORIG_COUNT" ]; do
  ARG="$1"
  shift
  IDX=$((IDX + 1))
  case "$ARG" in
    --version)
      if [ "$IDX" -ge "$ORIG_COUNT" ]; then
        echo "Error: --version requires a SemVer release tag (e.g. $DEFAULT_VERSION)." >&2
        exit 1
      fi
      TARGET_VERSION="$1"
      shift
      IDX=$((IDX + 1))
      ;;
    --archive)
      if [ "$IDX" -ge "$ORIG_COUNT" ]; then
        echo "Error: --archive requires a ZIP file path." >&2
        exit 1
      fi
      ARCHIVE_PATH="$1"
      shift
      IDX=$((IDX + 1))
      ;;
    --checksums)
      if [ "$IDX" -ge "$ORIG_COUNT" ]; then
        echo "Error: --checksums requires a SHA256SUMS.txt file path." >&2
        exit 1
      fi
      CHECKSUMS_PATH="$1"
      shift
      IDX=$((IDX + 1))
      ;;
    --sha256)
      if [ "$IDX" -ge "$ORIG_COUNT" ]; then
        echo "Error: --sha256 requires a 64-character hex digest." >&2
        exit 1
      fi
      EXPLICIT_SHA256="$1"
      shift
      IDX=$((IDX + 1))
      ;;
    *)
      set -- "$@" "$ARG"
      ;;
  esac
done

SCRIPT_DIR=""
case "${0:-}" in
  */*)
    if [ -f "$0" ]; then
      SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    fi
    ;;
esac

if [ -z "$ARCHIVE_PATH" ] && [ -z "$TARGET_VERSION" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skills/agy-cmd/scripts/setup_auto_router.py" ]; then
  exec "$PY_BIN" "$SCRIPT_DIR/skills/agy-cmd/scripts/setup_auto_router.py" --install "$@"
fi

download_file() {
  URL="$1"
  OUT="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto '=https' --tlsv1.2 "$URL" -o "$OUT"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$OUT" --https-only "$URL"
  else
    node -e 'const fs=require("node:fs");fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1);return r.arrayBuffer()}).then(b=>fs.writeFileSync(process.argv[2],Buffer.from(b))).catch(()=>process.exit(1))' "$URL" "$OUT"
  fi
}

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'agy-cmd-install')"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if [ -n "$ARCHIVE_PATH" ]; then
  if [ ! -f "$ARCHIVE_PATH" ]; then
    echo "Error: Archive file not found: $ARCHIVE_PATH" >&2
    exit 1
  fi
  if [ -z "$CHECKSUMS_PATH" ] && [ -z "$EXPLICIT_SHA256" ]; then
    echo "Error: Offline archive install requires --checksums <SHA256SUMS.txt> or --sha256 <64-hex>." >&2
    exit 1
  fi
  ZIP_FILE="$ARCHIVE_PATH"
  SUMS_FILE="$CHECKSUMS_PATH"
else
  RAW_VER="${TARGET_VERSION:-$DEFAULT_VERSION}"
  TAG="$("$PY_BIN" -c 'import re, sys; raw = sys.argv[1].strip(); m = re.match(r"^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$", raw); print(("v" + raw.lstrip("v")) if m else "")' "$RAW_VER")"
  if [ -z "$TAG" ]; then
    echo "Error: Invalid release version '$RAW_VER'. Expected a SemVer release tag such as '$DEFAULT_VERSION' (mutable branches like 'main' are not allowed)." >&2
    exit 1
  fi
  ASSET_NAME="agy-cmd-${TAG}.zip"
  ZIP_FILE="$TMP_DIR/$ASSET_NAME"
  SUMS_FILE="$TMP_DIR/SHA256SUMS.txt"
  echo "[agy-cmd] Downloading release $TAG ($ASSET_NAME) and SHA256SUMS.txt..."
  download_file "$RELEASE_DOWNLOAD_BASE/$TAG/SHA256SUMS.txt" "$SUMS_FILE"
  download_file "$RELEASE_DOWNLOAD_BASE/$TAG/$ASSET_NAME" "$ZIP_FILE"
fi

UNPACK_DIR="$TMP_DIR/unpacked"
mkdir -p "$UNPACK_DIR"

SETUP_SCRIPT="$("$PY_BIN" - "$ZIP_FILE" "$SUMS_FILE" "$EXPLICIT_SHA256" "$UNPACK_DIR" <<'PY'
import hashlib, hmac, os, pathlib, re, stat, sys, zipfile

zip_path = pathlib.Path(sys.argv[1])
sums_path = pathlib.Path(sys.argv[2]) if sys.argv[2] else None
explicit_sha = sys.argv[3].strip().lower()
out_dir = pathlib.Path(sys.argv[4]).resolve()
asset_name = zip_path.name

if explicit_sha:
    if not re.match(r"^[0-9a-f]{64}$", explicit_sha):
        raise SystemExit("Error: Invalid --sha256 digest: expected 64 hex characters.")
    expected = explicit_sha
else:
    if not sums_path or not sums_path.is_file():
        raise SystemExit(f"Error: Checksums file not found: {sums_path}")
    found = set()
    for line in sums_path.read_text(encoding="utf-8", errors="replace").splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        m = re.match(r"^([0-9a-fA-F]{64})\s+\*?(.+)$", trimmed)
        if m and os.path.basename(m.group(2).strip()) == asset_name:
            found.add(m.group(1).lower())
    if len(found) != 1:
        raise SystemExit(f"Error: Could not find a unique SHA-256 entry for '{asset_name}' in {sums_path}.")
    expected = next(iter(found))

h = hashlib.sha256()
with open(zip_path, "rb") as fh:
    while True:
        chunk = fh.read(65536)
        if not chunk:
            break
        h.update(chunk)
actual = h.hexdigest().lower()
if not hmac.compare_digest(actual, expected):
    raise SystemExit(
        f"Error: SHA-256 verification failed for {asset_name}! Expected {expected}, got {actual}. Aborting without unpacking."
    )
print(f"[agy-cmd] SHA-256 verified ({actual}).", file=sys.stderr)

with zipfile.ZipFile(zip_path, "r") as zf:
    infos = zf.infolist()
    if len(infos) > 2000:
        raise SystemExit("Error: Too many entries in archive.")
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if name.startswith("/") or name.startswith("../") or "/../" in name or name == "..":
            raise SystemExit(f"Error: Unsafe archive path: {info.filename}")
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            raise SystemExit(f"Error: Symlink entry not allowed: {info.filename}")
        total += info.file_size
        if total > 64 * 1024 * 1024:
            raise SystemExit("Error: Archive uncompressed size exceeds safety limit.")
        target = (out_dir / name).resolve()
        if target != out_dir and out_dir not in target.parents:
            raise SystemExit(f"Error: Path traversal blocked: {info.filename}")
    zf.extractall(out_dir)

direct = out_dir / "skills" / "agy-cmd" / "scripts" / "setup_auto_router.py"
if direct.is_file():
    print(str(direct))
else:
    subdirs = [p for p in out_dir.iterdir() if p.is_dir()]
    if len(subdirs) == 1:
        nested = subdirs[0] / "skills" / "agy-cmd" / "scripts" / "setup_auto_router.py"
        if nested.is_file():
            print(str(nested))
            sys.exit(0)
    raise SystemExit("Error: Verified archive did not contain skills/agy-cmd/scripts/setup_auto_router.py.")
PY
)"

"$PY_BIN" "$SETUP_SCRIPT" --install "$@"
