import { createHash } from 'node:crypto';
import { z } from 'zod';

export const MAX_RESPONSE_CHARS = 160_000;
export const MAX_FILE_CHARS = 24_000;
export const MAX_TOTAL_CHARS = 96_000;
export const sourceExtension = /\.(?:html?|jsx?|tsx?|vue|svelte|css|scss|less)$/i;

export interface SourceFile { path: string; content: string; hash: string }
export interface Change { path: string; before: string; after: string; hash: string }

const text = z.string().trim().min(1).max(2_000);
export const planSchema = z.strictObject({
  summary: text,
  findings: z.array(z.strictObject({
    path: text,
    issue: text,
    impact: z.enum(['critical', 'serious', 'moderate', 'minor']),
    evidence: text,
    recommendation: text,
  })).max(80),
  edits: z.array(z.strictObject({
    path: text,
    before: z.string().min(1).max(16_000),
    after: z.string().max(16_000),
    reason: text,
  })).max(40),
  manualChecks: z.array(text).max(30),
});
export type Plan = z.infer<typeof planSchema>;

export function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function safeRelativePath(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || /[\x00-\x1f]/.test(value)
    || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')
    || !sourceExtension.test(value)) {
    throw new Error('模型返回了不允许的文件路径。');
  }
  return value;
}

export function isCandidatePath(value: string): boolean {
  return sourceExtension.test(value)
    && !value.split('/').some(p => p.startsWith('.') || /^(?:node_modules|dist|build|vendor|coverage|out|generated|fixtures|__tests__)$/.test(p))
    && !/(?:^|[/.\-_])(?:secrets?|credentials?|tokens?|private-key)(?:[/.\-_]|$)/i.test(value)
    && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/i.test(value)
    && !/\.min\.[jc]ss?$/i.test(value);
}

export function parsePlan(raw: string): Plan {
  if (raw.length > MAX_RESPONSE_CHARS) throw new Error('模型输出超过安全大小限制。');
  const trimmed = raw.trim();
  const json = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '')
    : trimmed;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error('模型没有返回有效 JSON；未修改任何文件，请重试或更换模型。'); }
  const result = planSchema.safeParse(parsed);
  if (!result.success) throw new Error('模型结果不符合修复协议；未修改任何文件。');
  return result.data;
}

/** Only exact replacements against the consented snapshot; never create/delete files or execute model commands. */
export function buildChanges(plan: Plan, files: SourceFile[]): Change[] {
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const finding of plan.findings) {
    if (!byPath.has(safeRelativePath(finding.path))) throw new Error('模型问题引用了未授权的文件。');
  }
  const grouped = new Map<string, { start: number; end: number; after: string }[]>();
  for (const edit of plan.edits) {
    const file = byPath.get(safeRelativePath(edit.path));
    if (!file || hash(file.content) !== file.hash) throw new Error('修复不属于已授权的源文件快照。');
    const start = file.content.indexOf(edit.before);
    if (start < 0 || file.content.indexOf(edit.before, start + 1) !== -1) {
      throw new Error(`修复片段无法唯一定位：${edit.path}。未应用任何修改。`);
    }
    if (edit.before === edit.after) continue;
    const ranges = grouped.get(edit.path) ?? [];
    ranges.push({ start, end: start + edit.before.length, after: edit.after });
    grouped.set(edit.path, ranges);
  }
  return [...grouped].map(([path, ranges]) => {
    const file = byPath.get(path)!;
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i]!.start < ranges[i - 1]!.end) throw new Error(`修复片段重叠：${path}。`);
    }
    let after = file.content;
    for (const range of ranges.reverse()) after = after.slice(0, range.start) + range.after + after.slice(range.end);
    if (after.length > MAX_FILE_CHARS * 2) throw new Error('修复后的文件超出大小限制。');
    return { path, before: file.content, after, hash: file.hash };
  });
}