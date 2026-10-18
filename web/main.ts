#!/usr/bin/env node
/**
 * Web UI 進入點（規格第 11 節）。只綁定 127.0.0.1。
 *
 *   npm run web                 # http://127.0.0.1:8787
 *   npm run web -- --port 9000
 *   npm run web -- --port 8788 --db <暫存路徑>/paper.db   # 測試用：改用指定的資料庫，不碰 data/
 */
import { Command } from 'commander';
import { loadConfig, projectRoot } from '../core/config.js';
import { ipcPath } from '../core/ipc.js';
import { systemClock } from '../core/time.js';
import { buildServer } from './server.js';

const opts = new Command('ctrade-web')
  .option('--port <port>', '埠號')
  .option('--db <path>', '測試用：改用指定的資料庫檔（只開這一個，不切換檢視）')
  .parse()
  .opts<{ port?: string; db?: string }>();

const root = projectRoot();
const config = loadConfig(root);
const port = Number(opts.port ?? config.web?.port ?? 8787);
const { app, close } = await buildServer({ root, config, clock: systemClock, ipcPath: ipcPath(root, config.mode), port, dbPath: opts.db });

await app.listen({ host: '127.0.0.1', port });
console.log(`Web UI：http://127.0.0.1:${port}（模式 ${config.mode.toUpperCase()}）`);

const shutdown = async () => {
  await app.close();
  close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
