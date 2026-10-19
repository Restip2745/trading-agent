import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusSummary } from '../core/status.js';
import type { DueTrigger } from './scheduler.js';

/**
 * 依觸發類型讀取 prompts/<kind>.md，填入觸發原因與狀態摘要（規格第 9 節）。
 * 範本中的佔位符：{{mode}} {{now}} {{trigger_reason}} {{status_json}} {{notes}} {{global_summary}}
 */
export function renderPrompt(
  root: string,
  trigger: DueTrigger,
  ctx: { mode: string; now: string; status: StatusSummary; notes: string[]; globalSummary?: string },
): string {
  const path = join(root, 'prompts', `${trigger.kind}.md`);
  const fallback = join(root, 'prompts', 'interval.md');
  const template = readFileSync(existsSync(path) ? path : fallback, 'utf8');

  const notes = [...ctx.notes];
  if (trigger.missed) notes.push('系統曾中斷，這次觸發是補跑。請先確認未完成委託與持倉是否符合預期。');

  const values: Record<string, string> = {
    mode: ctx.mode.toUpperCase(),
    now: ctx.now,
    trigger_reason: trigger.reason,
    status_json: JSON.stringify(ctx.status, null, 2),
    notes: notes.length > 0 ? notes.map((n) => `- ${n}`).join('\n') : '- 無',
    global_summary: ctx.globalSummary ?? '- 無資料',
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) => values[key] ?? m);
}
