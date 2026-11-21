#!/usr/bin/env bash
# Матрица потребителей: собранный пакет (npm pack) ставится в одноразовые
# проекты с разными настройками модулей (CommonJS, node16, nodenext, ESM с
# nodenext и с bundler, node10 без карты exports), везде strict +
# exactOptionalPropertyTypes и БЕЗ skipLibCheck: декларации пакета проверяются
# компилятором потребителя. Подпути берутся из карты `exports` package.json, а
# не списком здесь: новый вход без проверки не останется. В каждом проекте —
# tsc, загрузка каждого входа в рантайме (require для CJS, import для ESM) и,
# у CJS-проектов, ts-jest.
#
# Запуск: scripts/consumer-matrix.sh (или pnpm run test:consumers) под общей
# блокировкой прогонов. Каталоги — из mkdtemp, удаляются в конце.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fault-kit-consumers-XXXXXX")"
cleanup() {
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/fault-kit-consumers-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT

(cd "${ROOT}" && pnpm build >/dev/null && npm pack --silent --pack-destination "${WORK}" >/dev/null)
TARBALL="$(ls "${WORK}"/hoshinotatsuya-fault-kit-*.tgz)"

# Входы пакета из карты exports: '.' → '@hoshinotatsuya/fault-kit', './tcp' → '@hoshinotatsuya/fault-kit/tcp'.
# bash 3.2 (macOS) без mapfile — чтение построчно.
ENTRIES=()
while IFS= read -r entry; do
  ENTRIES+=("${entry}")
done < <(node -e '
  const p = require(process.argv[1]);
  for (const key of Object.keys(p.exports)) {
    if (key.endsWith(".json")) continue;
    console.log(key === "." ? p.name : p.name + key.slice(1));
  }' "${ROOT}/package.json")
if [[ "${#ENTRIES[@]}" -lt 6 ]]; then
  echo "карта exports дала ${#ENTRIES[@]} входов — ожидалось не меньше 6"; exit 1
fi

# Импорт каждого входа + использование типов с необязательными полями (exactOptionalPropertyTypes)
# + утверждение, что ни один экспорт не стал any (нерезолвящийся тип молча превращается в any).
CONSUMER_TS="$(
  for index in "${!ENTRIES[@]}"; do echo "import * as entry${index} from '${ENTRIES[index]}';"; done
  cat <<'TS'
import { expectPendingThrough, expectSameMembers, type Deadline } from '@hoshinotatsuya/fault-kit';
import { FaultProxy, DROP_MODE, type FaultProxyOptions } from '@hoshinotatsuya/fault-kit/tcp';
import { FakeDnsServer, dockerDnsArgs, type FakeDnsServerOptions } from '@hoshinotatsuya/fault-kit/dns';
import { holdLock, LOCK_MODE, terminateBackends, type LockHoldOptions, type BackendFilter } from '@hoshinotatsuya/fault-kit/postgres';
import { RedisFaults, REDIS_PAUSE_MODE, type RedisCommander } from '@hoshinotatsuya/fault-kit/redis';
import { spawnBehindShell, LineReader, type SpawnBehindShellOptions } from '@hoshinotatsuya/fault-kit/process';

type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : true;
export const typed: [
  NotAny<typeof FaultProxy>, NotAny<typeof FakeDnsServer>, NotAny<typeof holdLock>, NotAny<typeof RedisFaults>,
  NotAny<typeof spawnBehindShell>, NotAny<typeof expectPendingThrough>, NotAny<typeof LineReader>,
] = [true, true, true, true, true, true, true];

const proxyOptions: FaultProxyOptions = { host: '127.0.0.1', port: 5432 };
const dnsOptions: FakeDnsServerOptions = { records: { 'api.test': ['10.0.0.1'] } };
const lockOptions: LockHoldOptions = { lockTimeoutMs: 100, only: true, timeoutMs: 500 };
const filter: BackendFilter = { applicationName: 'worker', anyDatabase: true };
const spawnOptions: SpawnBehindShellOptions = { stdio: 'ignore', killLimit: 8 };
const window: Deadline = { turns: 3 };
export const usage = {
  start: () => FaultProxy.start(proxyOptions),
  dns: () => FakeDnsServer.start(dnsOptions),
  lock: (url: string) => holdLock(url, 'jobs', LOCK_MODE.share, lockOptions),
  kill: (pool: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }) => terminateBackends(pool, filter),
  pause: (admin: RedisCommander) => new RedisFaults(admin).pause(100, REDIS_PAUSE_MODE.write),
  spawn: () => spawnBehindShell('true', [], spawnOptions),
  window: (work: Promise<unknown>) => expectPendingThrough(work, window),
  members: () => expectSameMembers([1], [1]),
  modes: [DROP_MODE.close, dockerDnsArgs({ ndots: 1 })],
};
TS
  printf 'export const entries = [%s];\n' "$(for index in "${!ENTRIES[@]}"; do printf 'entry%s, ' "${index}"; done)"
)"

SPEC_TS="import { entries } from './consumer';

