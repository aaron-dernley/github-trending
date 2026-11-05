#!/bin/bash
# Starts swamp serve just long enough to run one method call through it,
# then tears it down — avoids the ~400MB idle RSS cost of a persistent
# swamp serve daemon while still going through swamp serve as requested.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=9093
INSTANCE=daily
METHOD=snapshot

cd "$REPO_DIR"
swamp serve --repo-dir "$REPO_DIR" --port "$PORT" --host 127.0.0.1 --no-schedule \
  >/tmp/github-trending-serve.log 2>&1 &
SERVE_PID=$!
trap 'kill "$SERVE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

swamp model method run "$INSTANCE" "$METHOD" --server "ws://127.0.0.1:${PORT}"

# Export a small Prometheus textfile snippet for the Fun Stuff Grafana
# dashboard. Written atomically (tmp file + mv) since node_exporter may
# be scraping the textfile directory concurrently.
PROM_DIR=/var/lib/prometheus/node-exporter
PROM_TMP="$(mktemp "${PROM_DIR}/.github-trending.prom.XXXXXX")"
swamp data get "$INSTANCE" trending --server "ws://127.0.0.1:${PORT}" --json | python3 -c "
import json, sys
d = json.load(sys.stdin)['content']
top = d['repos'][0]
def esc(s):
    return s.replace('\\\\', '\\\\\\\\').replace('\"', '\\\\\"')
print('# HELP github_trending_top_repo_stars Star count of the top repo in the latest snapshot (recently-created, most-starred proxy for trending), labeled with the repo\\'s name and language.')
print('# TYPE github_trending_top_repo_stars gauge')
print(f\"github_trending_top_repo_stars{{repo=\\\"{esc(top['fullName'])}\\\",language=\\\"{esc(top['language'] or '')}\\\"}} {top['stars']}\")
print('# HELP github_trending_total_matching Total repos GitHub reports matching the snapshot query, not just the ones returned.')
print('# TYPE github_trending_total_matching gauge')
print(f\"github_trending_total_matching {d['totalMatching']}\")
" > "$PROM_TMP"
chmod 644 "$PROM_TMP"
mv "$PROM_TMP" "${PROM_DIR}/github-trending.prom"
