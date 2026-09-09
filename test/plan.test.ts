import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChanges, hash, isCandidatePath, parsePlan, safeRelativePath, type Plan, type SourceFile } from '../src/core/plan';

const source = (content: string): SourceFile => ({ path: 'src/App.tsx', content, hash: hash(content) });
const plan = (edits: Plan['edits']): Plan => ({ summary: '测试修复', findings: [], edits, manualChecks: ['检查真实键盘操作'] });
const edit = (before: string, after: string) => ({ path: 'src/App.tsx', before, after, reason: '修复语义' });

test('解析 JSON 和 JSON 围栏；拒绝任意命令与未知字段', () => {
  assert.deepEqual(parsePlan(JSON.stringify(plan([]))), plan([]));
  assert.deepEqual(parsePlan('```json\n' + JSON.stringify(plan([])) + '\n```'), plan([]));
  assert.throws(() => parsePlan(JSON.stringify({ ...plan([]), command: 'echo unsafe' })));
  assert.throws(() => parsePlan('不是 JSON'));
  assert.throws(() => parsePlan('x'.repeat(160_001)));
});

test('精确替换原始快照且保持 CRLF', () => {
  const file = source('<div>\r\n<img src="a.png">\r\n</div>');
  const result = buildChanges(plan([edit('<img src="a.png">', '<img src="a.png" alt="">')]), [file]);
  assert.equal(result[0]?.before, file.content);
  assert.equal(result[0]?.after, '<div>\r\n<img src="a.png" alt="">\r\n</div>');
});

test('多片段按照原始坐标从后向前应用', () => {
  const result = buildChanges(plan([edit('abc', 'longer'), edit('xyz', 'short')]), [source('abc---xyz')]);
  assert.equal(result[0]?.after, 'longer---short');
});

test('拒绝不存在、重复和重叠的片段，不模糊匹配', () => {
  assert.throws(() => buildChanges(plan([edit('missing', 'x')]), [source('abc')]));
  assert.throws(() => buildChanges(plan([edit('a', 'x')]), [source('aaa')]));
  assert.throws(() => buildChanges(plan([edit('abc', 'x'), edit('bc', 'y')]), [source('abc')]));
  assert.throws(() => buildChanges(plan([edit('abc', 'x'), edit('abc', 'y')]), [source('abc')]));
});

test('拒绝超出授权文件集或被篡改的快照', () => {
  assert.throws(() => buildChanges(plan([{ ...edit('a', 'b'), path: 'src/Other.tsx' }]), [source('a')]));
  assert.throws(() => buildChanges(plan([edit('a', 'b')]), [{ ...source('a'), hash: 'invalid' }]));
  assert.throws(() => buildChanges({ ...plan([]), findings: [{ path: 'src/Other.tsx', issue: '问题', evidence: '证据', impact: 'minor', recommendation: '建议' }] }, [source('a')]));
});

test('阻止绝对路径、遍历、控制字符、配置和命令路径', () => {
  for (const input of ['../x.ts', '/x.ts', 'C:/x.ts', 'src\\x.ts', 'src/../x.ts', 'src//x.ts', 'x\u0000.ts', '.env', 'package.json', 'script.ps1']) {
    assert.throws(() => safeRelativePath(input), input);
  }
  assert.equal(safeRelativePath('src/中文组件.tsx'), 'src/中文组件.tsx');
});

test('候选文件排除构建、隐藏目录、敏感配置和测试', () => {
  for (const input of ['node_modules/a.ts', '.github/a.ts', 'src/.hidden/a.ts', 'src/token.ts', 'src/secrets.ts', 'src/a.test.ts', 'src/a.d.ts', 'dist/a.js']) {
    assert.equal(isCandidatePath(input), false, input);
  }
  assert.equal(isCandidatePath('src/components/Button.tsx'), true);
});

test('相同内容不生成修改，空计划不删除文件', () => {
  assert.deepEqual(buildChanges(plan([edit('abc', 'abc')]), [source('abc')]), []);
  assert.deepEqual(buildChanges(plan([]), [source('abc')]), []);
});