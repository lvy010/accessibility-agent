import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { describeTask, isValidationTask, runValidationTask } from '../../src/validation';

export async function testValidation(folder: vscode.WorkspaceFolder): Promise<void> {
  // In an Extension Host process.execPath is Code.exe, not Node; Electron may ignore RUN_AS_NODE.
  const node = process.env.A11Y_TEST_NODE;
  assert.ok(node, 'The test launcher must supply its actual Node executable');
  const createTask = (name: string, code: string, scope: vscode.WorkspaceFolder | vscode.TaskScope = folder) => new vscode.Task(
    { type: 'a11y-fixture' }, scope, name, 'a11y-fixture',
    new vscode.ProcessExecution(node, ['-e', code]), [],
  );
  const successful = createTask('success', 'process.exit(0)');
  assert.equal(isValidationTask(successful, folder), true);
  assert.equal(isValidationTask(createTask('workspace', '', vscode.TaskScope.Workspace), folder), true);
  assert.equal(isValidationTask(createTask('global', '', vscode.TaskScope.Global), folder), false);
  const other = { ...folder, uri: vscode.Uri.joinPath(folder.uri, 'other') };
  assert.equal(isValidationTask(createTask('other', '', other), folder), false);
  const background = createTask('background', '');
  background.isBackground = true;
  assert.equal(describeTask(background), undefined);
  const token = new vscode.CancellationTokenSource();
  try {
    const passed = await runValidationTask(successful, token.token, 30_000);
    assert.equal(passed.exitCode, 0, JSON.stringify(passed));
    const failed = await runValidationTask(createTask('failure', 'process.exit(7)'), token.token, 30_000);
    assert.equal(failed.exitCode, 7, JSON.stringify(failed));
    const timedOut = await runValidationTask(createTask('timeout', 'setInterval(() => {}, 1000)'), token.token, 1_000);
    assert.match(timedOut.result, /超时/);
    assert.equal(timedOut.exitCode, undefined);
  } finally { token.dispose(); }
  const cancelled = new vscode.CancellationTokenSource();
  const listener = vscode.tasks.onDidStartTask(event => {
    if (event.execution.task.name === 'cancel') cancelled.cancel();
  });
  try {
    const result = await runValidationTask(createTask('cancel', 'setInterval(() => {}, 1000)'), cancelled.token, 30_000);
    assert.match(result.result, /取消/);
    assert.equal(result.exitCode, undefined);
    await assert.rejects(runValidationTask(successful, cancelled.token, 30_000), vscode.CancellationError);
  } finally { listener.dispose(); cancelled.dispose(); }
  console.log('PASS: Validation task scope checks and 5 execution cases (exit 0, exit 7, timeout, cancellation, pre-cancelled).');
}