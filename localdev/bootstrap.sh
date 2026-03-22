#!/usr/bin/env bash
set -euo pipefail

# Capture cwd before any cd (user's working dir for resolving relative zip paths)
INVOKE_CWD="$(pwd)"
LOCALDEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${LOCALDEV_DIR}/.." && pwd)"
COMPOSE_FILE="${LOCALDEV_DIR}/docker-compose.yml"
HEALTH_TIMEOUT_SECS=30
SERVER_PASSWORD="test"

# Parse --port (optional) for health check
PORT=5007
args=("$@")
for ((i=0; i < ${#args[@]}; i++)); do
  if [[ "${args[i]}" == "--port" && $((i + 1)) -lt ${#args[@]} ]]; then
    PORT="${args[i+1]}"
    break
  fi
done

SERVER_URL="http://localhost:${PORT}"

# Docker compose detection
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: docker compose or docker-compose required" >&2
  exit 1
fi

echo "Starting Actual server..."
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" up -d

echo "Waiting for Actual server health endpoint..."
start_ts="$(date +%s)"
until curl -fsS "${SERVER_URL}/health" >/dev/null 2>&1; do
  now_ts="$(date +%s)"
  if (( now_ts - start_ts >= HEALTH_TIMEOUT_SECS )); then
    echo "Timed out waiting for ${SERVER_URL}/health" >&2
    exit 1
  fi
  sleep 1
done

echo "Bootstrapping server password auth..."
needs_bootstrap="$(curl -fsS "${SERVER_URL}/account/needs-bootstrap" | node -e "
  let b='';
  process.stdin.on('data', d => b += d).on('end', () => {
    const j = JSON.parse(b);
    process.stdout.write(String(!j.data?.bootstrapped));
  });
")"
if [[ "${needs_bootstrap}" == "true" ]]; then
  curl -fsS -X POST "${SERVER_URL}/account/bootstrap" \
    -H "content-type: application/json" \
    -d "{\"password\":\"${SERVER_PASSWORD}\"}" >/dev/null
fi

echo "Running bootstrap..."
(cd "${ROOT_DIR}" && INVOKE_CWD="${INVOKE_CWD}" npx tsx "${LOCALDEV_DIR}/bootstrap.ts" "$@")

echo "Bootstrap completed."
