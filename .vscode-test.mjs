import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/suite/**/*.test.js',
  version: 'stable',
  mocha: { timeout: 60000, ui: 'bdd' }
});
