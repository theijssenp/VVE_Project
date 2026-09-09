// ESLint flat config — VvE-monorepo (F01 + F05).
//
// Type-aware linting over de hele workspace via `projectService`, zonder een statische
// `parserOptions.project`-lijst (stabiel met npm workspaces + cross-pakket imports).
// Config-/build-bestanden die buiten elk tsconfig vallen (deze config, de vitest-config)
// staan in `ignores` en hoeven dus geen defaultproject. Zie docs/besluiten.md.
//
// F05 voegt de cent-rekenkunderegel toe (spec §7.3): rekenkundige operatoren zijn
// verboden op velden waarvan de naam op `_cent`/`_centen`/`Cent` eindigt. TypeScript
// kan `a + b` op `number` niet blokkeren met het typesysteem alleen; deze regel is wat
// `Bedrag` afdwingbaar maakt in plaats van een suggestie.
import js from '@eslint/js';
import * as tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------
// Eigen regel: geen rekenkunde op centvelden (F05, spec §7.3).
// ---------------------------------------------------------------------------
// `Centen?` matchte "Cente"/"Centen" maar NIET "Cent" — juist de vorm die het
// Drizzle-schema gebruikt (herbouwwaardeCent, bedragCent, exploitatieCent).
const CENT_NAAM = /(_cent(en)?|Cent(en)?)$/;

const centRekenVerbod = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Geen rekenkundige operatoren op geldvelden (_cent/_centen/Cent): reken via Bedrag (spec §5.1, §7.3).',
    },
    schema: [],
    messages: {
      centRekenkunde:
        'Reken nooit direct met centen: gebruik het Bedrag-waardetype (spec §7.3). Ruwe centenrekenkunde verbergt afrondfouten en overflow.',
    },
  },
  create(context) {
    function meld(node, naam) {
      context.report({ node, messageId: 'centRekenkunde', data: { naam } });
    }
    function linkerNaam(kant) {
      if (kant.type === 'Identifier' && kant.name) return kant.name;
      if (
        kant.type === 'MemberExpression' &&
        !kant.computed &&
        kant.property &&
        !kant.property.computed &&
        kant.property.name
      ) {
        return kant.property.name;
      }
      return null;
    }
    return {
      BinaryExpression(node) {
        if (!['+', '-', '*', '/', '%'].includes(node.operator)) return;
        const naam = meldbareNaam(node.left, node.right);
        if (naam) meld(node, naam);
      },
      AssignmentExpression(node) {
        if (!['+=', '-=', '*=', '/=', '%='].includes(node.operator)) return;
        const naam = meldbareNaam(node.left);
        if (naam) meld(node, naam);
      },
      UpdateExpression(node) {
        const naam = meldbareNaam(node.argument);
        if (naam) meld(node, naam);
      },
    };

    function meldbareNaam(...knopen) {
      for (const k of knopen) {
        if (!k) continue;
        if (k.type === 'Identifier' && CENT_NAAM.test(k.name)) return k.name;
        if (
          k.type === 'MemberExpression' &&
          !k.computed &&
          k.property &&
          !k.property.computed &&
          k.property.name &&
          CENT_NAAM.test(k.property.name)
        ) {
          return k.property.name;
        }
      }
      return null;
    }
  },
};

// De regel geldt overal, behalve de geldlaag zelf (Bedrag/Verdeler-implementatie
// en hun tests) — dát is de plek waar de centen wél bewust worden gedaan.
const centRekenKundeConfig = {
  files: ['**/*.ts'],
  ignores: ['packages/domein/src/financieel/**'],
  plugins: { vve: { rules: { 'cent-rekenkunde': centRekenVerbod } } },
  rules: { 'vve/cent-rekenkunde': 'error' },
};

// ---------------------------------------------------------------------------
// Basisconfig (F01, ongewijzigd overgenomen).
// ---------------------------------------------------------------------------
const basisConfig = tseslint.config(
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
      'apps/api/drizzle.config.ts',
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
      // Prettier bezorgt styling; laat ESLint niet ook formatterings-regels afdwingen.
      '@typescript-eslint/naming-convention': 'off',
    },
  },
  {
    // Harde regel uit spec §7.2: `packages/domein` is PURE TypeScript —
    // geen NestJS, geen databaseclient, geen Date.now()/new Date()/fetch.
    // Geeforceerd met ESLint, niet met "goede voornemens".
    //
    // Uitzondering: *.spec.ts in de domeinpackages — een testklok móét een
    // concrete Date kunnen maken; de verboden gelden op de productiecode.
    files: ['packages/domein/**/*.ts'],
    ignores: ['packages/domein/**/*.spec.ts'],
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
      // (`: Date`) staan — dat behoudt de Klok-abstractie (spec §7.3).
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

export default [...basisConfig, centRekenKundeConfig];
