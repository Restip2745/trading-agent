#!/usr/bin/env node
/**
 * daemon 進入點。
 *
 *   npm run daemon                                  # 沒有行情來源（SDK 尚未串接）
 *   npm run daemon -- --replay data/recordings/x.jsonl --speed 10
 *
 * 同一個模式只能跑一個 daemon（檔案鎖）。live 模式要等玉山券商轉接層完成才能啟動。
 */
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig, projectRoot } from '../core/config.js';
import { openDb } from '../core/db.js';
import { ipcPath } from '../core/ipc.js';
import { systemClock } from '../core/time.js';
import { type MarketFeed, NullFeed, ReplayFeed } from './feeds.js';
import { acquireLock } from './lock.js';
import { claudeAuthStatus } from './claude.js';
import { Daemon } from './service.js';

const program = new Command('ctrade-daemon')
  .option('--replay <file>', '重播錄製的行情檔（JSON Lines）')
  .option('--speed <n>', '重播倍速，0 為不等待', '1')
  .option('--keep-timestamps', '重播時保留原始事件時間（預設改寫為當下時間）')
  .option('--no-claude', '不叫醒 Claude，只提供行情、送單、停損與每日工作')
  .parse();

const opts = program.opts<{ replay?: string; speed: string; keepTimestamps?: boolean; claude: boolean }>();

/** Claude 以 Bash(ctrade *) 呼叫 CLI，ctrade 必須在 PATH 上（npm run build && npm link）。 */
function ctradeOnPath(): boolean {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ctrade'], { encoding: 'utf8' });
  return r.status === 0;
}

async function main(): Promise<void> {
  const root = projectRoot();
  const config = loadConfig(root);
  const releaseLock = acquireLock(join(root, 'data', `daemon-${config.mode}.lock`));
  const db = openDb({ root, config });

  let feed: MarketFeed;
  if (opts.replay) {
    feed = ReplayFeed.fromFile(opts.replay, { speed: Number(opts.speed), rebaseToNow: !opts.keepTimestamps });
  } else {
    feed = new NullFeed();
    console.warn('沒有行情來源：玉山行情轉接層尚未串接，報價不可用，ctrade order 會因缺報價而被拒絕');
  }

  if (opts.claude && !ctradeOnPath()) {
    console.warn('找不到 ctrade 指令：Claude 將無法操作系統。請先執行 npm run build 與 npm link');
  }
  if (opts.claude) {
    const auth = claudeAuthStatus(config.claude.bin);
    if (!auth.loggedIn) {
      console.warn(`Claude Code CLI 尚未登入（${auth.error ?? auth.method ?? 'none'}）：叫醒 Claude 會失敗。請執行 claude setup-token 或 claude auth login`);
    }
  }

  const daemon = new Daemon({
    config,
    db,
    root,
    clock: systemClock,
    feed,
    ipcPath: ipcPath(root, config.mode),
    claude: opts.claude ? undefined : false,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`收到 ${signal}，停止 daemon`);
    await daemon.stop();
    db.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await daemon.start();
  } catch (e) {
    db.close();
    releaseLock();
    throw e;
  }
}

main().catch((e) => {
  console.error(`daemon 啟動失敗：${(e as Error).message}`);
  process.exit(1);
});
