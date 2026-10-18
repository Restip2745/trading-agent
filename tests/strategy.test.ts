import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STRATEGY_DIR, checkStrategyFiles, strategyDiff, strategyFilesAt } from '../core/strategy.js';

let repo: string;
const sh = (...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const skill = (text: string) => writeFileSync(join(repo, STRATEGY_DIR, 'SKILL.md'), text);
const commit = (msg: string) => {
  sh('add', '-A');
  sh('commit', '-q', '-m', msg);
  return sh('rev-parse', 'HEAD');
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ctrade-strategy-'));
  mkdirSync(join(repo, STRATEGY_DIR), { recursive: true });
  sh('init', '-q');
  sh('config', 'core.autocrlf', 'false');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('策略檔與生效版本的一致性', () => {
  it('沒有生效版本或版本不存在時不一致', () => {
    skill('v1');
    commit('v1');
    expect(checkStrategyFiles(repo, null)).toMatchObject({ ok: false, reason: expect.stringContaining('尚未啟用') });
    expect(checkStrategyFiles(repo, 'a'.repeat(40))).toMatchObject({ ok: false, reason: expect.stringContaining('找不到') });
  });

  it('內容相同時一致；修改或新增檔案時列出差異', () => {
    skill('v1');
    const v1 = commit('v1');
    expect(checkStrategyFiles(repo, v1)).toEqual({ ok: true, version: v1, changed: [], reason: null });

    skill('v1 改過');
    expect(checkStrategyFiles(repo, v1)).toMatchObject({ ok: false, changed: [`${STRATEGY_DIR}/SKILL.md`] });
    expect(strategyDiff(repo, v1)).toContain('+v1 改過');

    skill('v1');
    writeFileSync(join(repo, STRATEGY_DIR, 'extra.md'), 'x');
    expect(checkStrategyFiles(repo, v1)).toMatchObject({ ok: false, changed: [`${STRATEGY_DIR}/extra.md`] });
  });

  it('策略目錄以外的修改不影響；已 commit 但未啟用的新版本視為不一致', () => {
    skill('v1');
    const v1 = commit('v1');
    writeFileSync(join(repo, 'README.md'), 'x');
    commit('readme');
    expect(checkStrategyFiles(repo, v1).ok).toBe(true);

    skill('v2');
    const v2 = commit('v2');
    expect(checkStrategyFiles(repo, v1)).toMatchObject({ ok: false, changed: [`${STRATEGY_DIR}/SKILL.md`] });
    expect(checkStrategyFiles(repo, v2).ok).toBe(true);
  });

  it('從 git 取出生效版本的內容，而不是工作目錄', () => {
    skill('v1');
    const v1 = commit('v1');
    skill('工作目錄的草稿');
    expect(strategyFilesAt(repo, v1)).toEqual([{ path: `${STRATEGY_DIR}/SKILL.md`, content: 'v1' }]);
  });
});
