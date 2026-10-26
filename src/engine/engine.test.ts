import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountEntries, allocate, computeBalances, effectsOf, emptyTx, formatAmount, normalizeTx, pairwiseDebts,
  parseAmount, refundedTotal, settlementPlan, spendingBy, toMajor, validateTx,
  type Account, type LedgerCtx, type Person, type Tx,
} from './index.ts';

// --- fixtures -------------------------------------------------------------------------------
const [ME, ALICE, BOB, CARA] = [1, 2, 3, 4];
const people: Person[] = [
  { id: ME, name: 'Me', is_me: 1, archived: 0 },
  { id: ALICE, name: 'Alice', is_me: 0, archived: 0 },
  { id: BOB, name: 'Bob', is_me: 0, archived: 0 },
  { id: CARA, name: 'Cara', is_me: 0, archived: 0 },
];
const BANK = 10, CASH_SGD = 11, CASH_INR = 12, CARD = 13, ALICE_WALLET = 14;
const accounts: Account[] = [
  { id: BANK, person_id: ME, name: 'HDFC', type: 'bank', currency: 'INR', opening_balance: 5_000_000, archived: 0 },
  { id: CASH_SGD, person_id: ME, name: 'SGD cash', type: 'cash', currency: 'SGD', opening_balance: 0, archived: 0 },
  { id: CASH_INR, person_id: ME, name: 'INR cash', type: 'cash', currency: 'INR', opening_balance: 0, archived: 0 },
  { id: CARD, person_id: ME, name: 'Credit card', type: 'card', currency: 'INR', opening_balance: 0, archived: 0 },
  { id: ALICE_WALLET, person_id: ALICE, name: 'Alice wallet', type: 'cash', currency: 'SGD', opening_balance: 0, archived: 0 },
];
let nextId = 100;
const mk = (p: Partial<Tx>): Tx => ({ ...emptyTx(), id: nextId++, date: '2026-03-10', description: 'x', created_at: '', updated_at: '', ...p }) as Tx;
const equal = (amount: number, ids: number[]) => allocate(amount, ids.map(() => 1)).map((a, i) => ({ person_id: ids[i]!, amount: a, input: null }));
const ctx = (transactions: Tx[] = []): LedgerCtx => ({ people, accounts, trips: [{ id: 1, name: 'SG', start_date: null, end_date: null, currency: 'SGD', notes: null, archived: 0, members: [ME, ALICE, BOB, CARA] }], transactions });
const pairs = (b: ReturnType<typeof computeBalances>) => pairwiseDebts(b).map((d) => `${d.from}->${d.to} ${d.currency} ${d.amount}`);

// --- money ------------------------------------------------------------------------------------
test('parseAmount is exact and strict', () => {
  assert.equal(parseAmount('12.34', 'SGD'), 1234);
  assert.equal(parseAmount('1,234', 'SGD'), 123400);
  assert.equal(parseAmount('0.5', 'SGD'), 50);
  assert.equal(parseAmount('-3.10', 'SGD'), -310);
  assert.equal(parseAmount('5', 'JPY'), 5);
  assert.equal(parseAmount('1.050', 'KWD'), 1050);
  assert.equal(parseAmount('12.345', 'SGD'), null);
  assert.equal(parseAmount('5.5', 'JPY'), null);
  assert.equal(parseAmount('abc', 'SGD'), null);
  assert.equal(parseAmount('', 'SGD'), null);
  assert.equal(parseAmount('.', 'SGD'), null);
});

test('formatAmount and toMajor', () => {
  assert.equal(formatAmount(123450, 'SGD'), 'SGD 1,234.50');
  assert.equal(formatAmount(-5, 'JPY'), '-JPY 5');
  assert.equal(formatAmount(1050, 'KWD', false), '1.050');
  assert.equal(formatAmount(7, 'INR'), 'INR 0.07');
  assert.equal(toMajor(123450, 'SGD'), '1234.50');
  assert.equal(toMajor(-7, 'INR'), '-0.07');
});

