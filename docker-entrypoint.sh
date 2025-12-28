#!/bin/sh
set -eu

CONFIG_PATH="/app/config.json"

if [ ! -f "$CONFIG_PATH" ]; then
  echo "[entrypoint] config.json not found, creating default one..."
  cat > "$CONFIG_PATH" <<'EOF'
{
  "debug": false,
  "pan115": {
    "cookie": "",
    "userId": "",
    "baseURL": "https://webapi.115.com",
    "accessToken": "",
    "refreshToken": "",
    "listConcurrency": 1,
    "listMinIntervalMs": 400,
    "fileListTtlMs": 60000,
    "downloadUrlTtlMs": 60000
  },
  "webdav": {
    "port": 3000,
    "username": "admin",
    "password": "admin",
    "blockGoHttpClient": true
  }
}
EOF
fi

exec "$@"
