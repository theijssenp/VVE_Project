import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Alle workspaces delen één Vitest-run. Workspace-pakketten worden van de source
// opgelost, zodat tests niet eerst een `build` vereisen (F01-fundament, spec §7.2).
export default defineConfig({
  resolve: {
    alias: {
      '@vve/contract': resolve(import.meta.dirname, 'packages/contract/src/index.ts'),
      '@vve/domein': resolve(import.meta.dirname, 'packages/domein/src/index.ts'),
    },
  },
  test: {
    include: [
      'apps/**/*.spec.ts',
      'apps/**/*.e2e-spec.ts',
      'packages/**/*.spec.ts',
      'packages/**/*.test.ts',
    ],
    environment: 'node',
    // Testomgeving: productie eist deze sleutels uit de omgeving en heeft bewust
    // geen standaardwaarde. Hier staan ze zodat de suite zonder .env draait.
    env: {
      KOLOM_SLEUTEL: 'test-kolomsleutel-uitsluitend-voor-de-testsuite',
    },
  },
  // NestJS gebruikt decorators en reflectie-metadata;
  // zonder deze flags wordt de DI-container / route-registering onvolledig (404).
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    },
  },
});