test('allocate: largest remainder, deterministic, always sums to total', () => {
  assert.deepEqual(allocate(1000, [1, 1, 1]), [334, 333, 333]);
  assert.deepEqual(allocate(-1000, [1, 1, 1]), [-334, -333, -333]);
  assert.deepEqual(allocate(100, [50, 50]), [50, 50]);
  assert.deepEqual(allocate(1000, [33.33, 33.33, 33.34]), [333, 333, 334]);
  assert.deepEqual(allocate(7, [1, 2]), [2, 5]);
  assert.deepEqual(allocate(10, [0, 1]), [0, 10]);
  assert.deepEqual(allocate(1, [0, 1, 1]), [0, 1, 0]);
  assert.throws(() => allocate(10, [0, 0]));
  assert.throws(() => allocate(10.5, [1]));
  for (let t = 0; t < 500; t++) {
    const parts = allocate(t, [3, 7, 11, 0.5]);
    assert.equal(parts.reduce((a, b) => a + b, 0), t);
  }
});

// --- effects ------------------------------------------------------------------------------------
test('expense: spending, account debit, participants owe payer', () => {
  const tx = mk({ type: 'expense', currency: 'SGD', amount: 12000, payer_id: ME, from_account_id: CASH_SGD, splits: equal(12000, [ME, ALICE, BOB, CARA]) });
  const e = effectsOf(tx);
  assert.equal(e.spending, 12000);
  assert.deepEqual(e.accounts, [{ account_id: CASH_SGD, amount: -12000 }]);
  assert.deepEqual(e.debts, [ALICE, BOB, CARA].map((p) => ({ from: p, to: ME, currency: 'SGD', amount: 3000 })));
});

test('expense paid from an account in another currency debits the charged amount', () => {
  const tx = mk({ type: 'expense', currency: 'SGD', amount: 10000, payer_id: ME, from_account_id: CARD, from_amount: 630000, splits: equal(10000, [ME]) });
  const e = effectsOf(tx);
  assert.equal(e.spending, 10000);
  assert.deepEqual(e.accounts, [{ account_id: CARD, amount: -630000 }]);
  assert.deepEqual(e.debts, []);
});

test('transfer with exchange and fee: no spending, both legs explicit, fee separate', () => {
  const tx = mk({ type: 'withdrawal', currency: 'INR', amount: 1_000_000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_SGD, to_amount: 16000, fee_amount: 20000 });
  const e = effectsOf(tx);
  assert.equal(e.spending, 0);
  assert.equal(e.fee, 20000);
  assert.deepEqual(e.accounts, [{ account_id: BANK, amount: -1_020_000 }, { account_id: CASH_SGD, amount: 16000 }]);
  assert.deepEqual(e.debts, []);
});

test('income credits the account and is not spending', () => {
  const e = effectsOf(mk({ type: 'income', currency: 'INR', amount: 500000, payer_id: ME, to_account_id: BANK }));
  assert.equal(e.spending, 0);
  assert.equal(e.income, 500000);
  assert.deepEqual(e.accounts, [{ account_id: BANK, amount: 500000 }]);
});

// --- scenarios from the brief ----------------------------------------------------------------
test('withdraw SGD 500, spend SGD 300 shared, SGD 200 remains: spending is 300, not 800', () => {
  const txs = [
    mk({ type: 'withdrawal', date: '2026-03-01', currency: 'INR', amount: 3_100_000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_SGD, to_amount: 50000, fee_amount: 20000, trip_id: 1 }),
    mk({ type: 'expense', date: '2026-03-02', currency: 'SGD', amount: 30000, payer_id: ME, from_account_id: CASH_SGD, trip_id: 1, splits: equal(30000, [ME, ALICE, BOB]) }),
  ];
  const b = computeBalances(txs, accounts);
  assert.equal(b.accounts.get(CASH_SGD), 20000);
  assert.equal(b.accounts.get(BANK), 5_000_000 - 3_100_000 - 20000);
  const spend = spendingBy(txs, (t) => String(t.trip_id));
  assert.deepEqual([...spend.get('1')!], [['SGD', 30000]]);
  assert.deepEqual(pairs(b), ['2->1 SGD 10000', '3->1 SGD 10000']);
});

