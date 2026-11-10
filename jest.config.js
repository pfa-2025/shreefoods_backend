/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts', // refuses to run against a remote database
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  maxWorkers: 1, // e2e suites share one database and mutate the same seed rows
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
};
