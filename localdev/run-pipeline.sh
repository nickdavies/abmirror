#!/usr/bin/env bash
set -euo pipefail

LOCALDEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${LOCALDEV_DIR}/.." && pwd)"
DEFAULT_CONFIG="${LOCALDEV_DIR}/config.yaml"

CONFIG="${DEFAULT_CONFIG}"
PIPELINE_FILE=""
PIPELINE_STDIN=false
AB_MIRROR_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG="$2"
      shift 2
      ;;
    --pipeline)
      if [[ "$2" == "-" ]]; then
        PIPELINE_STDIN=true
      else
        PIPELINE_FILE="$2"
      fi
      shift 2
      ;;
    --dry-run|--verbose|--debug-sync)
      AB_MIRROR_ARGS+=("$1")
      shift
      ;;
    --step)
      AB_MIRROR_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: run-pipeline.sh [--config PATH] --pipeline FILE|- [--dry-run] [--step N] [--verbose]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "${PIPELINE_FILE}" && "${PIPELINE_STDIN}" != "true" ]]; then
  echo "Error: --pipeline FILE or --pipeline - required" >&2
  echo "Usage: run-pipeline.sh [--config PATH] --pipeline FILE|- [--dry-run] [--step N] [--verbose]" >&2
  exit 1
fi

# Resolve config path if relative (from repo root)
if [[ "${CONFIG}" != /* ]]; then
  CONFIG="${ROOT_DIR}/${CONFIG}"
fi

if [[ ! -f "${CONFIG}" ]]; then
  echo "Error: Config not found: ${CONFIG}" >&2
  echo "Run bootstrap.sh first to create config.yaml" >&2
  exit 1
fi

# Resolve pipeline path if relative (from localdev dir, where pipelines/ lives)
if [[ -n "${PIPELINE_FILE}" && "${PIPELINE_FILE}" != /* ]]; then
  PIPELINE_FILE="${LOCALDEV_DIR}/${PIPELINE_FILE}"
fi

# Get pipeline content
if [[ "${PIPELINE_STDIN}" == "true" ]]; then
  PIPELINE_TMP="$(mktemp)"
  cat > "${PIPELINE_TMP}"
  CLEANUP_PIPELINE=1
else
  PIPELINE_TMP="${PIPELINE_FILE}"
  CLEANUP_PIPELINE=0
fi

TMP_CONFIG="$(mktemp)"
cleanup() {
  rm -f "${TMP_CONFIG}"
  [[ "${CLEANUP_PIPELINE}" -eq 1 ]] && rm -f "${PIPELINE_TMP}"
}
trap cleanup EXIT

# Merge config + pipeline, write to temp
(cd "${ROOT_DIR}" && npx tsx "${LOCALDEV_DIR}/merge-config.ts" "${CONFIG}" "${PIPELINE_TMP}" "${TMP_CONFIG}")

# Build ab-mirror first if needed
if [[ ! -f "${ROOT_DIR}/dist/cli.js" ]]; then
  (cd "${ROOT_DIR}" && npm run build)
fi

(cd "${ROOT_DIR}" && node dist/cli.js run --config "${TMP_CONFIG}" "${AB_MIRROR_ARGS[@]+"${AB_MIRROR_ARGS[@]}"}")
