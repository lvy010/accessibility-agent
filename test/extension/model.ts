import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { generatePlan, selectModel } from '../../src/model';
import { hash, MAX_RESPONSE_CHARS } from '../../src/core/plan';

const valid = JSON.stringify({ summary: '模型测试', findings: [], edits: [], manualChecks: [] });
const files = [{ path: 'App.tsx', content: '<button />', hash: hash('<button />') }];

function model(text: AsyncIterable<string>): vscode.LanguageModelChat {
  return {
    id: 'fixture', name: 'Fixture (not a live AI)', vendor: 'test', family: 'test', version: '1', maxInputTokens: 10_000,
    countTokens: async () => 20,
    sendRequest: async () => ({ text, stream: text }),
  };
}
async function* chunks(...values: string[]): AsyncIterable<string> { yield* values; }

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation did not settle in time')), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function testModels(): Promise<void> {
  const source = new vscode.CancellationTokenSource();
  try {
    const result = await generatePlan(model(chunks(valid.slice(0, 15), valid.slice(15))), files, undefined, source.token);
    assert.equal(result.summary, '模型测试');
    await assert.rejects(generatePlan(model(chunks('not JSON')), files, undefined, source.token), /有效 JSON/);
    await assert.rejects(generatePlan(model(chunks('{"summary":"非法字段","command":"deploy"}')), files, undefined, source.token), /不符合修复协议/);
    await assert.rejects(generatePlan(model(chunks('x'.repeat(MAX_RESPONSE_CHARS + 1))), files, undefined, source.token), /响应过长/);
    const overBudget = model(chunks(valid));
    overBudget.countTokens = async () => 10_000;
    overBudget.sendRequest = async () => { assert.fail('Over-budget input must never be sent'); };
    await assert.rejects(generatePlan(overBudget, files, undefined, source.token), /上下文预算/);
    for (const error of [vscode.LanguageModelError.NoPermissions(), vscode.LanguageModelError.Blocked()]) {
      const denied = model(chunks(valid));
      denied.sendRequest = async () => { throw error; };
      await assert.rejects(generatePlan(denied, files, undefined, source.token), value => value === error);
    }
    const streamError = new Error('provider disconnected');
    async function* broken(): AsyncIterable<string> { yield valid.slice(0, 5); throw streamError; }
    await assert.rejects(generatePlan(model(broken()), files, undefined, source.token), value => value === streamError);
  } finally { source.dispose(); }

  const preCancelled = new vscode.CancellationTokenSource();
  preCancelled.cancel();
  const neverCalled = model(chunks(valid));
  neverCalled.countTokens = async () => { assert.fail('Cancelled input must not reach the provider'); };
  try { await assert.rejects(generatePlan(neverCalled, files, undefined, preCancelled.token), vscode.CancellationError); }
  finally { preCancelled.dispose(); }

  for (const boundary of ['count', 'request', 'stream'] as const) {
    const cancellation = new vscode.CancellationTokenSource();
    const hang = <T>(): Promise<T> => {
      queueMicrotask(() => cancellation.cancel());
      return new Promise<T>(() => { /* Deliberately ignore the token, like a broken provider. */ });
    };
    const fixture = model(boundary === 'stream' ? { [Symbol.asyncIterator]: () => ({ next: () => hang<IteratorResult<string>>() }) } : chunks(valid));
    if (boundary === 'count') fixture.countTokens = () => hang<number>();
    if (boundary === 'request') fixture.sendRequest = () => hang<vscode.LanguageModelChatResponse>();
    try { await assert.rejects(bounded(generatePlan(fixture, files, undefined, cancellation.token)), vscode.CancellationError); }
    finally { cancellation.dispose(); }
  }

  // This host is isolated with all model-provider extensions disabled; no account or network model is used.
  assert.equal((await vscode.lm.selectChatModels({})).length, 0);
  await assert.rejects(selectModel(), /没有可用的 VS Code 语言模型/);
  console.log('PASS: 13 model cases (streaming, schema, size, budget, permission, quota, disconnect, cancellation at 4 boundaries, no models); fixtures only.');
}