#!/bin/sh
set -eu

node /opt/js-debug/src/dapDebugServer.js 4711 127.0.0.1 &
adapter_pid=$!
attempt=0
while ! grep -Eq ':[0]*1267 .* 0A' /proc/net/tcp; do
    attempt=$((attempt + 1))
    if ! kill -0 "$adapter_pid" 2>/dev/null || [ "$attempt" -ge 100 ]; then
        kill "$adapter_pid" 2>/dev/null || true
        wait "$adapter_pid" 2>/dev/null || true
        exit 1
    fi
    sleep 0.1
done

exec socat UNIX-LISTEN:/bridge/dap.sock,fork,mode=600 TCP:127.0.0.1:4711
