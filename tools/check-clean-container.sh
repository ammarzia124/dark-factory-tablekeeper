#!/usr/bin/env bash
# Build a service folder from scratch and prove it serves with no outbound network.
#
#   tools/check-clean-container.sh stage-1            # probes GET /health
#   tools/check-clean-container.sh stage-2 /health 8080
#
# What it does:
#   1. Pulls the Dockerfile's base image(s) -- the only network step allowed.
#   2. Builds with --no-cache --network=none, so no build step may download anything.
#   3. Runs the image with --network none and a CPU/memory cap.
#   4. Probes the health path from inside the container until it answers 2xx.
# Exit code 0 means the folder passed.
set -euo pipefail

DIR="${1:?usage: $0 <service-folder> [health-path] [port]}"
HEALTH="${2:-/health}"
PORT="${3:-8080}"
CPUS="${CPUS:-1}"
MEMORY="${MEMORY:-512m}"
TAG="clean-check-$(basename "$DIR" | tr '[:upper:]' '[:lower:]')"
NAME="${TAG}-$$"

[ -f "$DIR/Dockerfile" ] || { echo "FAIL: $DIR/Dockerfile not found"; exit 1; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "==> pulling base image(s)"
grep -iE '^[[:space:]]*FROM[[:space:]]' "$DIR/Dockerfile" | awk '{print $2}' | sort -u |
  while read -r image; do
    # Skip references to earlier build stages (FROM builder ...).
    if grep -qiE "^[[:space:]]*FROM[[:space:]].*[[:space:]]AS[[:space:]]+$image\$" "$DIR/Dockerfile"; then
      continue
    fi
    docker pull -q "$image"
  done

echo "==> building $DIR with no network"
docker build --no-cache --network=none -t "$TAG" "$DIR"

echo "==> starting with --network none (cpus=$CPUS memory=$MEMORY)"
docker run -d --name "$NAME" --network none --cpus "$CPUS" --memory "$MEMORY" \
  -e PORT="$PORT" "$TAG" >/dev/null

# The container has no network, so probe from inside it with whatever client exists.
PROBE="url=http://127.0.0.1:$PORT$HEALTH
if command -v curl >/dev/null; then curl -fsS \"\$url\"
elif command -v wget >/dev/null; then wget -qO- \"\$url\"
elif command -v python3 >/dev/null; then python3 -c \"import sys,urllib.request;print(urllib.request.urlopen(sys.argv[1],timeout=2).read().decode())\" \"\$url\"
elif command -v node >/dev/null; then node -e \"fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1);return r.text()}).then(console.log).catch(()=>process.exit(1))\" \"\$url\"
else echo 'no http client in image' >&2; exit 2; fi"

echo "==> probing $HEALTH"
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != "true" ]; then
    echo "FAIL: container exited"; docker logs "$NAME" 2>&1 | tail -40; exit 1
  fi
  if out=$(docker exec "$NAME" sh -c "$PROBE" 2>/dev/null); then
    echo "PASS: $DIR serves $HEALTH -> $out"
    exit 0
  fi
  sleep 1
done

echo "FAIL: no healthy answer within 60 s"; docker logs "$NAME" 2>&1 | tail -40; exit 1
