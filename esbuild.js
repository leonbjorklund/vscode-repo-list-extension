const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'warning'
};

async function main() {
  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    return;
  }

  await esbuild.build(options);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
