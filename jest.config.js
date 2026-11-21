/**
 * Полный набор запускается ТОЛЬКО через `pnpm test` (jest-groups: группы
 * ≤300 тестов, ≤2 воркера, последовательно). Прямой `jest` — для одного-двух
 * файлов и тоже с --maxWorkers=2.
 *
 * Примитивы пакета НАМЕРЕННО производят зависания (замёрзший прокси, молчащий
 * DNS, пауза Redis, держатели транзакций). Поэтому у каждой спеки потолок
 * (`testTimeout`, длинные — со своим), а `forceExit` не даёт забытому хэндлу
 * держать процесс после прогона. Утечки хэндлов при этом не прячутся: их
 * ловят спеки ресурсов (сравнение `process.getActiveResourcesInfo()` до и
 * после `close()`), а не ожидание выхода jest.
 *
 * Спеки `src/process/` шлют сигналы процессам и идут ТОЛЬКО в одноразовом
 * Linux-контейнере (`pnpm run test:process`, конфиг jest.process.config.js):
 * здесь каталог исключён, и прямой jest на хосте их не запустит.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.docker\\.spec\\.ts$', '<rootDir>/src/process/'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
  testTimeout: 15000,
  forceExit: true,
  clearMocks: true,
  restoreMocks: true,
};
