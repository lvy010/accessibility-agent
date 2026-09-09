import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { Dashboard } from './dashboard';
import { PreviewProvider } from './preview';
import { selectModel, generatePlan } from './model';
import { applyChanges, chooseFolder, chooseSources, ensureTrusted, saveChanges } from './workspace';
import { buildChanges, type Change } from './core/plan';
import { displayUrl, scanPage, validateUrl, type ScanResult } from './core/scanner';
import { renderReport, type RunReport } from './core/report';
import { validateWithTask } from './validation';

export function activate(context: vscode.ExtensionContext): void {
  const dashboard = new Dashboard(context.extensionUri);
  const preview = new PreviewProvider();
  const output = vscode.window.createOutputChannel('无障碍工程师');
  let busy = false;
  let lastReport: vscode.Uri | undefined;
  let undo: { folder: vscode.WorkspaceFolder; changes: Change[] } | undefined;
  let activeCancellation: vscode.CancellationTokenSource | undefined;
  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('accessibilityAgent.dashboard', dashboard),
    vscode.workspace.registerTextDocumentContentProvider('a11y-preview', preview),
    { dispose: () => { activeCancellation?.cancel(); activeCancellation?.dispose(); preview.clear(); } },
  );

  function stage(run: RunReport, label: string, detail: string): void {
    run.status = label;
    dashboard.update({ stage: label, detail });
    // Operational events only: never log source, prompt, URL credentials, or model output.
    output.appendLine(`[${run.id}] ${label}`);
  }

  async function persist(run: RunReport): Promise<void> {
    const directory = vscode.Uri.joinPath(context.globalStorageUri, 'reports');
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, `${run.startedAt.replace(/[:.]/g, '-')}-${run.id}.md`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(renderReport(run), 'utf8'));
    lastReport = uri;
    dashboard.update({ hasReport: true });
    // Retain at most 20 local reports. No source snapshots or credentials are persisted.
    const reports = (await vscode.workspace.fs.readDirectory(directory))
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md')).sort(([a], [b]) => b.localeCompare(a));
    for (const [name] of reports.slice(20)) await vscode.workspace.fs.delete(vscode.Uri.joinPath(directory, name));
  }

  async function browserScan(url: string, token: vscode.CancellationToken): Promise<ScanResult> {
    const controller = new AbortController();
    const listener = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    const config = vscode.workspace.getConfiguration('accessibilityAgent');
    try {
      return await scanPage(url, { browserPath: config.get<string>('browserPath'), allowedOrigins: config.get<string[]>('allowedResourceOrigins', []), signal: controller.signal });
    } finally { listener.dispose(); }
  }

  async function runWorkflow(run: RunReport, token: vscode.CancellationToken): Promise<void> {
    const cancelled = () => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
    stage(run, '01 · 选择范围', '选择目标项目和本次允许 AI 读取的文件。');
    const folder = await chooseFolder();
    if (!folder) throw new vscode.CancellationError();
    const files = await chooseSources(folder);
    if (!files) throw new vscode.CancellationError();
    run.files = files.map(file => file.path);
    cancelled();
    const mode = await vscode.window.showQuickPick([
      { label: '源码审查与修复', description: '无需启动浏览器；不声称已完成页面检测', browser: false },
      { label: '源码 + 浏览器检测', description: '使用本机 Chrome/Edge 或已安装 Chromium 运行 axe', browser: true },
    ], { title: '选择本次检测方式' });
    if (!mode) throw new vscode.CancellationError();
    let url: string | undefined;
    if (mode.browser) {
      url = await vscode.window.showInputBox({ title: '输入获授权的测试页面地址', prompt: '优先本地或预发布环境；不要输入带凭据或敏感查询参数的地址。远程开发时从扩展主机访问。',
        placeHolder: 'http://localhost:3000', ignoreFocusOut: true,
        validateInput: value => { try { validateUrl(value); return undefined; } catch { return '请输入有效的 HTTP(S) 地址，不允许 URL 账号密码。'; } },
      });
      if (!url) throw new vscode.CancellationError();
      const resources = vscode.workspace.getConfiguration('accessibilityAgent').get<string[]>('allowedResourceOrigins', []);
      if (await vscode.window.showWarningMessage('确认有权访问并检测此页面？', {
        modal: true,
        detail: `目标：${displayUrl(url)}\n额外允许的资源来源：${resources.join('、') || '无'}\n使用独立浏览器会话，无登录 Cookie，禁止非 GET/HEAD 请求和 WebSocket，不执行按钮点击。GET 和页面脚本仍可能产生副作用；这不是恶意网页沙箱。请勿扫描未经授权的站点。`,
      }, '授权本次检测') !== '授权本次检测') throw new vscode.CancellationError();
    }
    const model = await selectModel();
    if (!model) throw new vscode.CancellationError();
    run.model = `${model.vendor} / ${model.name} (${model.id})`;
    if (await vscode.window.showInformationMessage('允许将所选源文件发送给当前 AI 模型？', {
      modal: true,
      detail: `模型：${model.vendor} / ${model.name}\n文件：\n${run.files.join('\n')}\n可选浏览器检测仅发送规则和节点定位摘要，不发送完整 DOM、Cookie 或截图。源文件仍可能含业务数据，请遵守公司策略。调用消耗现有模型额度；本插件不收取或保存密钥。中文报告仅保存在本地插件存储，最多保留 20 份。`,
    }, '授权分析') !== '授权分析') throw new vscode.CancellationError();
    cancelled();
    if (url) {
      stage(run, '02 · 浏览器检测', '正在隔离会话中检查获授权的页面。');
      try { run.beforeScan = await browserScan(url, token); } catch {
        cancelled();
        run.notes.push('修复前浏览器检测失败；没有将失败计为通过。请检查浏览器路径、页面可达性、资源来源和内容安全策略。');
        const choice = await vscode.window.showWarningMessage('浏览器检测未完成。是否仅继续源码审查？', '仅继续源码审查', '停止');
        if (choice !== '仅继续源码审查') throw new Error('浏览器检测失败，本次已停止。');
        url = undefined;
      }
    }
    stage(run, '02 · AI 分析', '检查语义、键盘、焦点及视觉问题，生成可预览的最小修复。');
    const requestCancellation = new vscode.CancellationTokenSource();
    const listener = token.onCancellationRequested(() => requestCancellation.cancel());
    const timeout = setTimeout(() => requestCancellation.cancel(), 180_000);
    try { run.plan = await generatePlan(model, files, run.beforeScan, requestCancellation.token); }
    finally { clearTimeout(timeout); listener.dispose(); requestCancellation.dispose(); }
    cancelled();
    const changes = buildChanges(run.plan, files);
    if (changes.length) {
      stage(run, '03 · 待审查', `已生成 ${changes.length} 个文件的修复，请在差异编辑器审查。`);
      if (!await preview.confirm(changes)) {
        run.notes.push('用户未确认应用修复；未修改源码。');
        run.status = '已交付建议 · 未应用';
        return;
      }
      cancelled();
      await applyChanges(folder, changes);
      run.applied = true;
      undo = { folder, changes };
      dashboard.update({ canUndo: true });
      if (await vscode.window.showInformationMessage('修复已应用到编辑器。是否保存这些文件并继续验证？', {
        modal: true, detail: '只保存本次修改的文件。保存可能触发项目格式化或保存钩子；如果内容变化将停止自动验证。也可先保留未保存修改，稍后自行检查。',
      }, '保存并继续') !== '保存并继续') {
        run.notes.push('修改仍在编辑器中，未自动保存；未执行修复后任务与浏览器验证。');
        run.status = '修复已应用 · 未保存/未验证';
        return;
      }
      cancelled();
      await saveChanges(folder, changes);
      run.saved = true;
    } else run.notes.push('AI 没有给出可以安全自动应用的改动；请检查问题列表和人工验收项。');
    cancelled();
    stage(run, '04 · 项目验证', '选择并确认已有测试或类型检查任务，不执行模型生成的命令。');
    run.validation = await validateWithTask(folder, token);
    cancelled();
    if (url && run.beforeScan) {
      const choice = await vscode.window.showInformationMessage('是否重新检测同一页面？', {
        modal: true, detail: '请先确认应用已构建或开发服务器已加载保存后的代码。线上页面不会因本地修改自动更新；本插件不部署代码。',
      }, '已确认页面更新，重新检测');
      if (choice) {
        stage(run, '04 · 页面复查', '以相同规则和来源限制复查页面，保留待复核事项。');
        try { run.afterScan = await browserScan(url, token); } catch {
          cancelled();
          run.notes.push('修复后页面检测失败；不能判定浏览器验证通过。');
        }
      } else run.notes.push('用户未确认页面已更新，跳过修复后扫描；没有自动部署。');
    }
    run.status = run.applied ? '修复已交付 · 请审查验证与人工验收项' : '检查已交付 · 无自动修改';
  }

  context.subscriptions.push(vscode.commands.registerCommand('accessibilityAgent.run', async () => {
    if (busy) { void vscode.window.showInformationMessage('已有无障碍任务进行中，请等待完成或取消当前任务。'); return; }
    try { ensureTrusted(); } catch { void vscode.window.showWarningMessage('需要先信任工作区才能运行。'); return; }
    if (undo && await vscode.window.showWarningMessage('开始新任务将替换上一次的专用撤销快照。', { modal: true, detail: '请先确认已有修改已审查。编辑器与 Git 的历史不受影响。' }, '继续新任务') !== '继续新任务') return;
    busy = true;
    undo = undefined;
    preview.clear();
    dashboard.update({ busy: true, canUndo: false });
    const run: RunReport = { id: randomUUID(), startedAt: new Date().toISOString(), files: [], status: '开始', applied: false, saved: false, notes: [] };
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '无障碍工程师：可审查修复', cancellable: true }, async (_progress, token) => {
        activeCancellation = new vscode.CancellationTokenSource();
        const listener = token.onCancellationRequested(() => activeCancellation?.cancel());
        try { await runWorkflow(run, activeCancellation.token); }
        finally { listener.dispose(); activeCancellation.dispose(); activeCancellation = undefined; }
      });
    } catch (error) {
      const cancelled = error instanceof vscode.CancellationError;
      run.status = cancelled ? '已取消' : '执行受阻';
      const message = error instanceof vscode.LanguageModelError
        ? `模型调用失败（${error.code}）：请检查模型权限、账号额度或更换兼容模型。`
        : cancelled ? '任务已取消；已应用的修改不会自动回滚，可使用撤销命令。'
          : error instanceof Error ? error.message.slice(0, 1_000) : '发生未知错误；请检查环境后重试。';
      run.notes.push(message);
      if (!cancelled) void vscode.window.showErrorMessage(message);
    } finally {
      run.finishedAt = new Date().toISOString();
      try { await persist(run); } catch { void vscode.window.showErrorMessage('报告保存失败，请检查插件存储权限。已有代码修改不会自动回滚。'); }
      busy = false;
      dashboard.update({ busy: false, stage: run.status, detail: '查看交付报告，确认实际执行结果、覆盖范围和人工验收项。', canUndo: !!undo });
    }
    if (lastReport && run.files.length) {
      const action = await vscode.window.showInformationMessage(run.status, '查看交付报告');
      if (action) await vscode.commands.executeCommand('accessibilityAgent.openReport');
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('accessibilityAgent.selectModel', async () => {
    if (busy) return;
    try { ensureTrusted(); await selectModel(true); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : '模型选择失败。'); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('accessibilityAgent.openReport', async () => {
    if (!lastReport) { void vscode.window.showInformationMessage('本次会话还没有报告。历史报告保存在插件全局存储的 reports 目录。'); return; }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(lastReport), { preview: false });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('accessibilityAgent.undo', async () => {
    if (busy || !undo) return;
    if (await vscode.window.showWarningMessage('撤销最近一次 Agent 修复？', { modal: true, detail: '仅当文件仍与 Agent 的修复结果完全一致时才撤销。恢复到编辑器后不自动保存，不影响其他文件。' }, '撤销修复') !== '撤销修复') return;
    busy = true;
    dashboard.update({ busy: true });
    try {
      await applyChanges(undo.folder, undo.changes, true);
      undo = undefined;
      dashboard.update({ canUndo: false, stage: '已撤销', detail: '原内容已恢复到编辑器；请检查并手动保存。历史交付报告记录的是当时的执行结果。' });
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : '撤销失败。'); }
    finally { busy = false; dashboard.update({ busy: false }); }
  }));
}

export function deactivate(): void { /* Resources are released through ExtensionContext.subscriptions. */ }