import * as vscode from 'vscode';
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { hash, isCandidatePath, MAX_FILE_CHARS, MAX_TOTAL_CHARS, safeRelativePath, type Change, type SourceFile } from './core/plan';

export function ensureTrusted(): void {
  if (!vscode.workspace.isTrusted) throw new Error('请先审查并信任工作区，再运行无障碍修复。');
}

export async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  ensureTrusted();
  const folders = vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === 'file');
  if (!folders?.length) throw new Error('请先打开要修复的本地项目文件夹。');
  if (folders.length === 1) return folders[0];
  return (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })), { title: '选择本次要修复的项目' }))?.folder;
}

export async function resolveSource(root: vscode.Uri, relative: string): Promise<vscode.Uri> {
  safeRelativePath(relative);
  const candidate = vscode.Uri.joinPath(root, relative);
  const [rootReal, candidateReal] = await Promise.all([realpath(root.fsPath), realpath(candidate.fsPath)]);
  const rel = path.relative(rootReal, candidateReal);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('拒绝访问工作区以外的文件或符号链接。');
  return candidate;
}

export async function chooseSources(folder: vscode.WorkspaceFolder): Promise<SourceFile[] | undefined> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/*.{html,htm,js,jsx,ts,tsx,vue,svelte,css,scss,less}'),
    '**/{node_modules,dist,build,coverage,vendor,.git,out,generated}/**', 400,
  );
  const active = vscode.window.activeTextEditor?.document.uri.toString();
  const options = uris.map(uri => ({ uri, relative: path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') }))
    .filter(item => isCandidatePath(item.relative))
    .map(item => ({ label: item.relative, picked: item.uri.toString() === active, ...item }));
  if (!options.length) throw new Error('没有找到支持的 Web 源文件。请打开包含 HTML、JS/TS、Vue、Svelte 或 CSS 的项目。');
  const maxFiles = Math.max(1, Math.min(20, vscode.workspace.getConfiguration('accessibilityAgent').get<number>('maxFiles', 8)));
  const selected = await vscode.window.showQuickPick(options, {
    canPickMany: true, title: '明确授权本次 AI 可以读取及修改的源文件',
    placeHolder: `最多 ${maxFiles} 个文件（当前编辑文件已预选）；建议同时选择组件与相关样式，不要选择敏感文件。`,
  });
  if (!selected?.length) return undefined;
  if (selected.length > maxFiles) throw new Error(`一次最多选择 ${maxFiles} 个文件，请缩小范围。`);
  const files: SourceFile[] = [];
  for (const item of selected) {
    const uri = await resolveSource(folder.uri, item.relative);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) throw new Error(`请先保存 ${item.relative}，以建立一致的源码快照。`);
    const content = document.getText();
    if (content.length > MAX_FILE_CHARS || content.includes('\u0000')) throw new Error(`文件过大或非文本：${item.relative}。请缩小范围。`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i.test(content)) {
      throw new Error(`文件疑似包含硬编码凭据：${item.relative}。请先移除敏感数据再调用模型。`);
    }
    files.push({ path: item.relative, content, hash: hash(content) });
  }
  if (files.reduce((sum, file) => sum + file.content.length, 0) > MAX_TOTAL_CHARS) throw new Error('选中文件总量过大，请减少文件后重试。');
  return files;
}

export async function applyChanges(folder: vscode.WorkspaceFolder, changes: Change[], reverse = false): Promise<void> {
  ensureTrusted();
  const pending: { document: vscode.TextDocument; expected: string; replacement: string; version: number }[] = [];
  for (const change of changes) {
    const uri = await resolveSource(folder.uri, change.path);
    const document = await vscode.workspace.openTextDocument(uri);
    const expected = reverse ? change.after : change.before;
    if (document.getText() !== expected) throw new Error(`文件已变化，拒绝覆盖：${change.path}。请重新运行。`);
    const disk = await readFile(uri.fsPath, 'utf8');
    if (!reverse && (document.isDirty || hash(disk.replace(/^\uFEFF/, '')) !== change.hash)) throw new Error(`文件在分析后已修改：${change.path}。`);
    // Undo may operate on unsaved agent edits, but never overwrite unrelated disk changes.
    if (reverse && ![change.before, change.after].includes(disk.replace(/^\uFEFF/, ''))) throw new Error(`磁盘文件已变化，拒绝撤销：${change.path}。`);
    pending.push({ document, expected, replacement: reverse ? change.before : change.after, version: document.version });
  }
  const edit = new vscode.WorkspaceEdit();
  for (const { document, version, expected, replacement } of pending) {
    if (document.version !== version || document.getText() !== expected) throw new Error('应用前文件发生变化，请重新运行。');
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(expected.length)), replacement);
  }
  if (!await vscode.workspace.applyEdit(edit, { isRefactoring: false })) throw new Error('编辑器未能应用修改；请检查文件状态。');
}

export async function saveChanges(folder: vscode.WorkspaceFolder, changes: Change[]): Promise<void> {
  for (const change of changes) {
    const uri = await resolveSource(folder.uri, change.path);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() !== change.after) throw new Error(`保存前检测到额外编辑：${change.path}。请手动保存并重新检查。`);
    if (!await document.save()) throw new Error(`保存失败：${change.path}。`);
    if (document.getText() !== change.after) throw new Error(`保存钩子改变了 ${change.path}；本次验证中止，请重新检查。`);
  }
}