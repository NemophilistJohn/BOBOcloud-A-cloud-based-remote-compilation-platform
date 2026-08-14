#!/bin/sh
set -eu

dependency_paths="${BOBO_PYRIGHT_DEPENDENCY_PATHS:-}"
if [ -n "$dependency_paths" ] && [ "${PYTHONPATH:-}" != "$dependency_paths" ]; then
  if [ -n "${PYTHONPATH:-}" ]; then
    PYTHONPATH="$dependency_paths:$PYTHONPATH"
  else
    PYTHONPATH="$dependency_paths"
  fi
  export PYTHONPATH
fi

exec /usr/bin/python3 "$@"
