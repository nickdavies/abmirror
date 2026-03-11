#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/test/integration/docker-compose.yml"
SERVER_URL="http://localhost:5007"
HEALTH_TIMEOUT_SECS=30
SERVER_PASSWORD="test"
ACTUAL_ENV_DATA_DIR="${ROOT_DIR}/test/integration/.tmp-actual-data"

MODE=""
CONTAINER_NAME="ab-mirror-it-actual-server"

if docker compose version >/dev/null 2>&1; then
  MODE="compose-plugin"
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  MODE="compose-standalone"
  COMPOSE_CMD=(docker-compose)
else
  MODE="docker-run"
fi

cleanup() {
  if [[ "${MODE}" == "compose-plugin" || "${MODE}" == "compose-standalone" ]]; then
    "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" down -v >/dev/null 2>&1 || true
  else
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

rm -rf "${ACTUAL_ENV_DATA_DIR}"
mkdir -p "${ACTUAL_ENV_DATA_DIR}"
export ACTUAL_DATA_DIR="${ACTUAL_ENV_DATA_DIR}"

echo "Starting Actual server container..."
if [[ "${MODE}" == "compose-plugin" || "${MODE}" == "compose-standalone" ]]; then
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" up -d
else
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker run --pull=always --rm -d \
    --name "${CONTAINER_NAME}" \
    -p 5007:5006 \
    --tmpfs /data \
    actualbudget/actual-server:latest >/dev/null
fi

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
needs_bootstrap="$(curl -fsS "${SERVER_URL}/account/needs-bootstrap" | node -e "let b='';process.stdin.on('data',d=>b+=d).on('end',()=>{const j=JSON.parse(b);process.stdout.write(String(!j.data.bootstrapped));});")"
if [[ "${needs_bootstrap}" == "true" ]]; then
  curl -fsS -X POST "${SERVER_URL}/account/bootstrap" \
    -H "content-type: application/json" \
    -d "{\"password\":\"${SERVER_PASSWORD}\"}" >/dev/null
fi

echo "Building ab-mirror..."
(cd "${ROOT_DIR}" && npm run build)

echo "Running blackbox integration test..."
(cd "${ROOT_DIR}" && npx tsx test/integration/integration-test.ts)

echo "Integration test completed."
