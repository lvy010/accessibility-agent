const assert = require('node:assert/strict');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { createRequire } = require('node:module');

async function main() {
  // Resolve from the extracted VSIX, never from the source tree's node_modules.
  const root = process.argv[2];
  const requireFromPackage = createRequire(path.join(root, 'package.json'));
  const { chromium } = requireFromPackage('playwright-core');
  const candidates = [
    process.env.A11Y_TEST_BROWSER_PATH, chromium.executablePath(),
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [
      path.join(process.env[key], 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env[key], 'Google/Chrome/Application/chrome.exe'),
    ] : []),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  const executablePath = candidates.find(candidate => candidate && existsSync(candidate));
  assert.ok(executablePath, 'Install a browser before running the release gate');
  const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 20_000 });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html lang="zh-CN"><head><title>VSIX 检查</title></head><body><button>提交</button></body></html>');
    assert.equal(await page.getByRole('button', { name: '提交' }).count(), 1);
    console.log(`PASS: Packaged Playwright launches real Chromium ${browser.version()} and queries accessible roles.`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });