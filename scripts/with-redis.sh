#!/usr/bin/env bash
# Поднимает одноразовый Redis в docker на свободном порту, отдаёт адрес в
# REDIS_TEST_URL и запускает переданную команду. Адрес уже задан (CI-сервис) —
# docker не нужен. Контейнер удаляется вместе с томами при любом исходе.
set -euo pipefail
if [[ -n "${REDIS_TEST_URL:-}" ]]; then
  exec "$@"
fi
IMAGE="${REDIS_TEST_IMAGE:-redis:7.4-alpine}"
NAME="fault-kit-test-redis-$$"
docker run -d --rm --name "${NAME}" -p 127.0.0.1:0:6379 "${IMAGE}" >/dev/null
trap 'docker rm -f -v "${NAME}" >/dev/null 2>&1 || true' EXIT
PORT="$(docker port "${NAME}" 6379/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 50); do
  if docker exec "${NAME}" redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  sleep 0.2
done
docker exec "${NAME}" redis-cli ping | grep -q PONG || { echo "redis не поднялся" >&2; exit 1; }
REDIS_TEST_URL="redis://127.0.0.1:${PORT}" "$@"
