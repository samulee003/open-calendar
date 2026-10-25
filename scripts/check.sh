#!/usr/bin/env bash
# Runs every suite. Uses $NODE if set, otherwise the node on your PATH.
# Requires Node 24+ (or 22.19+ with type stripping) because the sources are .ts
# executed directly, without a build step.
set -e
NODE="${NODE:-node}"
if ! "$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' 2>/dev/null; then
  echo "需要 Node 22.19+／24+（目前: $("$NODE" --version 2>/dev/null || echo 找不到 node)）"
  exit 2
fi
for t in test-nlp test-holidays test-rrule test-import test-e2e-import test-agent selftest; do
  echo "=== $t ==="
  "$NODE" "scripts/$t.ts"
done
