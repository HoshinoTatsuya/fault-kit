#!/usr/bin/env bash
# Выполнить команду в одноразовом Linux-контейнере (node:24-bookworm-slim,
# без сети). Так идут спеки и мутации кода, который шлёт сигналы процессам
# (`src/process/`): ошибка в вычислении pid внутри контейнера задевает только
# процессы контейнера, а не процессы пользователя на машине разработчика.
#
# Каталог пакета монтируется по тому же пути (символические ссылки pnpm
# резолвятся), node_modules — хостовые; нативная привязка резолвера jest для
# Linux — из тома, который готовит scripts/prepare-linux-deps.sh.
#
# FAULT_KIT_IN_CONTAINER=1 — команда уже идёт в одноразовом Linux-контейнере
# (джоба CI): выполняется как есть. Без docker и без этой переменной — отказ,
# а не прогон на хосте.
set -euo pipefail
if [[ "${FAULT_KIT_IN_CONTAINER:-}" == 1 ]]; then
  if [[ "$(uname -s)" != Linux ]]; then
    echo "FAULT_KIT_IN_CONTAINER=1 задан не в Linux ($(uname -s)): спеки процессов идут только в Linux-контейнере" >&2
    exit 1
  fi
  exec "$@"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${FAULT_KIT_LINUX_IMAGE:-node:24-bookworm-slim}"
ARCH="$(docker run --rm --network none "${IMAGE}" node -p 'process.arch')"
VERSION="$(sed -nE "s/^  unrs-resolver@([0-9.]+):\$/\1/p" "${ROOT}/pnpm-lock.yaml" | head -1)"
VOLUME="fault-kit-linux-deps-${ARCH}-${VERSION}"
if ! docker volume inspect "${VOLUME}" >/dev/null 2>&1; then
  echo "нет тома ${VOLUME} с linux-привязкой резолвера jest: запустите scripts/prepare-linux-deps.sh" >&2
  exit 1
fi
NAME="fault-kit-linux-$$"
# Снять контейнер, если сняли сам скрипт (потолок прогона, Ctrl+C): клиент docker при смерти его не останавливает.
trap 'docker rm -f "${NAME}" >/dev/null 2>&1 || true' EXIT
# Под пользователем хоста: файлы, которые пишет команда (кэш раннера групп, отчёты), остаются
# его собственными. От root на Linux следующий шаг на хосте получал EACCES на них.
docker run --rm --init --network none --cpus 2 --memory 3g --name "${NAME}" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "${ROOT}:${ROOT}" -v "${VOLUME}:/linux-deps:ro" -w "${ROOT}" \
  -e NODE_PATH=/linux-deps/node_modules -e FAULT_KIT_IN_CONTAINER=1 -e CI=true \
  "${IMAGE}" "$@"
