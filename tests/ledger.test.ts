import { beforeEach, describe, expect, it } from 'vitest';
import { allocate, getBalance, getPosition, transferIn, transferOut, withdraw } from '../core/ledger.js';
import { createOrder } from '../core/orders.js';
import { checkLedgerConsistency } from '../core/reconcile.js';
import { type TestEnv, errorCode, makeEnv, sell } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

describe('資金撥入撥出', () => {
  it('撥入後可用資金增加', () => {
    allocate(env.db, 100_000, 'user', undefined, env.clock);
    expect(getBalance(env.db)).toEqual({ cash: 100_000, reserved: 0, available: 100_000 });
  });

  it('撥出不可超過可用資金', () => {
    allocate(env.db, 100_000, 'user', undefined, env.clock);
    expect(errorCode(() => withdraw(env.db, 100_001, 'user', undefined, env.clock))).toBe('WITHDRAW_EXCEEDS_AVAILABLE');
    withdraw(env.db, 30_000, 'user', undefined, env.clock);
    expect(getBalance(env.db).cash).toBe(70_000);
  });

  it('金額必須是正整數', () => {
    expect(errorCode(() => allocate(env.db, 0, 'user', undefined, env.clock))).toBe('INVALID_AMOUNT');
    expect(errorCode(() => allocate(env.db, 10.5, 'user', undefined, env.clock))).toBe('INVALID_AMOUNT');
  });
});

describe('持股轉入轉出', () => {
  it('轉入以指定成本計入，轉出依移動平均扣除成本', () => {
    transferIn(env.db, { symbol: '0050', qty: 300, costPerShareX100: 5000, actor: 'user' }, env.clock);
    transferIn(env.db, { symbol: '0050', qty: 100, costPerShareX100: 5400, actor: 'user' }, env.clock);
    const pos = getPosition(env.db, '0050');
    expect(pos.qty).toBe(400);
    expect(pos.avg_cost_x100).toBe(5100);

    const after = transferOut(env.db, { symbol: '0050', qty: 100, actor: 'user' }, env.clock);
    expect(after.qty).toBe(300);
    expect(after.avg_cost_x100).toBe(5100);
  });

  it('全部轉出後不留成本殘值', () => {
    transferIn(env.db, { symbol: '0050', qty: 3, costPerShareX100: 3333, actor: 'user' }, env.clock);
    transferOut(env.db, { symbol: '0050', qty: 1, actor: 'user' }, env.clock);
    transferOut(env.db, { symbol: '0050', qty: 2, actor: 'user' }, env.clock);
    expect(getPosition(env.db, '0050')).toMatchObject({ qty: 0, cost_x100: 0 });
    expect(checkLedgerConsistency(env.db)).toEqual([]);
  });

  it('轉入需確認券商持股扣除帳本已有股數後足夠', () => {
    transferIn(env.db, { symbol: '0050', qty: 600, costPerShareX100: 5000, brokerHeldQty: 1000, actor: 'user' }, env.clock);
    expect(
      errorCode(() =>
        transferIn(env.db, { symbol: '0050', qty: 500, costPerShareX100: 5000, brokerHeldQty: 1000, actor: 'user' }, env.clock),
      ),
    ).toBe('TRANSFER_EXCEEDS_USER_HOLDING');
  });

  it('轉出不可超過可賣股數（扣除未完成賣單）', () => {
    allocate(env.db, 100_000, 'user', undefined, env.clock);
    transferIn(env.db, { symbol: '0050', qty: 300, costPerShareX100: 5000, actor: 'user' }, env.clock);
    createOrder(env.db, sell('0050', 200, 5000), env.ctx);
    expect(errorCode(() => transferOut(env.db, { symbol: '0050', qty: 200, actor: 'user' }, env.clock))).toBe(
      'TRANSFER_EXCEEDS_SELLABLE',
    );
  });
});

describe('流水只增不改', () => {
  it('不能 UPDATE 或 DELETE 資金與持股流水', () => {
    allocate(env.db, 100_000, 'user', undefined, env.clock);
    expect(() => env.db.prepare('UPDATE cash_movements SET amount = 1').run()).toThrow(/只能新增/);
    expect(() => env.db.prepare('DELETE FROM cash_movements').run()).toThrow(/只能新增/);
    transferIn(env.db, { symbol: '0050', qty: 1, costPerShareX100: 5000, actor: 'user' }, env.clock);
    expect(() => env.db.prepare('DELETE FROM position_movements').run()).toThrow(/只能新增/);
  });
});
