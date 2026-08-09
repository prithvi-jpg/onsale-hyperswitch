#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_NODE_VERSION="v22.23.2"
readonly ACTION="${1:-}"
shift || true

if [[ -n "${ONSALE_NODE22_BIN:-}" ]]; then
  task_node="${ONSALE_NODE22_BIN}"
else
  task_node="$(command -v node || true)"
fi

if [[ -z "${task_node}" || ! -x "${task_node}" ]]; then
  echo "Set ONSALE_NODE22_BIN to the Node 22.23.2 executable." >&2
  exit 2
fi

actual_version="$("${task_node}" -p 'process.version')"
if [[ "${actual_version}" != "${EXPECTED_NODE_VERSION}" ]]; then
  echo "Expected ${EXPECTED_NODE_VERSION}; received ${actual_version} from ${task_node}." >&2
  exit 2
fi

readonly repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly native_root="${ONSALE_NATIVE_ROOT:-/tmp/onsale-v01-recovery-native}"
if [[ -n "${ONSALE_NATIVE_NODE_MODULES:-}" ]]; then
  task_dependency_root="${ONSALE_NATIVE_NODE_MODULES}"
else
  task_dependency_root="$(readlink -f "${repository_root}/node_modules" 2>/dev/null || true)"
fi
readonly dependency_root="${task_dependency_root}"

if [[ "${native_root}" == /mnt/c/* || "${native_root}" == /mnt/C/* ]]; then
  echo "ONSALE_NATIVE_ROOT must be on the Linux-native filesystem, not /mnt/c." >&2
  exit 2
fi

if [[ -z "${dependency_root}" || ! -d "${dependency_root}" ]]; then
  echo "Set ONSALE_NATIVE_NODE_MODULES to a Linux-native node_modules directory." >&2
  exit 2
fi

case "${dependency_root}" in
  /mnt/c/*|/mnt/C/*)
    echo "ONSALE_NATIVE_NODE_MODULES must not be mounted from Windows." >&2
    exit 2
    ;;
esac

mkdir -p "${native_root}"
if [[ -e "${native_root}/node_modules" && ! -L "${native_root}/node_modules" ]]; then
  echo "Refusing to replace non-symlink ${native_root}/node_modules." >&2
  exit 2
fi
rsync -a --delete \
  --exclude '.git/' \
  --exclude '.next/' \
  --exclude '.cache/' \
  --exclude 'node_modules/' \
  --exclude 'artifacts/' \
  --exclude 'test-results/' \
  "${repository_root}/" "${native_root}/"

ln -sfn "${dependency_root}" "${native_root}/node_modules"
cd "${native_root}"
export ONSALE_SOURCE_ROOT="${repository_root}"
export ONSALE_PRIVATE_ENV_FILE="${ONSALE_PRIVATE_ENV_FILE:-${repository_root}/../v01/.env}"

case "${ACTION}" in
  typecheck)
    exec "${task_node}" node_modules/typescript/bin/tsc --noEmit --incremental false "$@"
    ;;
  test)
    exec "${task_node}" node_modules/vitest/vitest.mjs run "$@"
    ;;
  build)
    exec "${task_node}" node_modules/next/dist/bin/next build --webpack "$@"
    ;;
  dev)
    exec "${task_node}" node_modules/next/dist/bin/next dev --webpack "$@"
    ;;
  portless)
    mode="${1:-}"
    transport="${2:-http}"
    if [[ "${mode}" != "dev" && "${mode}" != "start" ]]; then
      echo "Usage: scripts/native-node22.sh portless {dev|start} {http|https}" >&2
      exit 2
    fi
    exec "${task_node}" scripts/portless-local-preview.ts "${mode}" "${transport}"
    ;;
  direct)
    mode="${1:-}"
    if [[ "${mode}" != "dev" && "${mode}" != "start" ]]; then
      echo "Usage: scripts/native-node22.sh direct {dev|start}" >&2
      exit 2
    fi
    shift || true
    export ONSALE_CANONICAL_ORIGIN="http://localhost:3102"
    exec "${task_node}" scripts/local-preview-runtime.ts "${mode}" "$@"
    ;;
  vite)
    mode="${1:-}"
    shift || true
    if [[ "${mode}" == "build" ]]; then
      exec "${task_node}" node_modules/vite/bin/vite.js build "$@"
    fi
    if [[ "${mode}" == "dev" ]]; then
      exec "${task_node}" node_modules/vite/bin/vite.js --host 0.0.0.0 "$@"
    fi
    if [[ "${mode}" == "preview" ]]; then
      exec "${task_node}" node_modules/vite/bin/vite.js preview "$@"
    fi
    echo "Usage: scripts/native-node22.sh vite {build|dev|preview}" >&2
    exit 2
    ;;
  *)
    echo "Usage: scripts/native-node22.sh {typecheck|test|build|dev|portless|direct|vite} [arguments]" >&2
    exit 2
    ;;
esac
