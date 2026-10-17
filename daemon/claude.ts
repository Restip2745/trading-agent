import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../core/config.js';

/**
 * 以 headless 模式執行 Claude Code（規格第 8、9 節）。
 *
 * 兩種權限設定檔：
 *   trading（盤中）：只能執行 ctrade、讀取專案檔案；不能寫檔、不能用 ctrade-admin、不能上網。
 *   review（收盤後）：ctrade 唯讀指令（CTRADE_READONLY=1）、讀檔、寫復盤筆記與策略 skill、git add/commit。
 * 一律搭配 --permission-mode dontAsk：沒在白名單上的工具直接拒絕，不會卡在詢問。
 */

export type Profile = 'trading' | 'review';

/**
 * 讀檔只允許專案目錄內（Read(./**)），並禁止帳本資料庫、備份與本機機密設定。
 * 不提供 Glob、Grep：交易用不到，也避免路徑規則涵蓋不到這兩個工具。
 * 冒煙測試（scripts/smoke-claude.ts）實測：專案外檔案、data/ 都會被擋下。
 */
const READ_DENY = ['Read(./data/**)', 'Read(./backup/**)', 'Read(./config/local.toml)', 'Read(./.env*)'];

const PROFILES: Record<Profile, { tools: string[]; allowed: string[]; disallowed: string[] }> = {
  trading: {
    tools: ['Bash', 'Read', 'Skill'],
    allowed: ['Bash(ctrade *)', 'Read(./**)', 'Skill'],
    disallowed: ['Bash(ctrade-admin *)', ...READ_DENY, 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
  },
  review: {
    tools: ['Bash', 'Read', 'Skill', 'Edit', 'Write'],
    allowed: [
      'Bash(ctrade *)',
      'Read(./**)',
      'Skill',
      'Edit(./reviews/**)',
      'Write(./reviews/**)',
      'Edit(./.claude/skills/trading-strategy/**)',
      'Write(./.claude/skills/trading-strategy/**)',
      'Bash(git status*)',
      'Bash(git diff*)',
      'Bash(git log*)',
      'Bash(git add *)',
      'Bash(git commit *)',
    ],
    disallowed: [
      'Bash(ctrade-admin *)',
      ...READ_DENY,
      'Edit(./.claude/skills/trading-cli/**)',
      'Write(./.claude/skills/trading-cli/**)',
      'Bash(git push*)',
      'Bash(git checkout*)',
      'Bash(git switch*)',
      'Bash(git merge*)',
      'Bash(git reset*)',
      'WebFetch',
      'WebSearch',
    ],
  },
};

export function buildClaudeArgs(config: Config, profile: Profile, model: string): string[] {
  const p = PROFILES[profile];
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--permission-mode',
    'dontAsk',
    // 只讀專案層級的設定（skills、CLAUDE.md），不帶入使用者個人的設定與 MCP
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--no-chrome',
    '--tools',
    p.tools.join(','),
    '--allowedTools',
    ...p.allowed,
    '--disallowedTools',
    ...p.disallowed,
  ];
  if (config.claude.max_budget_usd > 0) args.push('--max-budget-usd', String(config.claude.max_budget_usd));
  args.push(...config.claude.extra_args);
  return args;
}

export interface Invocation {
  triggerEventId: number;
  profile: Profile;
  model: string;
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  timeoutMs: number;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number | null;
}

export interface InvocationResult {
  status: 'ok' | 'error' | 'timeout';
  durationMs: number;
  usage?: Usage;
  error?: string;
}

/** 測試以假的實作取代，不真的呼叫 Claude。 */
export interface ClaudeInvoker {
  run(inv: Invocation): Promise<InvocationResult>;
}

