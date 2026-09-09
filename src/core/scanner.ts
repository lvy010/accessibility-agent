import { existsSync } from 'node:fs';
import path from 'node:path';
import axe from 'axe-core';
import { chromium } from 'playwright-core';

export const ruleTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export interface ScanResult {
  url: string;
  engine: string;
  ruleTags: string[];
  counts: { violations: number; incomplete: number; passes: number; inapplicable: number };
  issues: { id: string; status: 'violation' | 'incomplete'; impact: string | null; description: string; targets: string[] }[];
  blockedRequests: number;
  truncated: boolean;
}

export function validateUrl(input: string): URL {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持不含账号密码的 HTTP(S) 页面地址。');
  }
  return url;
}

export function displayUrl(input: string): string {
  const url = validateUrl(input);
  return `${url.origin}${url.pathname}`;
}

export function requestAllowed(url: string, method: string, origins: Set<string>): boolean {
  try { return ['GET', 'HEAD'].includes(method) && origins.has(validateUrl(url).origin); } catch { return false; }
}

export function findBrowser(configured = ''): string {
  if (configured) {
    if (!path.isAbsolute(configured) || !existsSync(configured)) throw new Error('配置的浏览器路径不存在或不是绝对路径。');
    return configured;
  }
  const candidates = [
    chromium.executablePath(),
    ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [
      path.join(process.env[key]!, 'Microsoft/Edge/Application/msedge.exe'),
      path.join(process.env[key]!, 'Google/Chrome/Application/chrome.exe'),
    ] : []),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ];
  const result = candidates.find(candidate => existsSync(candidate));
  if (!result) throw new Error('检测主机没有可用浏览器。请安装 Chrome/Edge，或设置 accessibilityAgent.browserPath；也可选择仅源码审查。');
  return result;
}

export async function scanPage(input: string, options: { browserPath?: string; allowedOrigins?: string[]; signal?: AbortSignal } = {}): Promise<ScanResult> {
  const target = validateUrl(input);
  const origins = new Set([target.origin, ...(options.allowedOrigins ?? []).map(value => validateUrl(value).origin)]);
  options.signal?.throwIfAborted();
  const browser = await chromium.launch({ executablePath: findBrowser(options.browserPath), headless: true, timeout: 20_000, chromiumSandbox: true });
  let timedOut = false;
  const stop = () => { void browser.close().catch(() => undefined); };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, 45_000);
  options.signal?.addEventListener('abort', stop, { once: true });
  try {
    options.signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    let blockedRequests = 0;
    await context.route('**/*', route => {
      const request = route.request();
      const allowed = requestAllowed(request.url(), request.method(), origins);
      if (!allowed) blockedRequests++;
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => { blockedRequests++; socket.close(); });
    const page = await context.newPage();
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => undefined); });
    const response = await page.goto(target.href, { waitUntil: 'load', timeout: 25_000 });
    if (!response || !response.ok()) throw new Error('目标页面没有返回成功的 HTTP 响应。');
    if (new URL(page.url()).origin !== target.origin) throw new Error('目标页面发生了跨源跳转；请直接输入最终获授权的地址。');
    await page.addScriptTag({ content: axe.source });
    const results = await page.evaluate(async tags => {
      const runtime = (globalThis as unknown as { axe: typeof axe }).axe;
      return runtime.run(document, { runOnly: { type: 'tag', values: tags } });
    }, ruleTags);
    const all = [
      ...results.violations.map(result => ({ ...result, status: 'violation' as const })),
      ...results.incomplete.map(result => ({ ...result, status: 'incomplete' as const })),
    ];
    return {
      url: displayUrl(target.href), engine: `axe-core ${results.testEngine.version}`, ruleTags,
      counts: { violations: results.violations.length, incomplete: results.incomplete.length, passes: results.passes.length, inapplicable: results.inapplicable.length },
      issues: all.slice(0, 120).map(result => ({ id: result.id, status: result.status, impact: result.impact ?? null, description: result.description,
        targets: result.nodes.slice(0, 5).map(node => JSON.stringify(node.target).slice(0, 500)) })),
      blockedRequests,
      truncated: all.length > 120 || all.some(result => result.nodes.length > 5),
    };
  } catch (error) {
    if (options.signal?.aborted) throw new Error('浏览器检测已取消。');
    if (timedOut) throw new Error('浏览器检测超时；没有将其标记为通过。');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', stop);
    await browser.close().catch(() => undefined);
  }
}