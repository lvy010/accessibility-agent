const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { build } = require('esbuild');
const { runTests } = require('@vscode/test-electron');
const { extractPackage } = require('./package.cjs');

async function main() {
  const root = path.resolve(__dirname, '../..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-extension-test-'));
  const workspace = path.join(temporary, 'workspace');
  const suite = path.join(root, '.vscode-test/build/suite.cjs');
  try {
    await fs.mkdir(workspace);
    let extensionDevelopmentPath = root;
    if (process.argv.includes('--vsix')) {
      const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      const vsix = process.env.VSIX_PATH ? path.resolve(process.env.VSIX_PATH) : path.join(root, `${metadata.name}-${metadata.version}.vsix`);
      extensionDevelopmentPath = await extractPackage(vsix, path.join(temporary, 'package'));
      const smoke = spawnSync(process.execPath, [path.join(__dirname, 'packaged-browser.cjs'), extensionDevelopmentPath], {
        cwd: extensionDevelopmentPath, stdio: 'inherit', timeout: 60_000,
      });
      if (smoke.error) throw smoke.error;
      if (smoke.status !== 0) throw new Error(`Packaged browser smoke test failed: ${smoke.status}`);
    }
    await build({ entryPoints: [path.join(__dirname, 'suite.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: suite });
    const runId = randomUUID();
    const resultFile = path.join(temporary, 'host-result.json');
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || '1.95.3',
      extensionDevelopmentPath,
      extensionTestsPath: suite,
      extensionTestsEnv: { A11Y_TEST_RUN_ID: runId, A11Y_TEST_RESULT: resultFile, A11Y_TEST_NODE: process.execPath },
      // Disable Trust enforcement only in this isolated test profile (isTrusted === true).
      launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        '--user-data-dir', path.join(temporary, 'user-data'), '--extensions-dir', path.join(temporary, 'extensions')],
    });
      // Electron can exit 0 without ever starting the suite (for example, a Windows mutex collision).
      const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
      assert.equal(result.runId, runId, 'Extension Host must complete this exact test invocation');
      assert.equal(path.resolve(result.extensionPath), path.resolve(extensionDevelopmentPath));
      assert.equal(result.completed, true);
      console.log(`PASS: Verified Extension Host completion marker, VS Code ${result.vscodeVersion}; ${result.modelCases} model cases and ${result.taskCases} real task cases.`);
  } finally {
    try { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5 }); }
    catch (error) {
      // Windows may retain Electron handles after process exit. Never mask a test failure or kill user processes.
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      console.warn(`Temporary test directory remains locked (${error.code}); safe to remove after test processes exit: ${temporary}`);
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });