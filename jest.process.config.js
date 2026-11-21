/**
 * Спеки процессов (`src/process/*.spec.ts`): код, который шлёт сигналы, —
 * только в одноразовом Linux-контейнере (`scripts/in-linux-container.sh`,
 * запуск — `pnpm run test:process`). На хосте их не запускает ни
 * `pnpm test`, ни прямой jest: основной конфиг исключает каталог.
 */
const base = require('./jest.config.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  roots: ['<rootDir>/src/process'],
  testPathIgnorePatterns: ['/node_modules/', '\\.docker\\.spec\\.ts$'],
  testTimeout: 30000,
};
