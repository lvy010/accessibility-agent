import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { applyChanges, resolveSource, saveChanges } from '../../src/workspace';
import { buildChanges, hash, parsePlan } from '../../src/core/plan';
import { testModels } from './model';
import { testValidation } from './validation';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('lvy010.accessibility-agent');
  assert.ok(extension, '扩展应被 Extension Host 发现');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['run', 'selectModel', 'openReport', 'undo']) assert.ok(commands.includes(`accessibilityAgent.${command}`));
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  assert.equal(vscode.workspace.isTrusted, true);
  const uri = vscode.Uri.joinPath(folder.uri, 'App.tsx');
  const original = 'export const App = () => <button />;\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(original));
  const plan = parsePlan(JSON.stringify({ summary: '测试修复', findings: [], edits: [{ path: 'App.tsx', before: '<button />', after: '<button>提交</button>', reason: '可访问名称' }], manualChecks: [] }));
  const changes = buildChanges(plan, [{ path: 'App.tsx', content: original, hash: hash(original) }]);
  await applyChanges(folder, changes);
  const document = await vscode.workspace.openTextDocument(uri);
  assert.equal(document.getText(), changes[0]!.after);
  assert.equal(document.isDirty, true, '修复不得静默保存');
  await saveChanges(folder, changes);
  assert.equal(document.isDirty, false);
  await applyChanges(folder, changes, true);
  assert.equal(document.getText(), original);
  assert.equal(document.isDirty, true, '撤销不得静默保存');
  await document.save();
  const manual = new vscode.WorkspaceEdit();
  manual.insert(uri, new vscode.Position(0, 0), '// 用户编辑\n');
  await vscode.workspace.applyEdit(manual);
  await assert.rejects(applyChanges(folder, changes), /文件已变化/);
  await assert.rejects(resolveSource(folder.uri, '../App.tsx'));
  console.log('PASS: Extension Host 激活、命令注册、协议修复、保存、撤销及并发编辑保护。');
  for (const resource of ['media/accessibility.svg', 'media/dashboard.css', 'media/dashboard.js', 'dist/THIRD_PARTY_NOTICES.txt']) {
    assert.ok((await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, resource))).size > 0);
  }
  await vscode.commands.executeCommand('workbench.view.extension.accessibilityAgent');
  await testModels();
  await testValidation(folder);
  assert.ok(process.env.A11Y_TEST_RESULT);
  await writeFile(process.env.A11Y_TEST_RESULT, JSON.stringify({
    runId: process.env.A11Y_TEST_RUN_ID, completed: true, vscodeVersion: vscode.version,
    extensionPath: extension.extensionPath, modelCases: 13, taskCases: 5,
  }));
}