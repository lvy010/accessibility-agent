import { context, build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// axe-core and zod are bundled; retain their upstream licenses in the VSIX.
const notices = await Promise.all(['axe-core', 'zod', 'playwright-core'].map(async name => {
  const root = new URL(`./node_modules/${name}/`, import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const license = await readFile(new URL('LICENSE', root), 'utf8');
  return `===== ${name}@${metadata.version} (${metadata.license}) =====\n${license}`;
}));
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/THIRD_PARTY_NOTICES.txt', import.meta.url), notices.join('\n\n'));

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode', 'playwright-core'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
};
if (process.argv.includes('--watch')) {
  await (await context(options)).watch();
} else {
  await build(options);
}