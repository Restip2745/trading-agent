import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { CtradeError, ExitCode, invalidArgs } from './errors.js';

/**
 * 玉山 API 的機密一律存放在作業系統的金鑰管理（Windows 認證管理員），由 keytar 讀寫（規格第 12 節）。
 * 不寫進設定檔、不出現在命令列參數或日誌。
 *
 * 三組設定，各存成一筆：
 *   esun-live        交易：正式環境（live 模式送單）；沒有 esun-marketdata 時也用來接行情
 *   esun-marketdata  行情：選用的獨立行情金鑰（paper 與 live 都使用真實行情）
 *   esun-sim         交易：玉山模擬環境，只用來測試下單串接。paper 模式不使用（本地模擬撮合，不送單）
 */

export const SECRET_PROFILES = ['esun-sim', 'esun-live', 'esun-marketdata'] as const;
export type SecretProfile = (typeof SECRET_PROFILES)[number];

const SERVICE = 'trading-agent';

export interface EsunCredentials {
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  /** 證券帳號 */
  aid: string;
  /** 證券登入密碼 */
  password: string;
  /** 憑證密碼 */
  certPass: string;
  /** .p12 憑證檔的絕對路徑（放在專案目錄以外） */
  certPath: string;
}

interface Keytar {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

/** keytar 是 CommonJS 原生模組；延遲載入，讓不需要機密的指令不受影響。 */
function keytar(): Keytar {
  return createRequire(import.meta.url)('keytar') as Keytar;
}

export interface SecretStore {
  get(profile: SecretProfile): Promise<EsunCredentials | undefined>;
  set(profile: SecretProfile, creds: EsunCredentials): Promise<void>;
  delete(profile: SecretProfile): Promise<boolean>;
}

export const keyringStore: SecretStore = {
  async get(profile) {
    const raw = await keytar().getPassword(SERVICE, profile);
    return raw ? (JSON.parse(raw) as EsunCredentials) : undefined;
  },
  async set(profile, creds) {
    validateCredentials(creds);
    await keytar().setPassword(SERVICE, profile, JSON.stringify(creds));
  },
  async delete(profile) {
    return keytar().deletePassword(SERVICE, profile);
  },
};

export function parseProfile(v: string): SecretProfile {
  if (!(SECRET_PROFILES as readonly string[]).includes(v)) {
    throw invalidArgs('INVALID_PROFILE', `設定名稱須為 ${SECRET_PROFILES.join('、')}，收到 ${v}`);
  }
  return v as SecretProfile;
}

export async function requireCredentials(store: SecretStore, profile: SecretProfile): Promise<EsunCredentials> {
  const creds = await store.get(profile);
  if (!creds) {
    throw new CtradeError(
      'CREDENTIALS_MISSING',
      `金鑰管理中沒有 ${profile} 的設定，請先執行 ctrade-admin secrets import ${profile} --ini <玉山金鑰設定檔>`,
      ExitCode.BROKER_ERROR,
    );
  }
  return creds;
}

/**
 * 行情用的金鑰：優先使用 esun-marketdata，沒有時改用 esun-live。
 * 正式環境的金鑰可以同時用於行情；行情 SDK 只能查詢行情、無法下單，paper 模式使用也不會送出委託。
 */
export async function resolveMarketCredentials(
  store: SecretStore,
): Promise<{ profile: SecretProfile; creds: EsunCredentials } | undefined> {
  for (const profile of ['esun-marketdata', 'esun-live'] as const) {
    const creds = await store.get(profile);
    if (creds) return { profile, creds };
  }
  return undefined;
}

export function validateCredentials(c: EsunCredentials): void {
  for (const key of ['apiUrl', 'apiKey', 'apiSecret', 'aid', 'password', 'certPass', 'certPath'] as const) {
    if (!c[key]) throw invalidArgs('CREDENTIALS_INCOMPLETE', `缺少 ${key}`);
  }
  if (!/^https:\/\//.test(c.apiUrl)) throw invalidArgs('CREDENTIALS_INVALID', 'apiUrl 必須是 https 網址');
  if (!isAbsolute(c.certPath)) throw invalidArgs('CREDENTIALS_INVALID', '憑證路徑必須是絕對路徑');
  if (!existsSync(c.certPath)) throw invalidArgs('CREDENTIALS_INVALID', `找不到憑證檔 ${c.certPath}`);
}

/**
 * 讀取玉山金鑰網站下載的 config.ini（[Core] Entry、[Api] Key/Secret、[User] Account、[Cert] Path）。
 * 密碼不在檔案中，由呼叫端另外以隱藏輸入取得。
 */
export function readEsunIni(path: string): Pick<EsunCredentials, 'apiUrl' | 'apiKey' | 'apiSecret' | 'aid'> & { certPath?: string; environment?: string } {
  if (!existsSync(path)) throw invalidArgs('INI_MISSING', `找不到設定檔 ${path}`);
  const sections: Record<string, Record<string, string>> = {};
  let current = '';
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)]$/.exec(line);
    if (sec) {
      current = sec[1]!.trim().toLowerCase();
      sections[current] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) (sections[current] ??= {})[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  const get = (s: string, k: string) => sections[s]?.[k] ?? '';
  const certRaw = get('cert', 'path');
  return {
    apiUrl: get('core', 'entry'),
    apiKey: get('api', 'key'),
    apiSecret: get('api', 'secret'),
    aid: get('user', 'account'),
    environment: get('core', 'environment') || undefined,
    // 官方範本的 Path 是 ";Your Cert File Path …" 這種註解佔位文字
    certPath: certRaw && !certRaw.startsWith(';') ? certRaw : undefined,
  };
}

/** 只露頭尾，用於顯示。 */
export function mask(secret: string, keep = 3): string {
  if (secret.length <= keep * 2) return '*'.repeat(secret.length);
  return `${secret.slice(0, keep)}${'*'.repeat(Math.min(8, secret.length - keep * 2))}${secret.slice(-keep)}`;
}

export function maskedCredentials(c: EsunCredentials) {
  return {
    apiUrl: c.apiUrl,
    apiKey: mask(c.apiKey),
    apiSecret: mask(c.apiSecret),
    aid: mask(c.aid, 2),
    password: '********',
    certPass: '********',
    certPath: c.certPath,
  };
}

export const isSimulationUrl = (url: string) => /simulation/i.test(url);
