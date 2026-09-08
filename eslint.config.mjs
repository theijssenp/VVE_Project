// ESLint flat config — VvE-monorepo (F01).
//
// Type-aware linting over de hele workspace via `projectService`, zonder een statische
// `parserOptions.project`-lijst (stabiel met npm workspaces + cross-pakket imports).
// Config-/build-bestanden die buiten elk tsconfig vallen (deze config, de vitest-config)
// staan in `ignores` en hoeven dus geen defaultproject. Zie docs/besluiten.md.
import js from '@eslint/js';
import * as tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Geen code buiten de workspaces wordt gelint (config, CI, docs, eigen eslint/vitest-config).
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '.github/**',
      'docs/**',
      'infra/**',
      '*.config.js',
      '*.config.mjs',
      '*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // strictTypeChecked is al een flat-config-array; spread de typed-regels rechtstreeks in.
  ...tseslint.configs.strictTypeChecked,
  {
    // NestJS @Module/@Injectable-klasse zijn via decorators gevuld;
    // no-extraneous-class kan dit niet detecteren en is hier een false positive.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // projectService: type-aware zonder per-project tsconfig handmatig op te noemen.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
    },
    rules: {
      // Spec §7.1: geen `any` zonder expliciete onderbouwing in commentaar.
      '@typescript-eslint/no-explicit-any': 'error',
      // Prettier beziet styling; laat ESLint niet ook formatterings-regels afdwingen.
      '@typescript-eslint/naming-convention': 'off',
    },
  },
  {
    // Harde regel uit spec §7.2: `packages/domein` is PURE TypeScript —
    // geen NestJS, geen databaseclient, geen Date.now()/new Date()/fetch.
    // Geeforceerd met ESLint, niet met "goede voornemens".
    files: ['packages/domein/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/core',
              message: 'packages/domein is NestJS-vrij (spec §7.2).',
            },
            {
              name: '@nestjs/common',
              message: 'packages/domein is NestJS-vrij (spec §7.2).',
            },
            {
              name: 'drizzle-orm',
              message: 'packages/domein houdt geen databaseclient (spec §7.2).',
            },
            {
              name: 'pg',
              message: 'packages/domein houdt geen databaseclient (spec §7.2).',
            },
            {
              name: 'postgres',
              message: 'packages/domein houdt geen databaseclient (spec §7.2).',
            },
          ],
          patterns: [
            {
              group: ['@nestjs/*'],
              message: 'packages/domein is NestJS-vrij (spec §7.2).',
            },
            {
              group: ['drizzle-orm*'],
              message: 'packages/domein houdt geen databaseclient (spec §7.2).',
            },
          ],
        },
      ],
      // Date/fetch zijn runtime-globals; ban ze als waarden maar laat type-gebruik
      // (`: Date`) staan — dat behoudt de Klok-abstractie (spec §7.3) voor F05.
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'Geen Date in packages/domein: injecteer een Klok (spec §7.3, §7.2).',
        },
        {
          name: 'fetch',
          message: 'Geen netwerk-I/O in packages/domein (spec §7.2).',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CallExpression[callee.object.name="Date"]',
          message:
            'Geen Date.now()/Date.parse() in packages/domein; gebruik een geïnjecteerde Klok.',
        },
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: 'Geen new Date() in packages/domein; gebruik een geïnjecteerde Klok.',
        },
      ],
    },
  },
);
