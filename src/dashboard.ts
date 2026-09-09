import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export interface DashboardState { busy: boolean; stage: string; detail: string; hasReport: boolean; canUndo: boolean }
export class Dashboard implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private state: DashboardState = { busy: false, stage: '准备就绪', detail: '选择源文件，借助已有 AI 完成一次可审查的无障碍修复。', hasReport: false, canUndo: false };
  constructor(private readonly extensionUri: vscode.Uri) {}
  update(update: Partial<DashboardState>): void {
    this.state = { ...this.state, ...update };
    void this.view?.webview.postMessage({ type: 'state', ...this.state });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const nonce = randomBytes(24).toString('base64');
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.js'));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'dashboard.css'));
    view.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>无障碍工程师</title></head><body>
      <main><header><p class="eyebrow">ACCESSIBILITY AGENT</p><h1>让每个人<br>都能使用你的产品。</h1><p class="intro">从发现问题到交付修复，<br>让 AI 参与，让证据说话。</p></header>
      <section class="card" aria-labelledby="run-heading"><div class="status-line"><span class="dot" aria-hidden="true"></span><h2 id="run-heading">本次工作流</h2></div><p id="stage" role="status" aria-live="polite">准备就绪</p><p id="detail">选择源文件，借助已有 AI 完成一次可审查的无障碍修复。</p><button id="run" class="primary" type="button">开始检查与修复 <span aria-hidden="true">→</span></button><button id="model" class="secondary" type="button">选择已有 AI 模型</button></section>
      <section aria-labelledby="flow-heading"><h2 id="flow-heading" class="section-title">一个入口 · 五个步骤</h2><ol class="flow"><li><span class="step" aria-hidden="true">01</span><div><strong>范围与授权</strong><small>只读取明确选择的文件</small></div></li><li><span class="step" aria-hidden="true">02</span><div><strong>检测与分析</strong><small>源码审查 + 可选 axe 浏览器检测</small></div></li><li><span class="step" aria-hidden="true">03</span><div><strong>预览与修复</strong><small>查看差异，确认后才应用</small></div></li><li><span class="step" aria-hidden="true">04</span><div><strong>回归与验证</strong><small>已有项目任务 + 页面复查</small></div></li><li><span class="step" aria-hidden="true">05</span><div><strong>报告与验收</strong><small>中文报告，明确人工检查项</small></div></li></ol></section>
      <div class="actions"><button id="report" class="secondary" type="button" disabled>查看交付报告</button><button id="undo" class="secondary" type="button" disabled>撤销最近修复</button></div>
      <footer><strong>你的模型，你的代码，你来决定。</strong><p>复用 Copilot 或 VS Code 兼容模型。无自建后端、无遥测、无密钥收集。自动检查不等于完整合规认证。</p><p>Codex 须向 VS Code 开放兼容模型接口。</p></footer></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const listener = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return;
      const commands: Record<string, string> = { run: 'accessibilityAgent.run', model: 'accessibilityAgent.selectModel', report: 'accessibilityAgent.openReport', undo: 'accessibilityAgent.undo' };
      if (message.type === 'ready') this.update({});
      else if (Object.hasOwn(commands, message.type) && (!this.state.busy || message.type === 'report')) {
        void vscode.commands.executeCommand(commands[message.type]!);
      }
    });
    view.onDidDispose(() => { listener.dispose(); this.view = undefined; });
  }
}