test('SGD 120 dinner for four, friend repays SGD 30: balance drops, no new expense', () => {
  const dinner = mk({ type: 'expense', currency: 'SGD', amount: 12000, payer_id: ME, from_account_id: CASH_SGD, trip_id: 1, splits: equal(12000, [ME, ALICE, BOB, CARA]) });
  const repay = mk({ type: 'repayment', currency: 'SGD', amount: 3000, payer_id: BOB, payee_id: ME, to_account_id: CASH_SGD, trip_id: 1, method: 'cash' });
  const b = computeBalances([dinner, repay], accounts);
  assert.deepEqual(pairs(b), ['2->1 SGD 3000', '4->1 SGD 3000']);
  assert.equal(b.net.get(ME)!.get('SGD'), 6000);
  assert.equal(b.net.get(BOB)!.get('SGD'), 0);
  assert.equal(b.accounts.get(CASH_SGD), -12000 + 3000);
  const spend = spendingBy([dinner, repay], () => 'all');
  assert.equal(spend.get('all')!.get('SGD'), 12000);
});

test('partial repayments accumulate and can flip the direction', () => {
  const dinner = mk({ type: 'expense', currency: 'SGD', amount: 12000, payer_id: ME, splits: equal(12000, [ME, ALICE, BOB, CARA]) });
  const r1 = mk({ type: 'repayment', currency: 'SGD', amount: 1000, payer_id: ALICE, payee_id: ME });
  const r2 = mk({ type: 'repayment', currency: 'SGD', amount: 2500, payer_id: ALICE, payee_id: ME });
  assert.deepEqual(pairs(computeBalances([dinner, r1])), ['2->1 SGD 2000', '3->1 SGD 3000', '4->1 SGD 3000']);
  assert.deepEqual(pairs(computeBalances([dinner, r1, r2])), ['1->2 SGD 500', '3->1 SGD 3000', '4->1 SGD 3000']);
});

test('partial refund linked to an expense reduces spending and each share pro-rata', () => {
  const dinner = mk({ type: 'expense', currency: 'SGD', amount: 12000, payer_id: ME, from_account_id: CASH_SGD, trip_id: 1, splits: equal(12000, [ME, ALICE, BOB, CARA]) });
  const refundSplits = allocate(4000, dinner.splits.map((s) => s.amount)).map((a, i) => ({ person_id: dinner.splits[i]!.person_id, amount: a, input: null }));
  const refund = mk({ type: 'refund', currency: 'SGD', amount: 4000, payer_id: ME, to_account_id: CASH_SGD, trip_id: 1, linked_tx_id: dinner.id, splits: refundSplits });
  const txs = [dinner, refund];
  const b = computeBalances(txs, accounts);
  assert.deepEqual(pairs(b), ['2->1 SGD 2000', '3->1 SGD 2000', '4->1 SGD 2000']);
  assert.equal(b.accounts.get(CASH_SGD), -8000);
  assert.equal(spendingBy(txs, () => 'all').get('all')!.get('SGD'), 8000);
  assert.equal(txs.filter((t) => t.type === 'expense').length, 1, 'original expense is kept');
  assert.equal(refundedTotal(txs, dinner.id), 4000);
  assert.ok(validateTx(mk({ ...refund, id: 999, amount: 9000, splits: equal(9000, [ME, ALICE, BOB, CARA]) }), ctx(txs)).some((e) => /exceed/.test(e)));
});

