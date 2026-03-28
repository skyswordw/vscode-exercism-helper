import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'src/test/__mocks__/vscode.ts'),
    },
  },
});
