#!/usr/bin/env bash
# Polls the Pages deploy for a commit every 10 s and stops as soon as it finishes. Also shows the Tests run.
# Usage: scripts/deploy-status.sh [commit]   (default: HEAD)
sha=${1:-$(git rev-parse HEAD)}
for i in $(seq 1 40); do
  runs=$(curl -s "https://api.github.com/repos/Montzi/budtracks/actions/runs?per_page=10&head_sha=$sha")
  pages=$(echo "$runs" | jq -r '[.workflow_runs[] | select(.name=="Deploy to GitHub Pages")][0] | "\(.status) \(.conclusion)"')
  tests=$(echo "$runs" | jq -r '[.workflow_runs[] | select(.name=="Tests")][0] | "\(.status) \(.conclusion)"')
  echo "Pages: $pages · Tests: $tests"
  case "$pages" in completed*) [ "$pages" = "completed success" ] && exit 0 || exit 1;; esac
  sleep 10
done
echo "Gave up after 400 s"; exit 1