test('cross-currency repayment: INR 2,000 settles SGD 32.50 of debt, no implicit conversion', () => {
  const lunch = mk({ type: 'expense', currency: 'SGD', amount: 6500, payer_id: ME, splits: equal(6500, [ME, ALICE]) });
  const repay = mk({ type: 'repayment', currency: 'INR', amount: 200000, settled_currency: 'SGD', settled_amount: 3250, payer_id: ALICE, payee_id: ME, to_account_id: CASH_INR, method: 'UPI' });
  const b = computeBalances([lunch, repay], accounts);
  assert.deepEqual(pairs(b), []);
  assert.equal(b.accounts.get(CASH_INR), 200000);
  assert.equal(validateTx(repay, ctx([lunch])).length, 0);
  assert.ok(validateTx(mk({ ...repay, settled_amount: null }), ctx([lunch])).some((e) => /settles/.test(e)));
});

test('debts stay per currency', () => {
  const txs = [
    mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, splits: equal(1000, [ME, ALICE]) }),
    mk({ type: 'expense', currency: 'INR', amount: 1000, payer_id: ALICE, splits: equal(1000, [ME, ALICE]) }),
  ];
  assert.deepEqual(pairs(computeBalances(txs)), ['1->2 INR 500', '2->1 SGD 500']);
});

test('trip-scoped balances only use that trip', () => {
  const txs = [
    mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, trip_id: 1, splits: equal(1000, [ME, ALICE]) }),
    mk({ type: 'expense', currency: 'SGD', amount: 4000, payer_id: ALICE, trip_id: null, splits: equal(4000, [ME, ALICE]) }),
  ];
  assert.deepEqual(pairs(computeBalances(txs.filter((t) => t.trip_id === 1))), ['2->1 SGD 500']);
  assert.deepEqual(pairs(computeBalances(txs)), ['1->2 SGD 1500']);
});

test('settlement plan is minimal and deterministic', () => {
  const net = new Map([
    [ME, new Map([['SGD', 5000]])],
    [ALICE, new Map([['SGD', -2000]])],
    [BOB, new Map([['SGD', -3000]])],
  ]);
  assert.deepEqual(settlementPlan(net), [
    { from: BOB, to: ME, currency: 'SGD', amount: 3000 },
    { from: ALICE, to: ME, currency: 'SGD', amount: 2000 },
  ]);
  // chain A owes B, B owes C collapses to A pays C
  const chain = computeBalances([
    mk({ type: 'expense', currency: 'SGD', amount: 2000, payer_id: BOB, splits: equal(2000, [BOB, ALICE]) }),
    mk({ type: 'expense', currency: 'SGD', amount: 2000, payer_id: CARA, splits: equal(2000, [CARA, BOB]) }),
  ]);
  assert.deepEqual(settlementPlan(chain.net), [{ from: ALICE, to: CARA, currency: 'SGD', amount: 1000 }]);
  assert.deepEqual(pairs(chain), ['2->3 SGD 1000', '3->4 SGD 1000']);
});

test('accountEntries gives a running balance in date order', () => {
  const txs = [
    mk({ type: 'expense', date: '2026-03-05', currency: 'SGD', amount: 700, payer_id: ME, from_account_id: CASH_SGD, splits: equal(700, [ME]) }),
    mk({ type: 'withdrawal', date: '2026-03-01', currency: 'INR', amount: 100000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_SGD, to_amount: 1600 }),
  ];
  const rows = accountEntries(txs, accounts[1]!);
  assert.deepEqual(rows.map((r) => [r.delta, r.balance]), [[1600, 1600], [-700, 900]]);
});

