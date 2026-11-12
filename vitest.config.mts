import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@cloak/config': path.join(rootDir, 'packages/config/src/index.ts'),
      '@cloak/protocol': path.join(rootDir, 'packages/protocol/src/index.ts'),
      '@cloak/crypto': path.join(rootDir, 'packages/crypto/src/index.ts'),
      '@cloak/archive': path.join(rootDir, 'packages/archive/src/index.ts'),
      '@cloak/ui': path.join(rootDir, 'packages/ui/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
    ],
    testTimeout: 30_000,
  },
});

