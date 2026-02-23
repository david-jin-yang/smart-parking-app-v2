/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          // Override for test environment — CommonJS, loose
          module: 'commonjs',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  // Exclude Next.js internals from test runs
  testPathIgnorePatterns: ['/node_modules/', '/.next/'],
  // Surface slow tests
  slowTestThreshold: 5,
}
