#!/bin/sh
# Works on Render's Free and paid instance types, and on any other Docker host.
# Starts as root only to fix ownership of the data dir, then drops privileges.
set -eu

DATA_DIR="${DATA_DIR:-/var/data}"
mkdir -p "$DATA_DIR"
chown -R app:app "$DATA_DIR" 2>/dev/null || true

# Is DATA_DIR a mounted persistent disk (paid Render plans), or just the container's
# ephemeral filesystem (Free plan)? Behaviour is the same; only durability differs.
if grep -q " $DATA_DIR " /proc/mounts 2>/dev/null; then
  echo "[entrypoint] persistent storage detected at $DATA_DIR" >&2
else
  echo "[entrypoint] NOTICE: no persistent disk at $DATA_DIR (e.g. Render Free plan). Audit log, trust memory, keys and downloads are lost on restart/redeploy; stdout logs stay in your host's log stream." >&2
fi

# Chromium is memory hungry: use one browser context at a time below ~1 GiB RAM.
MEM="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo max)"
CONC=2
LOWMEM=false
case "$MEM" in
  max|"") ;;
  *[!0-9]*) ;;
  *) if [ "$MEM" -lt 1073741824 ]; then CONC=1; LOWMEM=true; fi ;;
esac

# Config: a Render Secret File wins (put API keys there); otherwise write safe defaults.
SECRET_CONFIG="/etc/secrets/config.json"
if [ -f "$SECRET_CONFIG" ]; then
  CONFIG="$SECRET_CONFIG"
else
  CONFIG="/tmp/syncralis-config.json"
  cat > "$CONFIG" <<JSON
{
  "AUDIT_LOG_PATH": "$DATA_DIR/audit.log",
  "AUDIT_LOG_MAX_BYTES": 10485760,
  "TRUST_MEMORY_PATH": "$DATA_DIR/trust-memory.json",
  "BOT_AUTH_KEY_DIR": "$DATA_DIR/keys",
  "DOWNLOAD_DIR": "$DATA_DIR/downloads",
  "CHROMIUM_NO_SANDBOX": true,
  "CHROMIUM_DISABLE_DEV_SHM": true,
  "CHROMIUM_LOW_MEMORY": $LOWMEM,
  "SSRF_PINNED_PROXY": true,
  "STREAM_DOWNLOAD_LIMIT": true,
  "MAX_CONCURRENT_BROWSER_TASKS": $CONC
}
JSON
  chown app:app "$CONFIG"
  chmod 600 "$CONFIG"
fi

exec gosu app "$@" --config "$CONFIG"
