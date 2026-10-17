import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
};

const jestGlobals = {
  global: 'readonly',
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  jest: 'readonly',
};

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_?' }],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.test.js'],
    languageOptions: {
      globals: { ...nodeGlobals, ...jestGlobals },
    },
  },
  {
    ignores: ['node_modules/', 'dist/', '*.config.js'],
  },
];
