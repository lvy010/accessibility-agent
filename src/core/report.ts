import type { Plan } from './plan';
import type { ScanResult } from './scanner';
import type { ValidationResult } from '../validation';

export interface RunReport {
  id: string; startedAt: string; finishedAt?: string; model?: string;
  files: string[]; status: string; plan?: Plan;
  applied: boolean; saved: boolean; beforeScan?: ScanResult; afterScan?: ScanResult;
  validation?: ValidationResult; notes: string[];
}

export function escapeMarkdown(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}

function scanSection(label: string, scan?: ScanResult): string {
  if (!scan) return `## ${label}\n\n未运行。\n`;
  const c = scan.counts;
  return `## ${label}\n\n- 页面：${escapeMarkdown(scan.url)}（省略查询参数与片段）\n- 引擎：${escapeMarkdown(scan.engine)}\n- 标签：${scan.ruleTags.map(escapeMarkdown).join('、')}\n- 规则数：失败 ${c.violations} / 待复核 ${c.incomplete} / 通过 ${c.passes} / 不适用 ${c.inapplicable}\n- 被阻止的请求：${scan.blockedRequests}；条目是否截断：${scan.truncated ? '是' : '否'}\n\n${scan.issues.map(issue => `- ${escapeMarkdown(issue.id)} · ${issue.status === 'violation' ? '失败' : '待复核'}：${escapeMarkdown(issue.description)}`).join('\n')}\n`;
}

export function renderReport(run: RunReport): string {
  const plan = run.plan;
  return `# 无障碍工程交付报告\n\n> 自动检测与 AI 建议不构成完整 WCAG 合规认证。\n\n## 执行概况\n\n- 运行编号：${run.id}\n- 开始：${run.startedAt}\n- 结束：${run.finishedAt ?? '尚未结束'}\n- 状态：${escapeMarkdown(run.status)}\n- 模型：${escapeMarkdown(run.model ?? '未调用')}\n- 标准目标：WCAG 2.2 AA；扫描仅覆盖所列 axe 标签的自动规则\n- 修改已应用：${run.applied ? '是' : '否'}；修改已保存：${run.saved ? '是' : '否'}\n\n## 授权文件\n\n${run.files.map(file => `- ${escapeMarkdown(file)}`).join('\n') || '无'}\n\n## AI 审查与修复建议\n\n${escapeMarkdown(plan?.summary ?? '未生成有效修复方案。')}\n\n${plan?.findings.map(item => `- **${escapeMarkdown(item.impact)}** · ${escapeMarkdown(item.path)}：${escapeMarkdown(item.issue)}\n  - 证据：${escapeMarkdown(item.evidence)}\n  - 建议：${escapeMarkdown(item.recommendation)}`).join('\n') || '没有已记录的 AI 问题；不等同于无问题。'}\n\n${scanSection('修复前浏览器检查', run.beforeScan)}\n${scanSection('修复后浏览器检查', run.afterScan)}\n${run.beforeScan && run.afterScan ? `失败规则变化：${run.beforeScan.counts.violations} → ${run.afterScan.counts.violations}。这是规则数，不是问题节点数；页面状态及阻止请求可能影响结果。\n` : '未完成前后浏览器对比。\n'}\n## 项目验证\n\n${run.validation ? `- 任务：${escapeMarkdown(run.validation.label)}\n- 命令：${escapeMarkdown(run.validation.command)}\n- 结果：${escapeMarkdown(run.validation.result)}\n- 退出码：${run.validation.exitCode ?? '未知'}` : '未运行；不能声称代码回归验证通过。'}\n\n## 人工验收\n\n- 使用 Tab / Shift+Tab 遍历关键路径；焦点应可见、顺序合理，无意外陷阱；检查 Enter、Space、Escape 及适用的方向键。\n- 使用 NVDA、Narrator、VoiceOver 等实际读屏，确认名称、角色、状态、错误提示和动态播报。\n- 核实图片替代文本、文案含义、字幕与音频描述；检查 200% 缩放、320 CSS 像素宽度重排及对比度。\n${plan?.manualChecks.map(item => `- ${escapeMarkdown(item)}`).join('\n') ?? ''}\n\n## 覆盖限制与运行记录\n\n- 仅检查明确选择的源文件及可选 URL 的初始页面状态；不代表全站、全部路由或登录后交互。\n- 浏览器使用全新隔离上下文，无账号 Cookie；默认阻止跨源资源、非 GET/HEAD 请求与 WebSocket，未执行按钮点击。允许的 GET 仍可能有服务器副作用；这不是恶意站点安全沙箱。\n- 跨源 iframe、懒加载内容、Shadow DOM 与被阻止资源可能未完整检测；以实际页面和人工检查为准。\n${run.notes.map(note => `- ${escapeMarkdown(note)}`).join('\n')}\n`;
}