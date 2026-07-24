// ESLint flat config (Constitution §2). Custom rules live in tools/eslint-plugin-ledge.
import tseslint from 'typescript-eslint';
import ledge from 'eslint-plugin-ledge';

export default tseslint.config(
  { ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'docs/governance/**', 'ops/fixtures/**'] },
  ...tseslint.configs.strict,
  {
    rules: {
      // §2 Logging — no console outside diagnostics internals
      'no-console': ['error', { allow: [] }],
      // §2 Magic numbers — banned outside tests/fixtures (catalogs exempt below)
      'no-magic-numbers': [
        'error',
        { ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreDefaultValues: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // P-07 No hidden behavior — forbid network APIs anywhere (egress pair-guarded in scripts/egress-guard)
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Egress is forbidden (A-10).' }, { name: 'XMLHttpRequest', message: 'Egress is forbidden (A-10).' }, { name: 'WebSocket', message: 'Egress is forbidden (A-10).' }, { name: 'EventSource', message: 'Egress is forbidden (A-10).' }],
    },
  },
  {
    files: ['src/**', 'entrypoints/**'],
    plugins: { ledge },
    rules: {
      'ledge/no-commented-code': 'error',
      'ledge/registry-purity': 'error',
    },
  },
  {
    // Overriding permissive zones: tests + fixtures may use literals freely (Constitution §13 softened rules)
    files: ['ops/tests/**', '**/*.test.ts', '**/*.spec.ts', 'scripts/**', 'tools/**'],
    rules: {
      'no-magic-numbers': 'off',
      'no-console': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    // Catalog/registry files are data tables (P-08); literals allowed, functions forbidden (registry-purity enforces)
    files: ['**/*.catalog.ts', '**/*.registry.ts', '**/copy/**'],
    rules: { 'no-magic-numbers': 'off' },
  },
  {
    // Diagnostics internals are allowed console-style sinks via their own port only
    files: ['src/infrastructure/diagnostics/**'],
    rules: { 'no-console': 'off' },
  },
);
