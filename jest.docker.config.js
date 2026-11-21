/**
 * Спеки в контейнере (`*.docker.spec.ts`): getaddrinfo с DNS контейнера,
 * таблица процессов Linux. Нужны docker и собранный `dist` — запуск
 * `pnpm run test:docker` (сборка, затем jest-groups). Потолок теста — с
 * запасом на старт контейнера.
 */
const base = require('./jest.config.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: ['**/*.docker.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 120000,
};