// --- validation ---------------------------------------------------------------------------------
test('validateTx catches the dangerous mistakes', () => {
  const ok = mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, from_account_id: CASH_SGD, splits: equal(1000, [ME, ALICE]) });
  assert.deepEqual(validateTx(ok, ctx()), []);
  const has = (tx: Tx, re: RegExp) => assert.ok(validateTx(tx, ctx()).some((e) => re.test(e)), `expected ${re} in ${validateTx(tx, ctx()).join(' | ')}`);
  has(mk({ ...ok, splits: [{ person_id: ME, amount: 999, input: null }] }), /add up/);
  has(mk({ ...ok, splits: [] }), /participant/);
  has(mk({ ...ok, from_account_id: ALICE_WALLET }), /belong/);
  has(mk({ ...ok, from_account_id: CARD }), /enter the amount in INR/);
  has(mk({ ...ok, amount: 0, splits: [] }), /greater than zero/);
  has(mk({ ...ok, date: '2026-13-40' }), /Date/);
  has(mk({ ...ok, currency: 'sgd' }), /Currency/);
  has(mk({ ...ok, payer_id: null }), /Payer/);
  has(mk({ ...ok, description: '' }), /Description/);
  has(mk({ type: 'withdrawal', currency: 'INR', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: CARD }), /cash holding/);
  has(mk({ type: 'transfer', currency: 'INR', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: BANK }), /differ/);
  has(mk({ type: 'transfer', currency: 'INR', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_SGD }), /enter the amount in SGD/);
  has(mk({ type: 'transfer', currency: 'SGD', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_SGD }), /source account currency/);
  has(mk({ type: 'repayment', currency: 'SGD', amount: 1000, payer_id: ME, payee_id: ME }), /differ/);
  has(mk({ type: 'repayment', currency: 'SGD', amount: 1000, payer_id: ALICE, payee_id: ME, to_account_id: ALICE_WALLET }), /belong/);
  has(mk({ type: 'refund', currency: 'SGD', amount: 1000, payer_id: ME, linked_tx_id: 999, splits: equal(1000, [ME]) }), /linked/);
  assert.deepEqual(validateTx(mk({ type: 'transfer', currency: 'INR', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_INR }), ctx()), []);
  assert.deepEqual(validateTx(mk({ type: 'income', currency: 'INR', amount: 1000, payer_id: ME, to_account_id: BANK }), ctx()), []);
});

test('normalizeTx drops fields that do not belong to the type', () => {
  const n = normalizeTx({ type: 'transfer', date: '2026-01-01', currency: 'inr', amount: 100, payer_id: '1', from_account_id: '10', to_account_id: '12', splits: [{ person_id: 1, amount: 100 }], fee_amount: '', notes: '  ' });
  assert.equal(n.currency, 'INR');
  assert.deepEqual(n.splits, []);
  assert.equal(n.split_method, null);
  assert.equal(n.fee_amount, null);
  assert.equal(n.notes, null);
  assert.equal(n.from_account_id, 10);
  const r = normalizeTx({ type: 'refund', date: '2026-01-01', currency: 'SGD', amount: 100, payer_id: 1, from_account_id: 11, to_account_id: 11, linked_tx_id: 5, splits: [{ person_id: 1, amount: 100, input: '' }] });
  assert.equal(r.from_account_id, null);
  assert.equal(r.to_account_id, 11);
  assert.equal(r.linked_tx_id, 5);
  assert.deepEqual(r.splits, [{ person_id: 1, amount: 100, input: null }]);
});

// --- more edge cases -------------------------------------------------------------------------
test('parseAmount rejects anything that is not a plain decimal', () => {
  for (const bad of ['1e3', '+5', '--1', '1.2.3', '$5', '5 SGD', 'NaN', 'Infinity', '0x10']) assert.equal(parseAmount(bad, 'SGD'), null, bad);
  assert.equal(parseAmount(' 1 234.5 ', 'SGD'), 123450);
  assert.equal(parseAmount('007.10', 'SGD'), 710);
  assert.equal(parseAmount('99999999999.99', 'SGD'), 9_999_999_999_999);
  assert.equal(parseAmount('-0', 'SGD'), 0);
});

