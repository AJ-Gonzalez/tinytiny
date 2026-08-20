#!/usr/bin/env bash
SECONDS=0
set -euo pipefail

bun build --compile src/cli.ts --outfile tinytiny

duration=$SECONDS
size=$(stat -c%s tinytiny 2>/dev/null || stat -f%z tinytiny)
echo "Built ./tinytiny ($((size / 1024 / 1024)) MiB) in $((duration / 60)):$((duration % 60))"
