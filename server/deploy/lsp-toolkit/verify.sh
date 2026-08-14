#!/bin/sh
set -eu

check() {
  label="$1"
  shift
  printf '%-28s ' "$label"
  if output=$("$@" 2>&1); then
    printf '%s\n' "$output" | sed -n '1p'
  else
    status=$?
    printf '%s\n' "$output" | sed -n '1p'
    return "$status"
  fi
}

check rust-analyzer rust-analyzer --version
check rustc rustc --version
check cargo cargo --version
check gopls gopls version
check go go version
check clangd /usr/bin/clangd-19 --version
check c-compiler cc --version
check java "$JAVA_HOME/bin/java" -version
check python python3 --version
check python-stdlib python3 -c 'import json, pathlib; print("json+pathlib ok")'
check pyright-python bobocloud-python --version
check git git --version
check pyright pyright --version
check typescript-language-server typescript-language-server --version
check typescript tsc --version
check web-language-servers node -p "require('/opt/node-lsp/node_modules/vscode-langservers-extracted/package.json').version"
check yaml-language-server node -p "require('/opt/node-lsp/node_modules/yaml-language-server/package.json').version"
check bash-language-server node -p "require('/opt/node-lsp/node_modules/bash-language-server/package.json').version"

test -d /opt/jdtls/config_linux
ls /opt/jdtls/plugins/org.eclipse.equinox.launcher_*.jar >/dev/null
printf '%-28s %s\n' jdtls 'launcher present (runtime validated by smoke test)'
