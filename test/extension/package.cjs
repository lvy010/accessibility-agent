const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const yauzl = require('yauzl');

async function extractPackage(vsix, destination) {
  const archive = await yauzl.openPromise(vsix, { strictFileNames: true });
  const names = new Set();
  let total = 0;
  try {
    for await (const entry of archive.eachEntry()) {
      assert.ok(!names.has(entry.fileName), 'No duplicate ZIP entries');
      names.add(entry.fileName);
      const target = path.resolve(destination, entry.fileName);
      const relative = path.relative(destination, target);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'No ZIP path traversal');
      assert.ok(!entry.fileName.includes(':') && ((entry.externalFileAttributes >>> 16) & 0xf000) !== 0xa000, 'No alternate streams or symlinks');
      total += entry.uncompressedSize;
      assert.ok(total < 150 * 1024 * 1024, 'Package exceeds test extraction limit');
      if (entry.fileName.endsWith('/')) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(await archive.openReadStreamPromise(entry), createWriteStream(target, { flags: 'wx' }));
    }
  } finally { archive.close(); }
  for (const required of [
    'extension/package.json', 'extension/dist/extension.js', 'extension/dist/THIRD_PARTY_NOTICES.txt',
    'extension/media/accessibility.svg', 'extension/media/dashboard.js', 'extension/media/dashboard.css',
    'extension/node_modules/playwright-core/package.json', 'extension/node_modules/playwright-core/index.js',
    'extension/node_modules/playwright-core/browsers.json', 'extension/node_modules/playwright-core/LICENSE',
    'extension/node_modules/playwright-core/ThirdPartyNotices.txt',
  ]) assert.ok(names.has(required), `Missing package file: ${required}`);
  for (const name of names) {
    assert.ok(!/^extension\/(?:src|test|execution-logs|\.git|\.vscode-test)\//.test(name), `Unwanted development data: ${name}`);
    assert.ok(!/(?:^|\/)\.env(?:\.|$)/.test(name), `Sensitive configuration: ${name}`);
    if (name.startsWith('extension/node_modules/')) {
      assert.ok(name.startsWith('extension/node_modules/playwright-core/'), `Unexpected unbundled dependency: ${name}`);
    }
  }
  const root = path.join(destination, 'extension');
  const requireFromPackage = createRequire(path.join(root, 'package.json'));
  const resolved = requireFromPackage.resolve('playwright-core');
  assert.ok(resolved.startsWith(root + path.sep), 'Runtime must resolve inside the package, not the development workspace');
  const notices = await fs.readFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const name of ['axe-core', 'zod', 'playwright-core']) assert.ok(notices.includes(`${name}@`));
  const checksum = createHash('sha256').update(await fs.readFile(vsix)).digest('hex');
  console.log(`PASS: VSIX contents (${names.size} entries), licenses and isolated runtime resolution. SHA256 ${checksum}`);
  return root;
}

module.exports = { extractPackage };