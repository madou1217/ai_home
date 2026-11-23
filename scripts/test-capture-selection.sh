#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
swiftc -O -o "$OUT/selection-test" \
  "$ROOT/native/account-browser/selection.swift" \
  "$ROOT/native/account-browser/selection_test.swift"
"$OUT/selection-test"
