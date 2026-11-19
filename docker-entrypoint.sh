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
DEFAULTS="/tmp/syncralis-defaults.json"
CONFIG="/tmp/syncralis-config.json"
cat > "$DEFAULTS" <<JSON
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

SECRET_CONFIG="${SECRET_CONFIG_PATH:-/etc/secrets/config.json}"
if [ -f "$SECRET_CONFIG" ]; then
  echo "[entrypoint] merging secret config $SECRET_CONFIG over hosted defaults" >&2
  node -e '
    const fs = require("fs");
    const [defaultsPath, userPath, outPath] = process.argv.slice(1);
    const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf8"));
    let user;
    try { user = JSON.parse(fs.readFileSync(userPath, "utf8")); }
    catch (e) { console.error("[entrypoint] ERROR: " + userPath + " is not valid JSON: " + e.message); process.exit(1); }
    fs.writeFileSync(outPath, JSON.stringify({ ...defaults, ...user }, null, 2), { mode: 0o600 });
  ' "$DEFAULTS" "$SECRET_CONFIG" "$CONFIG"
else
  cp "$DEFAULTS" "$CONFIG"
fi
chown app:app "$CONFIG"
chmod 600 "$CONFIG"
rm -f "$DEFAULTS"

exec gosu app "$@" --config "$CONFIG"