test('allocate never loses or invents a minor unit, even with awkward weights and large totals', () => {
  const cases: [number, number[]][] = [[1_000_000_000_000, [1, 1, 1]], [999_999, [0.1, 0.2, 0.7]], [5, [33.333, 33.333, 33.334]], [100, [1, 0, 0, 1]], [1, [1, 1, 1, 1, 1]]];
  for (const [total, w] of cases) {
    const parts = allocate(total, w);
    assert.equal(parts.length, w.length);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total} / ${w}`);
    assert.ok(parts.every((p) => p >= 0));
  }
  assert.deepEqual(allocate(100, [1, 0, 0, 1]), [50, 0, 0, 50]);
  assert.deepEqual(allocate(1, [1, 1, 1, 1, 1]), [1, 0, 0, 0, 0]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.throws(() => allocate(10, [-1, 2]));
  assert.throws(() => allocate(10, [Number.NaN, 2]));
});

test('effects: edge cases per type', () => {
  // standalone refund (no link) still reduces spending and credits its participants
  const r = effectsOf(mk({ type: 'refund', currency: 'SGD', amount: 1000, payer_id: ME, to_account_id: CASH_SGD, splits: equal(1000, [ME, ALICE]) }));
  assert.equal(r.spending, -1000);
  assert.deepEqual(r.debts, [{ from: ME, to: ALICE, currency: 'SGD', amount: 500 }]);
  assert.deepEqual(r.accounts, [{ account_id: CASH_SGD, amount: 1000 }]);
  // repayment between two friends touches no account of mine
  const p = effectsOf(mk({ type: 'repayment', currency: 'SGD', amount: 700, payer_id: BOB, payee_id: CARA }));
  assert.deepEqual(p.accounts, []);
  assert.deepEqual(p.debts, [{ from: CARA, to: BOB, currency: 'SGD', amount: 700 }]);
  assert.equal(p.spending, 0);
  // transfer in one currency: fee is not spending, both legs move
  const t = effectsOf(mk({ type: 'transfer', currency: 'INR', amount: 10_000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_INR, fee_amount: 50 }));
  assert.equal(t.spending, 0);
  assert.equal(t.fee, 50);
  assert.deepEqual(t.accounts, [{ account_id: BANK, amount: -10_050 }, { account_id: CASH_INR, amount: 10_000 }]);
  // zero-share participants create no debt
  const z = effectsOf(mk({ type: 'expense', currency: 'SGD', amount: 100, payer_id: ME, splits: [{ person_id: ME, amount: 100, input: null }, { person_id: ALICE, amount: 0, input: null }] }));
  assert.deepEqual(z.debts, []);
});

test('validateTx: more rejected shapes', () => {
  const has = (tx: Tx, re: RegExp) => {
    const errs = validateTx(tx, ctx());
    assert.ok(errs.some((e) => re.test(e)), `expected ${re} in [${errs.join(' | ')}]`);
  };
  has(mk({ type: 'income', currency: 'INR', amount: 100, payer_id: ME, from_account_id: BANK }), /Source account does not apply/);
  has(mk({ type: 'income', currency: 'INR', amount: 100, payer_id: ME, to_account_id: ALICE_WALLET }), /belong/);
  has(mk({ type: 'repayment', currency: 'SGD', amount: 1000, settled_amount: 999, payer_id: ALICE, payee_id: ME }), /Settled amount must equal/);
  has(mk({ type: 'repayment', currency: 'SGD', amount: 1000, settled_currency: 'INR', payer_id: ALICE, payee_id: ME }), /settles/);
  has(mk({ type: 'transfer', currency: 'INR', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_INR, fee_amount: -5 }), /Fee must be zero or more/);
  has(mk({ type: 'transfer', currency: 'INR', amount: 1000, payer_id: ME, from_account_id: BANK, to_account_id: CASH_INR, splits: equal(1000, [ME]) }), /Participants does not apply/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, splits: [{ person_id: 999, amount: 1000, input: null }] }), /Participant not found/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, splits: [{ person_id: ME, amount: 1500, input: null }, { person_id: ALICE, amount: -500, input: null }] }), /non-negative/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, splits: [{ person_id: ME, amount: 500, input: null }, { person_id: ME, amount: 500, input: null }] }), /twice/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, from_account_id: CASH_SGD, from_amount: 999, splits: equal(1000, [ME]) }), /must equal 1000/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, from_amount: 1000, splits: equal(1000, [ME]) }), /without an account/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1.5, payer_id: ME, splits: equal(1, [ME]) }), /Amount/);
  has(mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, description: 'x'.repeat(201), splits: equal(1000, [ME]) }), /too long/);
  const orig = mk({ type: 'expense', currency: 'SGD', amount: 1000, payer_id: ME, trip_id: 1, splits: equal(1000, [ME, ALICE]) });
  const c = ctx([orig]);
  const bad = (p: Partial<Tx>, re: RegExp) => assert.ok(validateTx(mk({ type: 'refund', currency: 'SGD', amount: 200, payer_id: ME, trip_id: 1, linked_tx_id: orig.id, splits: equal(200, [ME, ALICE]), ...p }), c).some((e) => re.test(e)), String(re));
  bad({ payer_id: ALICE }, /original payer/);
  bad({ trip_id: null }, /same trip/);
  bad({ currency: 'INR', splits: equal(200, [ME, ALICE]) }, /must be in SGD/);
  assert.deepEqual(validateTx(mk({ type: 'refund', currency: 'SGD', amount: 200, payer_id: ME, trip_id: 1, linked_tx_id: orig.id, splits: equal(200, [ME, ALICE]) }), c), []);
  assert.deepEqual(validateTx(mk({ type: 'repayment', currency: 'SGD', amount: 1000, payer_id: ALICE, payee_id: ME, from_account_id: ALICE_WALLET, to_account_id: CASH_SGD }), ctx()), [], 'both sides tracked');
});

test('settlement plan handles several currencies and skips settled people', () => {
  const txs = [
    mk({ type: 'expense', currency: 'SGD', amount: 3000, payer_id: ME, splits: equal(3000, [ME, ALICE, BOB]) }),
    mk({ type: 'expense', currency: 'INR', amount: 3000, payer_id: CARA, splits: equal(3000, [CARA, ALICE, BOB]) }),
    mk({ type: 'repayment', currency: 'SGD', amount: 1000, payer_id: ALICE, payee_id: ME }),
  ];
  const b = computeBalances(txs);
  assert.deepEqual(settlementPlan(b.net), [
    { from: ALICE, to: CARA, currency: 'INR', amount: 1000 },
    { from: BOB, to: CARA, currency: 'INR', amount: 1000 },
    { from: BOB, to: ME, currency: 'SGD', amount: 1000 },
  ]);
  const settled = computeBalances([mk({ type: 'expense', currency: 'SGD', amount: 100, payer_id: ME, splits: equal(100, [ME]) })]);
  assert.deepEqual(settlementPlan(settled.net), []);
  assert.deepEqual(pairwiseDebts(settled), []);
});

test('spendingBy nets refunds and ignores non-spending types; accountEntries ignores other accounts', () => {
  const txs = [
    mk({ type: 'expense', date: '2026-04-01', currency: 'SGD', amount: 500, category: 'Food', payer_id: ME, from_account_id: CASH_SGD, splits: equal(500, [ME]) }),
    mk({ type: 'refund', date: '2026-04-02', currency: 'SGD', amount: 200, category: 'Food', payer_id: ME, to_account_id: CASH_SGD, splits: equal(200, [ME]) }),
    mk({ type: 'income', date: '2026-04-03', currency: 'SGD', amount: 9000, payer_id: ME, to_account_id: CASH_SGD }),
    mk({ type: 'repayment', date: '2026-04-04', currency: 'SGD', amount: 100, payer_id: ALICE, payee_id: ME }),
    mk({ type: 'withdrawal', date: '2026-04-05', currency: 'INR', amount: 100, payer_id: ME, from_account_id: BANK, to_account_id: CASH_INR }),
  ];
  const by = spendingBy(txs, (t) => t.category ?? '-');
  assert.deepEqual([...by.get('Food')!], [['SGD', 300]]);
  assert.equal(by.size, 1);
  assert.deepEqual(accountEntries(txs, accounts[1]!).map((r) => r.delta), [-500, 200, 9000]);
  assert.deepEqual(accountEntries(txs, accounts[2]!).map((r) => r.delta), [100]);
});
