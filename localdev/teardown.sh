#!/usr/bin/env bash
set -euo pipefail

# Must run from localdev dir (contains ./data and config.yaml)
LOCALDEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${LOCALDEV_DIR}"
if [[ ! -f ./docker-compose.yml ]]; then
  echo "Error: docker-compose.yml not found (wrong directory?)" >&2
  exit 1
fi

# Parse --clean
CLEAN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      CLEAN=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: teardown.sh [--clean]" >&2
      exit 1
      ;;
  esac
done

# Docker compose detection
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: docker compose or docker-compose required" >&2
  exit 1
fi

echo "Stopping Actual server..."
"${COMPOSE_CMD[@]}" -f ./docker-compose.yml down

if [[ "${CLEAN}" == "true" ]]; then
  echo "Removing data and config..."
  if [[ -d ./data ]]; then
    # Data was created by root in container; use docker to delete (no sudo)
    docker run --rm -v "$(pwd)/data:/data" alpine find /data -mindepth 1 -delete
    docker run --rm -v "$(pwd):/work" -w /work alpine rmdir ./data 2>/dev/null || true
  fi
  rm -f ./config.yaml
  echo "Teardown complete (containers, data, and config removed)."
else
  echo "Teardown complete (containers stopped; data and config preserved)."
  echo "Use --clean to also remove ./data and config.yaml"
fi
