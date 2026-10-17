import { readFileSync } from 'node:fs';
import type { MarketEvent } from '../core/marketdata.js';
import { toTwIso } from '../core/time.js';

/**
 * 行情來源。daemon 只認這個介面：玉山 SDK 的轉接層（待 SDK 放進 vendor/ 後實作）、
 * 錄製檔重播、測試用的手動推送，都實作同一個介面。
 */
export interface MarketFeed {
  readonly name: string;
  start(onEvent: (e: MarketEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** 行情來源訂閱這些代號；重播與手動來源忽略。 */
  subscribe?(symbols: string[]): Promise<void>;
  candles?(symbol: string, interval: string, count: number): Promise<unknown[]>;
}

/** 沒有行情來源時使用：daemon 仍可提供帳本查詢與刪單，但沒有報價就無法下單。 */
export class NullFeed implements MarketFeed {
  readonly name = 'none';
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

/** 測試用：由測試程式直接推送事件。 */
export class ManualFeed implements MarketFeed {
  readonly name = 'manual';
  private onEvent?: (e: MarketEvent) => void;

  async start(onEvent: (e: MarketEvent) => void): Promise<void> {
    this.onEvent = onEvent;
  }

  async stop(): Promise<void> {
    this.onEvent = undefined;
  }

  push(...events: MarketEvent[]): void {
    for (const e of events) this.onEvent?.(e);
  }
}

export function readRecording(path: string): MarketEvent[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trimStart().startsWith('//'))
    .map((line) => JSON.parse(line) as MarketEvent);
}

export interface ReplayOptions {
  /** 播放倍速；0 代表不等待，依序立即送出。 */
  speed: number;
  /** 把事件時間改寫成送出當下的時間，讓錄製檔可以在今天重播（CLI 以真實時間建立委託）。 */
  rebaseToNow: boolean;
}

/**
 * 重播錄製的行情（JSON Lines，一行一個 MarketEvent）。依原始時間間隔與倍速送出。
 */
export class ReplayFeed implements MarketFeed {
  readonly name = 'replay';
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly events: MarketEvent[],
    private readonly opts: ReplayOptions,
  ) {}

  static fromFile(path: string, opts: ReplayOptions): ReplayFeed {
    return new ReplayFeed(readRecording(path), opts);
  }

  async start(onEvent: (e: MarketEvent) => void): Promise<void> {
    this.stopped = false;
    const emit = (e: MarketEvent) => onEvent(this.opts.rebaseToNow ? { ...e, ts: toTwIso(new Date()) } : e);

    if (this.opts.speed <= 0) {
      for (const e of this.events) {
        if (this.stopped) return;
        emit(e);
      }
      return;
    }

    let i = 0;
    const next = () => {
      if (this.stopped || i >= this.events.length) return;
      const e = this.events[i++]!;
      emit(e);
      const following = this.events[i];
      if (!following) return;
      const gap = Math.max(0, (Date.parse(following.ts) - Date.parse(e.ts)) / this.opts.speed);
      this.timer = setTimeout(next, gap);
    };
    next();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
