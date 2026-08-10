#!/usr/bin/env bash
set -euo pipefail

readonly EXPECTED_NODE_VERSION="v22.23.2"
readonly REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -n "${ONSALE_NODE22_BIN:-}" ]]; then
  task_node="${ONSALE_NODE22_BIN}"
elif [[ -x "/tmp/onsale-node22/node-v22.23.2-linux-x64/bin/node" ]]; then
  task_node="/tmp/onsale-node22/node-v22.23.2-linux-x64/bin/node"
else
  task_node="$(command -v node || true)"
fi

if [[ -z "${task_node}" || ! -x "${task_node}" ]]; then
  echo "Set ONSALE_NODE22_BIN to the Linux Node 22.23.2 executable." >&2
  exit 2
fi

actual_version="$("${task_node}" -p 'process.version')"
if [[ "${actual_version}" != "${EXPECTED_NODE_VERSION}" ]]; then
  echo "Expected ${EXPECTED_NODE_VERSION}; received ${actual_version} from ${task_node}." >&2
  exit 2
fi

if [[ -n "${ONSALE_NATIVE_NODE_MODULES:-}" ]]; then
  dependency_root="${ONSALE_NATIVE_NODE_MODULES}"
else
  dependency_root="$(readlink -f "${REPOSITORY_ROOT}/node_modules" 2>/dev/null || true)"
fi

if [[ -z "${dependency_root}" || ! -d "${dependency_root}" ]]; then
  echo "Set ONSALE_NATIVE_NODE_MODULES to the Linux-native node_modules directory." >&2
  exit 2
fi
case "${dependency_root}" in
  /mnt/c/*|/mnt/C/*)
    echo "ONSALE_NATIVE_NODE_MODULES must not be mounted from Windows." >&2
    exit 2
    ;;
esac

export ONSALE_NODE22_BIN="${task_node}"
export ONSALE_NATIVE_NODE_MODULES="${dependency_root}"
cd "${REPOSITORY_ROOT}"
exec "${task_node}" scripts/eval-v01-recovery.mjs "$@"
