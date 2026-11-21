/**
 * README examples (`examples/*.spec.ts`) run against real Postgres and Redis through the same
 * package source the README imports by name. `examples/process.spec.ts` sends signals to
 * processes, so it runs only inside a throwaway Linux container (`FAULT_KIT_IN_CONTAINER=1`,
 * `pnpm run test:examples:process`), never on a developer machine.
 * Run: `pnpm run test:examples` (grouped, ≤2 workers).
 */
const inContainer = process.env.FAULT_KIT_IN_CONTAINER === '1';
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/examples'],
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: inContainer ? ['/node_modules/'] : ['/node_modules/', '<rootDir>/examples/process\\.spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.examples.json' }] },
  moduleNameMapper: {
    '^@hoshinotatsuya/fault-kit$': '<rootDir>/src/index.ts',
    '^@hoshinotatsuya/fault-kit/(tcp|dns|postgres|redis|process)$': '<rootDir>/src/$1/index.ts',
  },
  maxWorkers: 2,
  testTimeout: 15000,
  forceExit: true,
};