/** 從 stream-json 的最後一筆 result 事件取出用量。 */
export function parseResultEvent(line: string): { usage?: Usage; isError: boolean; error?: string } | undefined {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (msg.type !== 'result') return undefined;
  const u = msg.usage ?? {};
  return {
    usage: {
      input_tokens: Number(u.input_tokens ?? 0),
      output_tokens: Number(u.output_tokens ?? 0),
      cache_read_tokens: Number(u.cache_read_input_tokens ?? 0),
      cost_usd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
    },
    isError: msg.is_error === true || (typeof msg.subtype === 'string' && msg.subtype.startsWith('error')),
    error: msg.is_error ? String(msg.result ?? msg.subtype ?? 'unknown') : undefined,
  };
}

/**
 * 子程序的環境變數：移除繼承來的 Claude Code 工作階段變數。
 *
 * daemon 若是從 Claude Code（終端機或桌面 app）裡啟動，環境中會有該工作階段注入的變數
 * （CLAUDECODE、CLAUDE_CODE_*、由 host 代管登入的 ANTHROPIC_BASE_URL 等）。
 * 子程序的 claude 繼承後會以為自己是那個工作階段的子程序，改向 host 更新登入而失敗。
 * 清掉之後一律使用本機 claude 自己的登入。使用者自行設定的認證保留：
 * ANTHROPIC_API_KEY，以及 claude setup-token 產生、以 CLAUDE_CODE_OAUTH_TOKEN 傳入的長效 token。
 */
const KEEP_ENV = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

export function childEnv(parent: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const hostManaged = parent.CLAUDE_CODE_ENTRYPOINT !== undefined || parent.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH !== undefined;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (
      !KEEP_ENV.has(key) &&
      /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|USE_LOCAL_OAUTH|USE_STAGING_OAUTH)$/.test(key)
    ) {
      continue;
    }
    if (key === 'ANTHROPIC_BASE_URL' && hostManaged) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** 以 claude auth status 確認本機 CLI 已登入（與 daemon 叫醒 Claude 時使用相同的環境）。 */
export function claudeAuthStatus(bin: string): { loggedIn: boolean; method?: string; error?: string } {
  const r = spawnSync(bin, ['auth', 'status'], { env: childEnv(process.env, {}), encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.error) return { loggedIn: false, error: r.error.message };
  try {
    const status = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
    return { loggedIn: status.loggedIn === true, method: status.authMethod };
  } catch {
    return { loggedIn: r.status === 0, error: r.stderr.trim().slice(0, 200) };
  }
}

export class ClaudeCliInvoker implements ClaudeInvoker {
  constructor(private readonly config: Config) {}

  run(inv: Invocation): Promise<InvocationResult> {
    const started = Date.now();
    mkdirSync(dirname(inv.logPath), { recursive: true });
    const log = createWriteStream(inv.logPath, { flags: 'a' });

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.config.claude.bin, buildClaudeArgs(this.config, inv.profile, inv.model), {
          cwd: inv.cwd,
          env: childEnv(process.env, inv.env),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (e) {
        log.end();
        resolve({ status: 'error', durationMs: 0, error: (e as Error).message });
        return;
      }

      let result: ReturnType<typeof parseResultEvent>;
      let stderr = '';
      let buf = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, inv.timeoutMs);

      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        log.write(chunk);
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          result = parseResultEvent(line) ?? result;
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        log.end();
        resolve({ status: 'error', durationMs: Date.now() - started, error: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf.trim()) result = parseResultEvent(buf) ?? result;
        log.end();
        const durationMs = Date.now() - started;
        if (timedOut) resolve({ status: 'timeout', durationMs, usage: result?.usage, error: `逾時 ${inv.timeoutMs / 1000} 秒` });
        else if (code !== 0 || !result || result.isError) {
          resolve({
            status: 'error',
            durationMs,
            usage: result?.usage,
            error: result?.error ?? (stderr.trim().slice(-500) || `結束碼 ${code}`),
          });
        } else resolve({ status: 'ok', durationMs, usage: result.usage });
      });

      child.stdin.end(inv.prompt);
    });
  }
}
