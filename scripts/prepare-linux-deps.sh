#!/usr/bin/env bash
# Готовит том docker с нативной привязкой резолвера jest 30 (unrs-resolver) под
# Linux-контейнер, в котором идут спеки процессов (scripts/in-linux-container.sh).
# node_modules пакета ставятся для системы хоста (на macOS — darwin-привязка),
# а jest в контейнере ищет linux-привязку. Её не добавляем ни в package.json,
# ни в lock: она нужна только этому тому. Версия — та же, что у unrs-resolver
# в pnpm-lock.yaml; целостность архива сверяется с lock до распаковки.
#
# Запуск один раз (загрузка ~0,8 МБ архива из настроенного реестра npm):
#   scripts/prepare-linux-deps.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${FAULT_KIT_LINUX_IMAGE:-node:24-bookworm-slim}"
ARCH="$(docker run --rm --network none "${IMAGE}" node -p 'process.arch')"
VERSION="$(sed -nE "s/^  unrs-resolver@([0-9.]+):\$/\1/p" "${ROOT}/pnpm-lock.yaml" | head -1)"
if [[ -z "${VERSION}" ]]; then
  echo "в pnpm-lock.yaml нет unrs-resolver: jest без нативного резолвера — том не нужен"; exit 1
fi
NAME="@unrs/resolver-binding-linux-${ARCH}-gnu"
INTEGRITY="$(grep -A1 "'${NAME}@${VERSION}':" "${ROOT}/pnpm-lock.yaml" | sed -nE 's/.*integrity: (sha512-[^}]+)\}.*/\1/p')"
if [[ -z "${INTEGRITY}" ]]; then
  echo "в pnpm-lock.yaml нет целостности ${NAME}@${VERSION}"; exit 1
fi
VOLUME="fault-kit-linux-deps-${ARCH}-${VERSION}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fault-kit-linux-deps-XXXXXX")"
cleanup() {
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/fault-kit-linux-deps-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT
(cd "${WORK}" && npm pack "${NAME}@${VERSION}" --silent >/dev/null)
TARBALL="$(ls "${WORK}"/*.tgz)"
ACTUAL="sha512-$(openssl dgst -sha512 -binary "${TARBALL}" | openssl base64 -A)"
if [[ "${ACTUAL}" != "${INTEGRITY}" ]]; then
  echo "целостность ${NAME}@${VERSION} не совпала с pnpm-lock.yaml: ${ACTUAL}"; exit 1
fi
docker volume create "${VOLUME}" >/dev/null
docker run --rm --network none -v "${VOLUME}:/deps" -v "${WORK}:/src:ro" "${IMAGE}" sh -c \
  "rm -rf '/deps/node_modules/${NAME}' && mkdir -p '/deps/node_modules/${NAME}' && tar -xzf /src/$(basename "${TARBALL}") -C '/deps/node_modules/${NAME}' --strip-components=1"
echo "том ${VOLUME} готов: ${NAME}@${VERSION}"
