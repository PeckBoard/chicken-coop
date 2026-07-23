#!/usr/bin/env bash
# Build the chicken-coop plugin wasm: page bundle → plugin bundle → extism-js.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  npm install
fi

npm run build

echo "Built dist/plugin.wasm ($(du -h dist/plugin.wasm | cut -f1))"
