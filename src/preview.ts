import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { Change } from './core/plan';

export class PreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? '预览已过期，请重新运行。'; }
  clear(): void { this.contents.clear(); }

  async confirm(changes: Change[]): Promise<boolean> {
    this.clear();
    const id = randomUUID();
    const pairs = changes.map(change => {
      const before = vscode.Uri.from({ scheme: 'a11y-preview', path: `/${id}/before/${change.path}` });
      const after = vscode.Uri.from({ scheme: 'a11y-preview', path: `/${id}/after/${change.path}` });
      this.contents.set(before.toString(), change.before);
      this.contents.set(after.toString(), change.after);
      return { change, before, after };
    });
    for (const pair of pairs) {
      await vscode.commands.executeCommand('vscode.diff', pair.before, pair.after, `无障碍修复 · ${pair.change.path}`, { preview: false });
    }
    return await vscode.window.showWarningMessage(
      `已打开 ${changes.length} 个文件的差异预览。请先逐个审查编辑器差异，再确认应用；AI 建议可能不正确。应用后暂不自动保存。`,
      '应用全部修复',
    ) === '应用全部修复';
  }
}