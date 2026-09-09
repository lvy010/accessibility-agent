import * as vscode from 'vscode';

export interface ValidationResult { label: string; command: string; result: string; exitCode?: number }

export function describeTask(task: vscode.Task): string | undefined {
  if (task.isBackground) return undefined;
  if (task.execution instanceof vscode.ShellExecution) {
    const execution = task.execution;
    const value = (arg: string | vscode.ShellQuotedString) => typeof arg === 'string' ? arg : arg.value;
    return execution.commandLine ?? [value(execution.command ?? ''), ...execution.args.map(value)].join(' ');
  }
  if (task.execution instanceof vscode.ProcessExecution) return [task.execution.process, ...task.execution.args].join(' ');
  return undefined;
}

export function isValidationTask(task: vscode.Task, folder: vscode.WorkspaceFolder): boolean {
  const scope = task.scope;
  return (scope === vscode.TaskScope.Workspace || (typeof scope === 'object' && scope.uri.toString() === folder.uri.toString()))
    && !!describeTask(task);
}

export async function validateWithTask(folder: vscode.WorkspaceFolder, token: vscode.CancellationToken): Promise<ValidationResult> {
  const tasks = (await vscode.tasks.fetchTasks()).filter(task => isValidationTask(task, folder));
  if (!tasks.length) return { label: '项目验证', command: '', result: '未运行：项目没有可选择的前台 Shell/Process 任务。请配置测试或类型检查任务后手动验证。' };
  const selected = await vscode.window.showQuickPick([
    { label: '跳过任务验证', description: '报告标记为未验证', task: undefined as vscode.Task | undefined },
    ...tasks.map(task => ({ label: task.name, description: task.source, detail: describeTask(task), task })),
  ], { title: '选择一个已有的验证任务（不执行 AI 生成的命令）' });
  if (!selected?.task) return { label: '项目验证', command: '', result: '未运行：用户跳过任务验证。' };
  const task = selected.task;
  const command = describeTask(task)!;
  if (await vscode.window.showWarningMessage(`允许执行任务“${task.name}”？`, {
    modal: true, detail: `项目：${folder.name}\n范围：${task.scope === vscode.TaskScope.Workspace ? '整个工作区（可能涉及其他项目）' : '所选项目'}\n命令：${command}\n任务来自工作区，不是安全沙箱；请确认它不会部署、删除数据或产生其他不期望的副作用。`,
  }, '运行此任务') !== '运行此任务') return { label: task.name, command, result: '未运行：没有获得执行授权。' };
  const timeoutMs = Math.min(900, Math.max(10, vscode.workspace.getConfiguration('accessibilityAgent').get<number>('validationTimeoutSeconds', 120))) * 1_000;
  return runValidationTask(task, token, timeoutMs);
}

/** Execute only an already approved task; isolated for real Extension Host regression tests. */
export async function runValidationTask(task: vscode.Task, token: vscode.CancellationToken, timeoutMs: number): Promise<ValidationResult> {
  if (token.isCancellationRequested) throw new vscode.CancellationError();
  const command = describeTask(task);
  if (!command) throw new Error('仅支持前台 Shell/Process 验证任务。');
  return new Promise<ValidationResult>(resolve => {
    let execution: vscode.TaskExecution | undefined;
    let done = false;
    const disposables: vscode.Disposable[] = [];
    const finish = (result: string, exitCode?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      disposables.forEach(disposable => disposable.dispose());
      resolve({ label: task.name, command, result, exitCode });
    };
    const matches = (candidate: vscode.TaskExecution) => execution ? candidate === execution : candidate.task === task;
    const timeout = setTimeout(() => { execution?.terminate(); finish('超时：已请求终止任务；未验证通过。'); }, timeoutMs);
    disposables.push(vscode.tasks.onDidEndTaskProcess(event => {
      if (!matches(event.execution)) return;
      finish(event.exitCode === 0 ? '通过：进程退出码 0（仅代表此任务通过）。' : '失败或终止：请查看对应任务终端输出。', event.exitCode);
    }));
    disposables.push(vscode.tasks.onDidEndTask(event => {
      if (matches(event.execution)) finish('任务结束但未获得进程退出码，不能判定通过。');
    }));
    disposables.push(token.onCancellationRequested(() => { execution?.terminate(); finish('已取消：已请求终止任务。'); }));
    void vscode.tasks.executeTask(task).then(value => { execution = value; if (done) value.terminate(); }, () => {
      if (!done) { finish('任务启动失败。'); }
    });
  });
}