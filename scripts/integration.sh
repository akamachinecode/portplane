#!/usr/bin/env bash
# Integration test with a real dekit (no portless): a project with a
# service, a failing task and a job; Portplane must report each state.
# Usage: scripts/integration.sh path/to/portplane
set -euo pipefail
bin=$(realpath "$1")
work=$(mktemp -d)
trap 'dekit -C "$work/proj" runner stop >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
mkdir -p "$work/proj/apps/api"
cat > "$work/proj/apps/api/server.js" <<'JS'
require("http").createServer((q, s) => s.end("ok")).listen(47123, "127.0.0.1");
JS
cat > "$work/proj/dekit.yaml" <<'YAML'
tasks:
  shop/:
  shop/setup:
    type: job
    cmd: ["node", "-e", "console.log('setup done')"]
  shop/api:
    cwd: apps/api
    cmd: ["node", "server.js"]
    deps: [shop/setup]
    ready: {tcp: "127.0.0.1:47123"}
  shop/broken:
    cmd: ["node", "-e", "console.error('boom: missing FOO'); process.exit(3)"]
YAML
export PORTPLANE_SETTINGS="$work/settings.json"
"$bin" folders add "$work/proj" >/dev/null

state() { "$bin" ls --json | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const snap = JSON.parse(s);
    const app = snap.apps.find(a => a.task === process.argv[1]);
    console.log(app ? `${app.state} ${app.port || 0} ${app.detail || ""}`.trim() : "missing");
  });' "$1"; }

expect() { # task, prefix of "state port detail"
  for _ in $(seq 1 30); do
    got=$(state "$1")
    [[ "$got" == "$2"* ]] && { echo "ok   $1: $got"; return 0; }
    sleep 1
  done
  echo "FAIL $1: got '$got', want '$2'"; "$bin" ls --all; exit 1
}

"$bin" ls | grep -q "runner is not running"
expect shop/api "off"
dekit -C "$work/proj" up >/dev/null
"$bin" start shop/ >/dev/null
expect shop/setup "done"
expect shop/api "on 47123"
expect shop/broken "failed 0 exit code 3"
"$bin" stop shop/api >/dev/null
expect shop/api "off"
echo "integration: all good"
