import { pathToFileURL } from 'node:url';
import { allocate, computeBalances, emptyTx, type Id, type Split, type TxInput } from '../engine/index.ts';
import { openDb, type Db } from './db.ts';

const equal = (amount: number, ids: Id[]): Split[] => allocate(amount, ids.map(() => 1)).map((a, i) => ({ person_id: ids[i]!, amount: a, input: null }));
const weighted = (amount: number, w: [Id, number][]): Split[] => allocate(amount, w.map(([, x]) => x)).map((a, i) => ({ person_id: w[i]![0], amount: a, input: w[i]![1] }));

/** Loads a realistic sample ledger: two trips, four friends, every transaction type. */
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const year = new Date().getFullYear();

export async function seed(db: Db) {
  const me = (await db.loadState(null)).people.find((p) => p.is_me)!.id;
  const alice = (await db.createPerson('Alice')).id;
  const bob = (await db.createPerson('Bob')).id;
  const cara = (await db.createPerson('Cara')).id;
  const acct = async (name: string, type: 'cash' | 'bank' | 'card', currency: string, opening_balance = 0) =>
    (await db.createAccount({ person_id: me, name, type, currency, opening_balance, archived: 0 })).id;
  const bank = await acct('HDFC Savings', 'bank', 'INR', 25_000_000);
  const card = await acct('HDFC Credit Card', 'card', 'INR');
  const inrCash = await acct('INR Cash', 'cash', 'INR', 500_000);
  const sgdCash = await acct('SGD Cash', 'cash', 'SGD');
  const goa = (await db.createTrip({ name: 'Goa weekend', start_date: day(95), end_date: day(93), currency: 'INR', notes: null, archived: 0, members: [me, alice, bob], rates: null })).id;
  const sg = (await db.createTrip({ name: `Singapore ${year}`, start_date: day(40), end_date: day(36), currency: 'SGD', notes: 'Marina Bay + Sentosa', archived: 0, members: [me, alice, bob, cara], rates: { SGD: 62.5 } })).id;

  const add = (p: Partial<TxInput>) => db.createTx({ ...emptyTx(), ...p } as TxInput);
  const all4 = [me, alice, bob, cara];

  // Goa (INR)
  await add({ type: 'expense', date: day(95), description: 'Villa rent', category: 'Accommodation', trip_id: goa, currency: 'INR', amount: 900_000, payer_id: alice, split_method: 'equal', splits: equal(900_000, [me, alice, bob]) });
  await add({ type: 'expense', date: day(94), description: 'Scooter rental', category: 'Transport', trip_id: goa, currency: 'INR', amount: 150_000, payer_id: me, from_account_id: inrCash, split_method: 'equal', splits: equal(150_000, [me, alice, bob]) });
  await add({ type: 'expense', date: day(94), description: 'Beach shack dinner', category: 'Food', trip_id: goa, currency: 'INR', amount: 240_000, payer_id: me, from_account_id: bank, split_method: 'amount', splits: [{ person_id: me, amount: 100_000, input: null }, { person_id: alice, amount: 70_000, input: null }, { person_id: bob, amount: 70_000, input: null }] });
  await add({ type: 'repayment', date: day(92), description: 'Settling Goa', trip_id: goa, currency: 'INR', amount: 300_000, payer_id: me, payee_id: alice, from_account_id: bank, method: 'UPI', reference: 'UPI-220871', full_settlement: 1 });

  // Personal, no trip
  await add({ type: 'income', date: day(60), description: 'Salary', category: 'Salary', currency: 'INR', amount: 15_000_000, payer_id: me, to_account_id: bank });
  await add({ type: 'transfer', date: day(56), description: 'ATM withdrawal', currency: 'INR', amount: 500_000, payer_id: me, from_account_id: bank, to_account_id: inrCash, reference: 'ATM-1182' });
  await add({ type: 'expense', date: day(3), description: 'Coffee beans', category: 'Groceries', currency: 'INR', amount: 89_000, payer_id: me, from_account_id: card, split_method: 'equal', splits: equal(89_000, [me]) });
  await add({ type: 'expense', date: day(9), description: 'Metro top-up', category: 'Transport', currency: 'INR', amount: 50_000, payer_id: me, from_account_id: bank, split_method: 'equal', splits: equal(50_000, [me]) });
  await add({ type: 'expense', date: day(55), description: 'Swiggy order', category: 'Food', currency: 'INR', amount: 64_000, payer_id: me, from_account_id: bank, split_method: 'equal', splits: equal(64_000, [me]) });

  // Singapore (SGD, with INR legs)
  await add({ type: 'expense', date: day(70), description: 'Flights BLR-SIN', category: 'Flights', trip_id: sg, currency: 'INR', amount: 11_200_000, payer_id: me, from_account_id: card, split_method: 'equal', splits: equal(11_200_000, all4) });
  await add({ type: 'withdrawal', date: day(40), description: 'ATM at Changi', trip_id: sg, currency: 'INR', amount: 3_125_000, payer_id: me, from_account_id: bank, to_account_id: sgdCash, to_amount: 50_000, fee_amount: 23_600, reference: 'ATM-7781', notes: 'Rate 62.50 + bank fee' });
  const hotel = await add({ type: 'expense', date: day(40), description: 'Hotel Marina Bay, 3 nights', category: 'Accommodation', trip_id: sg, currency: 'SGD', amount: 96_000, payer_id: alice, split_method: 'equal', splits: equal(96_000, all4) });
  await add({ type: 'expense', date: day(40), description: 'Dinner at Lau Pa Sat', category: 'Food', trip_id: sg, currency: 'SGD', amount: 12_000, payer_id: me, from_account_id: sgdCash, split_method: 'equal', splits: equal(12_000, all4) });
  await add({ type: 'expense', date: day(39), description: 'Taxi to Sentosa', category: 'Transport', trip_id: sg, currency: 'SGD', amount: 2_850, payer_id: bob, split_method: 'equal', splits: equal(2_850, [me, bob, cara]) });
  await add({ type: 'expense', date: day(39), description: 'Gardens by the Bay tickets', category: 'Activities', trip_id: sg, currency: 'SGD', amount: 21_200, payer_id: me, from_account_id: card, from_amount: 1_346_200, split_method: 'equal', splits: equal(21_200, all4), notes: 'Card charged INR 13,462 incl. markup' });
  await add({ type: 'expense', date: day(39), description: 'Kopi', category: 'Food', trip_id: sg, currency: 'SGD', amount: 680, payer_id: me, from_account_id: sgdCash, split_method: 'equal', splits: equal(680, [me]) });
  await add({ type: 'expense', date: day(38), description: 'Groceries at Mustafa', category: 'Groceries', trip_id: sg, currency: 'SGD', amount: 4_530, payer_id: me, from_account_id: sgdCash, split_method: 'weight', splits: weighted(4_530, [[me, 2], [alice, 1], [bob, 1]]) });
  await add({ type: 'refund', date: day(37), description: 'Hotel: one night cancelled', category: 'Accommodation', trip_id: sg, currency: 'SGD', amount: 32_000, payer_id: alice, linked_tx_id: hotel.id, split_method: 'equal', splits: allocate(32_000, hotel.splits.map((s) => s.amount)).map((a, i) => ({ person_id: hotel.splits[i]!.person_id, amount: a, input: null })) });
  await add({ type: 'repayment', date: day(37), description: 'Bob paid back dinner', trip_id: sg, currency: 'SGD', amount: 3_000, payer_id: bob, payee_id: me, to_account_id: sgdCash, method: 'cash' });
  await add({ type: 'repayment', date: day(34), description: 'Cara: part of Singapore balance', trip_id: sg, currency: 'INR', amount: 200_000, settled_currency: 'SGD', settled_amount: 3_200, payer_id: cara, payee_id: me, to_account_id: bank, method: 'UPI', reference: 'UPI-447120' });

  const state = await db.loadState(null);
  const expected = computeBalances(state.transactions, state.accounts).accounts.get(sgdCash) ?? 0;
  await db.createReconciliation({ account_id: sgdCash, date: day(36), counted_amount: expected - 350, expected_amount: expected, note: 'Counted wallet at the airport' });
  await db.log('seed', 'ledger', null, 'Loaded sample data');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await openDb(process.env.TURSO_DATABASE_URL ?? process.env.LEDGER_DB ?? 'file:data/ledger.db', process.env.TURSO_AUTH_TOKEN);
  if (!(await db.isEmpty())) {
    console.error('Ledger already has transactions; sample data is only loaded into an empty ledger.');
    process.exit(1);
  }
  await seed(db);
  console.log('Sample data loaded.');
}
