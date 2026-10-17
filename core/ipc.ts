import { type Server, type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { Mode } from './config.js';
import { CtradeError, ExitCode } from './errors.js';

/**
 * CLI 與 daemon 之間的本機 IPC：Windows 用 named pipe，其他平台用 Unix socket。
 * 協定為一行一則 JSON：請求 {id, method, params}，回應 {id, ok, result} 或 {id, ok: false, error}。
 *
 * 券商連線集中在 daemon（登入每日上限 300 次，見 doc/broker-api-notes.md），
 * CLI 需要報價或送單時都透過這裡。
 */

export function ipcPath(root: string, mode: Mode): string {
  if (process.env.CTRADE_IPC_PATH) return process.env.CTRADE_IPC_PATH;
  return process.platform === 'win32' ? `\\\\.\\pipe\\trading-agent-${mode}` : join(root, 'data', `daemon-${mode}.sock`);
}

interface Request {
  id: number;
  method: string;
  params?: unknown;
}

interface ErrorPayload {
  code: string;
  message: string;
  exitCode: number;
  details?: Record<string, unknown>;
}

type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: ErrorPayload };

export type Handler = (method: string, params: unknown) => unknown | Promise<unknown>;

/** 把一條連線切成一行一則 JSON。 */
function onLines(socket: Socket, cb: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) cb(line);
    }
  });
}

function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof CtradeError) return { code: e.code, message: e.message, exitCode: e.exitCode, details: e.details };
  return { code: 'DAEMON_INTERNAL', message: (e as Error)?.message ?? String(e), exitCode: ExitCode.INTERNAL };
}

export function serve(path: string, handler: Handler): Promise<Server> {
  const server = createServer((socket) => {
    socket.on('error', () => {});
    onLines(socket, async (line) => {
      let req: Request;
      try {
        req = JSON.parse(line) as Request;
      } catch {
        return;
      }
      let res: Response;
      try {
        res = { id: req.id, ok: true, result: await handler(req.method, req.params) };
      } catch (e) {
        res = { id: req.id, ok: false, error: toErrorPayload(e) };
      }
      if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export const daemonUnavailable = (detail: string) =>
  new CtradeError('DAEMON_UNAVAILABLE', `無法連線到 daemon（${detail}），請先啟動 daemon`, ExitCode.BROKER_ERROR);

/**
 * 呼叫 daemon。連不上回 DAEMON_UNAVAILABLE（結束碼 4）；已送出但逾時回 DAEMON_TIMEOUT，
 * 呼叫端要區分兩者：前者確定沒送到，後者結果不明。
 */
export function call<T = unknown>(path: string, method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let sent = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        sent
          ? new CtradeError('DAEMON_TIMEOUT', `daemon 在 ${timeoutMs / 1000} 秒內沒有回應 ${method}，結果不明`, ExitCode.BROKER_ERROR)
          : daemonUnavailable('連線逾時'),
      );
    }, timeoutMs);

    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.on('connect', () => {
      sent = true;
      socket.write(`${JSON.stringify({ id: 1, method, params } satisfies Request)}\n`);
    });
    socket.on('error', (e: NodeJS.ErrnoException) => {
      done(() =>
        reject(
          sent
            ? new CtradeError('DAEMON_DISCONNECTED', `與 daemon 的連線中斷（${e.code ?? e.message}），${method} 結果不明`, ExitCode.BROKER_ERROR)
            : daemonUnavailable(e.code ?? e.message),
        ),
      );
    });
    onLines(socket, (line) => {
      const res = JSON.parse(line) as Response;
      done(() => {
        if (res.ok) resolve(res.result as T);
        else reject(new CtradeError(res.error.code, res.error.message, res.error.exitCode as ExitCode, res.error.details));
      });
    });
  });
}