it('каждый вход пакета грузится и что-то экспортирует', () => {
  expect(entries.map((entry) => Object.keys(entry).length > 0)).toEqual(entries.map(() => true));
});
"

RUNTIME_CJS="const names = JSON.parse(process.argv[1]);
for (const name of names) { const m = require(name); if (Object.keys(m).length === 0) { console.error('пусто: ' + name); process.exit(1); } }"
RUNTIME_ESM="const names = JSON.parse(process.argv[1]);
for (const name of names) { const m = await import(name); if (Object.keys(m).filter((k) => k !== 'default').length === 0) { console.error('пусто: ' + name); process.exit(1); } }"
NAMES_JSON="$(printf '%s\n' "${ENTRIES[@]}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0, "utf8").trim().split("\n")))')"

failures=0
run_case() {
  local label="$1" module="$2" resolution="$3" type="$4" jest="$5"
  local dir="${WORK}/${label}"
  mkdir -p "${dir}/src"
  cat >"${dir}/package.json" <<JSON
{
  "name": "consumer-${label}",
  "private": true,
  "type": "${type}",
  "dependencies": {
    "@hoshinotatsuya/fault-kit": "file:${TARBALL}",
    "pg": "8.18.0"
  },
  "devDependencies": {
    "@types/jest": "30.0.0",
    "@types/node": "24.0.15",
    "@types/pg": "8.23.1",
    "jest": "30.5.2",
    "ts-jest": "29.4.5",
    "typescript": "5.9.3"
  }
}
JSON
  local resolution_line=""
  if [[ -n "${resolution}" ]]; then
    resolution_line="\"moduleResolution\": \"${resolution}\","
  fi
  cat >"${dir}/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "module": "${module}",
    ${resolution_line}
    "target": "ES2023",
    "lib": ["ES2023", "esnext.disposable"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": false,
    "types": ["jest", "node"],
    "noEmit": true
  },
  "include": ["src"]
}
JSON
  printf '%s\n' "${CONSUMER_TS}" >"${dir}/src/consumer.ts"
  if [[ "${type}" == "module" && "${resolution}" == "nodenext" ]]; then
    printf '%s' "${SPEC_TS}" | sed "s#'./consumer'#'./consumer.js'#" >"${dir}/src/consumer.spec.ts"
  else
    printf '%s' "${SPEC_TS}" >"${dir}/src/consumer.spec.ts"
  fi
  cat >"${dir}/jest.config.js" <<'JS'
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
};
JS
  # jest 30.5+ тянет @parcel/watcher с install-скриптом; pnpm 11+ без решения отказывает в установке.
  cat >"${dir}/pnpm-workspace.yaml" <<'YAML'
packages:
  - '.'
allowBuilds:
  '@parcel/watcher': false
YAML
  (cd "${dir}" && pnpm install --prefer-offline --silent >"${dir}/install.log" 2>&1) || {
    echo "${label}: установка не прошла"; tail -5 "${dir}/install.log"; failures=$((failures + 1)); return
  }
  if (cd "${dir}" && node_modules/.bin/tsc -p tsconfig.json >"${dir}/tsc.log" 2>&1); then
    echo "${label}: tsc — зелёный"
  else
    echo "${label}: tsc — КРАСНЫЙ"; head -8 "${dir}/tsc.log"; failures=$((failures + 1))
  fi
  if [[ "${type}" == "module" ]]; then
    (cd "${dir}" && node --input-type=module -e "${RUNTIME_ESM}" "${NAMES_JSON}" >"${dir}/runtime.log" 2>&1) && ok=1 || ok=0
  else
    (cd "${dir}" && node --input-type=commonjs -e "${RUNTIME_CJS}" "${NAMES_JSON}" >"${dir}/runtime.log" 2>&1) && ok=1 || ok=0
  fi
  if [[ "${ok}" == 1 ]]; then
    echo "${label}: рантайм ${#ENTRIES[@]} входов — зелёный"
  else
    echo "${label}: рантайм входов — КРАСНЫЙ"; head -5 "${dir}/runtime.log"; failures=$((failures + 1))
  fi
  if [[ "${jest}" == "jest" ]]; then
    if (cd "${dir}" && node_modules/.bin/jest --maxWorkers=2 >"${dir}/jest.log" 2>&1); then
      echo "${label}: ts-jest — зелёный ($(grep -E '^Tests:' "${dir}/jest.log"))"
    else
      echo "${label}: ts-jest — КРАСНЫЙ"; grep -E 'TS[0-9]+|Tests:' "${dir}/jest.log" | head -5; failures=$((failures + 1))
    fi
  fi
}

run_case commonjs commonjs node10 commonjs jest
run_case node16 node16 node16 commonjs jest
run_case nodenext nodenext nodenext commonjs jest
run_case bundler-esm esnext bundler module tsc-only
run_case nodenext-esm nodenext nodenext module tsc-only

if [[ "${failures}" -gt 0 ]]; then
  echo "матрица потребителей: красных ${failures}"
  exit 1
fi
echo "матрица потребителей: все зелёные"
