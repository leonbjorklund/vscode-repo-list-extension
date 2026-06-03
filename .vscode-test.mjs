import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: ['--disable-extensions'],
  mocha: { timeout: 20000, ui: 'tdd' }
});
