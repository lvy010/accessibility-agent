import * as vscode from 'vscode';
import { buildPrompt } from './core/prompt';
import { MAX_RESPONSE_CHARS, parsePlan, type Plan, type SourceFile } from './core/plan';
import type { ScanResult } from './core/scanner';

/** Stop waiting even when a provider ignores its cancellation token. */
function cancellable<T>(operation: () => PromiseLike<T>, token: vscode.CancellationToken): Promise<T> {
  if (token.isCancellationRequested) return Promise.reject(new vscode.CancellationError());
  return new Promise<T>((resolve, reject) => {
    const listener = token.onCancellationRequested(() => {
      listener.dispose();
      reject(new vscode.CancellationError());
    });
    Promise.resolve().then(() => {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      return operation();
    }).then(resolve, reject).finally(() => listener.dispose());
    // Release the listener on cancellation too, even if the provider never settles.
    if (token.isCancellationRequested) { listener.dispose(); reject(new vscode.CancellationError()); }
  });
}

export async function selectModel(force = false): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels({});
  if (!models.length) {
    throw new Error('没有可用的 VS Code 语言模型。请安装并登录 GitHub Copilot，确认账号可调用模型。Codex 仅在向 vscode.lm 注册兼容模型时可用；本插件不会读取其凭据或调用私有接口。');
  }
  const config = vscode.workspace.getConfiguration('accessibilityAgent');
  const id = config.get<string>('modelId');
  if (!force && id) {
    const existing = models.find(model => model.id === id);
    if (existing) return existing;
  }
  const picked = await vscode.window.showQuickPick(models.map(model => ({ label: model.name, description: `${model.vendor} · ${model.family}`, detail: model.id, model })), {
    title: '选择已有 AI 模型', placeHolder: '仅列出通过 VS Code 官方接口开放的模型；费用和额度由所选服务管理。',
  });
  if (picked) await config.update('modelId', picked.model.id, vscode.ConfigurationTarget.Global);
  return picked?.model;
}

export async function generatePlan(model: vscode.LanguageModelChat, files: SourceFile[], scan: ScanResult | undefined, token: vscode.CancellationToken): Promise<Plan> {
  const message = vscode.LanguageModelChatMessage.User(buildPrompt(files, scan));
  const tokens = await cancellable(() => model.countTokens(message, token), token);
  if (tokens > model.maxInputTokens * 0.7) throw new Error('所选文件超过模型的安全上下文预算，请减少文件或选择更大上下文的模型。');
  if (token.isCancellationRequested) throw new vscode.CancellationError();
  const response = await cancellable(() => model.sendRequest([message], { justification: '分析用户选中的源文件和获授权的无障碍扫描摘要，生成可预览的最小修复。' }, token), token);
  const iterator = response.text[Symbol.asyncIterator]();
  let raw = '';
  let complete = false;
  try {
    while (true) {
      const part = await cancellable(() => iterator.next(), token);
      if (part.done) { complete = true; break; }
      raw += part.value;
      if (raw.length > MAX_RESPONSE_CHARS) throw new Error('模型响应过长；已停止处理，没有应用修改。');
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    return parsePlan(raw);
  } finally {
    // Do not let an uncooperative iterator block cancellation or leak an unhandled rejection.
    if (!complete) { void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined); }
  }
}