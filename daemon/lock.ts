import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { internalError } from '../core/errors.js';

/**
 * 檔案鎖：同一個模式只允許一個 daemon（規格第 17 節啟動程序第 1 步）。
 * 鎖檔內容為 pid；pid 已不存在時視為殘留，直接接手。
 */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw internalError('DAEMON_RUNNING', `daemon 已在執行（pid ${pid}，鎖檔 ${path}）`);
    }
    rmSync(path, { force: true });
  }
  const fd = openSync(path, 'wx');
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(path, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
