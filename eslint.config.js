// ESLint flat config (Constitution §2) — post-audit executable edition.
// Import-graph law lives in .dependency-cruiser.cjs. This file enforces what an import
// graph structurally cannot see: ambient globals (chrome, network), determinism,
// copy sourcing, and repo hygiene rules. Each scoped block names the audit probe it closes.
import tseslint from 'typescript-eslint';
import ledge from 'eslint-plugin-ledge';

// A-10: no network primitives as bare globals, anywhere.
const NO_NETWORK_GLOBALS = [
  { name: 'fetch', message: 'Egress is forbidden (A-10).' },
  { name: 'XMLHttpRequest', message: 'Egress is forbidden (A-10).' },
  { name: 'WebSocket', message: 'Egress is forbidden (A-10).' },
  { name: 'EventSource', message: 'Egress is forbidden (A-10).' },
];

// A-02 (audit probe P8): the ambient `chrome` global is invisible to dependency-cruiser —
// containment can only be enforced here. Adapters (infrastructure/chrome) and composition
// roots (src/roots) are the only files allowed to touch it.
const CHROME_BANNED = {
  name: 'chrome',
  message:
    'A-02: Chrome APIs live only in src/infrastructure/chrome adapters and src/roots composition files.',
};

const member = (obj, prop) =>
  `CallExpression[callee.type="MemberExpression"][callee.object.name="${obj}"][callee.property.name="${prop}"]`;

// ADR-004 (audit probe P11): pure layers never read the wall clock or entropy directly.
const DETERMINISM_BANS = [
  {
    selector: member('Date', 'now'),
    message: 'No wall-clock reads in pure layers — time enters via the HLC clock input (ADR-004).',
  },
  {
    selector: 'NewExpression[callee.name="Date"]',
    message: 'No wall-clock construction in pure layers (ADR-004).',
  },
  {
    selector: member('Math', 'random'),
    message: 'No unseeded entropy in pure layers — use identity/entropy ports.',
  },
  {
    selector: member('crypto', 'randomUUID'),
    message:
      'No unseeded entropy in pure layers — entropy lives in src/shared-kernel/identity only.',
  },
  { selector: member('performance', 'now'), message: 'No timing reads in pure layers (ADR-004).' },
];

// A-10 (audit probe P10): member-access forms — self.fetch(...), globalThis.fetch(...),
// new window.WebSocket(...) — must not bypass the bare-global ban.
const EGRESS_MEMBER_BANS = [
  {
    selector:
      'CallExpression[callee.type="MemberExpression"][callee.property.type="Identifier"][callee.property.name=/^(fetch|sendBeacon)$/]',
    message: 'Egress is forbidden (A-10) — member access does not bypass the ban.',
  },
  {
    selector:
      'NewExpression[callee.type="MemberExpression"][callee.property.type="Identifier"][callee.property.name=/^(WebSocket|EventSource|XMLHttpRequest)$/]',
    message: 'Egress is forbidden (A-10).',
  },
];

export default tseslint.config(
  {
    ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'docs/governance/**', 'ops/fixtures/**'],
  },
  ...tseslint.configs.strict,
  {
    rules: {
      // Audit P0-2: the previous ['error', { allow: [] }] form was schema-invalid and crashed every lint run.
      'no-console': 'error',
      // §2 Magic numbers — named const is the sanctioned escape hatch (const initializers are exempt by rule design).
      'no-magic-numbers': [
        'error',
        { ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreDefaultValues: true },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // P-07 No hidden behavior — bare network globals forbidden everywhere.
      'no-restricted-globals': ['error', ...NO_NETWORK_GLOBALS],
    },
  },
  {
    // A-02 chrome containment (audit P1-G1, probe P8).
    // NOTE (post-audit lesson): flat config does NOT support "!" negation inside `files`
    // arrays — such blocks silently turn match-all (verified empirically 2026-07-24).
    // Exclusions always go in the block's own `ignores` array.
    files: ['src/**/*.ts'],
    ignores: ['src/infrastructure/chrome/**', 'src/roots/**'],
    rules: { 'no-restricted-globals': ['error', ...NO_NETWORK_GLOBALS, CHROME_BANNED] },
  },
  {
    // A-10 egress via member access (audit P1-G4, probe P10).
    files: ['src/**/*.ts', 'entrypoints/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...EGRESS_MEMBER_BANS] },
  },
  {
    // ADR-004 determinism, domain layer (audit P1-G2, probe P11).
    files: ['src/domain/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...DETERMINISM_BANS] },
  },
  {
    // ADR-004 determinism, kernel — except src/shared-kernel/identity, the sanctioned entropy factory.
    files: ['src/shared-kernel/**/*.ts'],
    ignores: ['src/shared-kernel/identity/**'],
    rules: { 'no-restricted-syntax': ['error', ...DETERMINISM_BANS] },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'entrypoints/**/*.{ts,tsx}'],
    plugins: { ledge },
    rules: {
      'ledge/no-commented-code': 'error',
      'ledge/registry-purity': 'error',
    },
  },
  {
    // §2 copy law (audit P1-G6): surfaces render catalog keys, never inline copy.
    files: ['src/surfaces/**/*.ts'],
    ignores: ['src/surfaces/components/copy/**'],
    plugins: { ledge },
    rules: { 'ledge/no-raw-copy': 'error' },
  },
  {
    // EES §9.16 + ADR-025 (E1-T12): composition roots are wiring-only — their value
    // exports are bootstrap*/compose* factories and nothing else.
    files: ['src/roots/**/*.ts'],
    ignores: ['src/roots/**/*.test.ts'],
    plugins: { ledge },
    rules: { 'ledge/roots-composition': 'error' },
  },
  {
    // Permissive zones: tests + tooling may use literals, console, ambient globals freely.
    files: ['ops/tests/**', '**/*.test.ts', '**/*.spec.ts', 'scripts/**', 'tools/**'],
    rules: {
      'no-magic-numbers': 'off',
      'no-console': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
      'ledge/no-raw-copy': 'off',
    },
  },
  {
    // Catalog/registry files are data tables (P-08); literals allowed, logic forbidden (registry-purity enforces).
    files: ['**/*.catalog.ts', '**/*.registry.ts', '**/copy/**'],
    rules: { 'no-magic-numbers': 'off' },
  },
  {
    // Diagnostics internals may use console-style sinks via their own port only.
    files: ['src/infrastructure/diagnostics/**'],
    rules: { 'no-console': 'off' },
  },
);
