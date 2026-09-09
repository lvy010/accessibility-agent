import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { scanPage } from '../../src/core/scanner';
import { buildChanges, hash, parsePlan } from '../../src/core/plan';
import { renderReport } from '../../src/core/report';

test('真实 Chromium：检测 → 协议修复 → 重新检测 → 中文报告', { timeout: 100_000 }, async () => {
  let html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无障碍测试</title></head><body><main><h1>测试页面</h1><button id="submit"></button></main></body></html>';
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = await scanPage(url);
    assert.ok(before.issues.some(issue => issue.id === 'button-name' && issue.status === 'violation'));
    // Deterministic fixture stands in for AI output; this does not claim a live Copilot test.
    const plan = parsePlan(JSON.stringify({ summary: '补充按钮名称', findings: [], edits: [{ path: 'index.html', before: '<button id="submit"></button>', after: '<button id="submit">提交</button>', reason: '按钮应有可访问名称' }], manualChecks: ['使用读屏检查按钮含义'] }));
    const changes = buildChanges(plan, [{ path: 'index.html', content: html, hash: hash(html) }]);
    html = changes[0]!.after;
    const after = await scanPage(url);
    assert.equal(after.issues.some(issue => issue.id === 'button-name' && issue.status === 'violation'), false);
    assert.ok(after.counts.violations < before.counts.violations);
    const report = renderReport({ id: 'browser-test', startedAt: new Date().toISOString(), status: '测试完成', files: ['index.html'], applied: true, saved: true, plan, beforeScan: before, afterScan: after, notes: ['使用固定模型响应，不代表真实 AI 服务调用。'] });
    assert.ok(report.includes('失败规则变化：'));
    assert.ok(report.includes('人工验收'));
  } finally { server.close(); await once(server, 'close'); }
});

test('真实浏览器阻止 POST、跨源资源和 WebSocket，保留覆盖警告', { timeout: 60_000 }, async () => {
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') posts++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html lang="en"><head><title>Network test</title></head><body><main><h1>Network test</h1><img src="http://127.0.0.1:1/blocked.png" alt=""><script>fetch("/mutate",{method:"POST"}).catch(()=>{});new WebSocket("ws://127.0.0.1:1/socket");</script></main></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const result = await scanPage(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    assert.equal(posts, 0);
    assert.ok(result.blockedRequests >= 3);
  } finally { server.close(); await once(server, 'close'); }
});

test('扫描支持调用前取消', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanPage('http://127.0.0.1:1', { signal: controller.signal }));
});