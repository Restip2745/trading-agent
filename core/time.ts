/**
 * 台灣時間工具。資料庫裡的時間一律是含 +08:00 的 ISO 8601（規格第 4 節）。
 *
 * 所有需要「現在」的函式都接受 Clock，測試時注入固定時間，
 * 不直接呼叫 new Date()。
 */

const TW_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** 以 UTC 欄位讀出的「台灣當地時間」。 */
const twFields = (d: Date) => new Date(d.getTime() + TW_OFFSET_MS);

/** 2026-10-17T09:01:00.000+08:00 */
export function toTwIso(d: Date): string {
  const t = twFields(d);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}` +
    `.${pad(t.getUTCMilliseconds(), 3)}+08:00`
  );
}

/** 2026-10-17 */
export function twDate(d: Date): string {
  const t = twFields(d);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 09:01 */
export function twHhmm(d: Date): string {
  const t = twFields(d);
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
}

/** 0 = 週日 … 6 = 週六 */
export function twWeekday(d: Date): number {
  return twFields(d).getUTCDay();
}

/** 台灣當日 00:00 的 ISO 字串，用來查詢「今天」的資料。 */
export function twDayStartIso(d: Date): string {
  return `${twDate(d)}T00:00:00.000+08:00`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}
