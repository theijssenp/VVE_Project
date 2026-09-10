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
// ---------------------------------------------------------------------------
// Eigen regels: geen rekenkunde op centvelden (F05, §7.3) en beveiligings-
// wachters (F12, spec §7.6/§8.5). De plugin "vve" wordt één keer gedefinieerd
// en in beide config-blokken hergebruikt — ESLint staat geen herdefinitie toe.
// ---------------------------------------------------------------------------
const CENT_NAAM = /(_cent|_centen|Centen?)$/;

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
// Cent-rekenkunde: blokkeert de geldlaag niet (zie ignores hieronder — de
// uitzondering op dit blok is een aparte blokkade in de beveiligingsconfig).
const centRekenKundeConfig = {
  files: ['**/*.ts'],
  ignores: ['packages/domein/src/financieel/**'],
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
    // Angular-componenten hebben net zo goed een lege body met alleen decorators.
    files: ['apps/api/**/*.ts', 'apps/app/**/*.ts'],
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

// De default-export staat aan het einde van dit bestand (na de F12-wachters).

// ---------------------------------------------------------------------------
// F12 (spec §7.6, §8.5): beveiligingswachters tegen zwakke geheimen.
//   1. `Math.random` verboden buiten *.spec.ts — CSPRNG (randomBytes) of een
//      geïnjecteerde bron; Math.random is niet cryptografisch.
//   2. `===`/`!==` op velden met token/hash in de naam — string-vergelijking
//      lekt timing; gebruik constante-tijd-vergelijking.
//   3. Niet-variabele IV bij createCipheriv — een vaste IV maakt AES-CBC/GCM
//      deterministisch en daarmee patroon-zichtbaar in de ciphertext.
//   4. Geen secret in log- of auditpaden: een identifier die met secret/
//      wachtwoord/sleutel begint gaat niet door console/log/audit-functies.
// ---------------------------------------------------------------------------
const specBestand = (bestand) => /\.spec\.ts$|\.test\.ts$/.test(bestand);

const beveiligingsRegel = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Beveiligingswachters: Math.random, timing-ongelijke hashvergelijking, vaste IV, secrets in logs (F12).',
    },
    schema: [],
    messages: {
      mathRandom:
        'Math.random is niet cryptografisch; gebruik node:crypto (randomBytes/getRandomValues) — testbestanden uitgezonderd.',
      timingVergelijking:
        'Vergelijk tokens/hashes niet met ===: dat is niet constant-tijd. Gebruik crypto.timingSafeEqual of een domeinfunctie.',
      vasteIv:
        'De IV bij createCipheriv moet per versleuteling nieuw en willekeurig zijn; een letterlijke of constante IV maakt de versleuteling deterministisch en onveilig.',
      secretInLog:
        'Geen secret/wachtwoord/sleutel door een log- of auditpad: dit lekt geheimen naar de logs (spec §8.2).',
    },
  },
  create(context) {
    const bestand = context.filename;
    return {
      CallExpression(node) {
        const callee = node.callee;
        // 1. Math.random buiten tests:
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'Math' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'random' &&
          !specBestand(bestand)
        ) {
          context.report({ node, messageId: 'mathRandom' });
        }
        // 2. createCipheriv met een niet-variabele IV (tweede argument):
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'createCipheriv' &&
          node.arguments.length >= 3
        ) {
          const iv = node.arguments[2];
          if (
            iv.type === 'Literal' ||
            (iv.type === 'TemplateLiteral' && iv.expressions.length === 0)
          ) {
            context.report({ node, messageId: 'vasteIv' });
          }
        }
        // 3. Secrets in log-functies (vierde wachter):
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          ['log', 'info', 'warn', 'error', 'debug'].includes(callee.property.name) &&
          callee.object.type === 'Identifier' &&
          ['console', 'log', 'logboek', 'auditschrijver'].includes(callee.object.name)
        ) {
          for (const argument of node.arguments) {
            const naam = argument.type === 'Identifier' ? argument.name : null;
            if (naam && /(secret|wachtwoord|sleutel)/i.test(naam)) {
              context.report({ node, messageId: 'secretInLog' });
            }
          }
        }
      },
      BinaryExpression(node) {
        // 2. === op token/hash-velden (niet in tests). False positives
        // uitsluiten: vergelijkingen met null/undefined zijn bereik-checks
        // (bestaat de waarde?), geen geheimvergelijking.
        if (['===', '!=='].includes(node.operator) && !specBestand(bestand)) {
          for (const kant of [node.left, node.right]) {
            const naam = kant.type === 'Identifier' ? kant.name : null;
            if (naam && /(token|hash)/i.test(naam)) {
              const andereKant = kant === node.left ? node.right : node.left;
              // Null/undefined-checks zijn bereikvragen (bestaat de waarde?),
              // geen geheimvergelijking — die worden niet gevlagd.
              const isNulCheck =
                andereKant.type === 'Literal' ||
                (andereKant.type === 'Identifier' && andereKant.name === 'undefined');
              if (!isNulCheck) {
                context.report({ node, messageId: 'timingVergelijking' });
                return;
              }
            }
          }
        }
      },
    };
  },
};

function isNietVariabel(node) {
  return !(node.type === 'Identifier' && /(iv|nonce|salt|willekeurig|willekeur)/i.test(node.name));
}

// Beide eigen regels hangen aan één plugin-instantie: ESLint staat geen
// herdefinitie van een plugin over config-blokken binnen één run toe. De
// ignores die per regel verschillen (F05: de geldlaag; F12: testbestanden)
// zitten op de rules-instandhouding via twee aparte blokken die dezelfde
// plugin hergebruiken.
const vvePlugin = {
  rules: {
    'cent-rekenkunde': centRekenVerbod,
    beveiligingswachters: beveiligingsRegel,
  },
};

export default [
  ...basisConfig,
  {
    files: ['**/*.ts'],
    ignores: ['packages/domein/src/financieel/**'],
    plugins: { vve: vvePlugin },
    rules: { 'vve/cent-rekenkunde': 'error' },
  },
  {
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.test.ts'],
    plugins: { vve: vvePlugin },
    rules: { 'vve/beveiligingswachters': 'error' },
  },
];
