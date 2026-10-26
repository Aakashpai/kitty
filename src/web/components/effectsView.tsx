import { effectsOf, formatAmount, type Tx, type TxInput } from '../../engine/index.ts';
import { useLedger } from '../store.tsx';

/** Plain-language list of what a transaction does to accounts, balances and spending. */
export function EffectsView({ tx }: { tx: TxInput | Tx }) {
  const { who, accounts, trips, me, readOnly } = useLedger();
  const owes = (id: number) => (!readOnly && id === me.id ? 'owe' : 'owes');
  const e = effectsOf({ id: 0, created_at: '', updated_at: '', ...tx } as Tx);
  const lines: string[] = [];
  for (const d of e.accounts) {
    const a = accounts.get(d.account_id);
    if (a) lines.push(`${a.name}: ${formatAmount(d.amount, a.currency)}`);
  }
  for (const d of e.debts) {
    const amt = formatAmount(d.amount, d.currency);
    if (tx.type === 'expense') lines.push(`${who(d.from)} ${owes(d.from)} ${who(d.to)} ${amt}`);
    else if (tx.type === 'refund') lines.push(`Reduces what ${who(d.to)} ${owes(d.to)} ${who(d.from)} by ${amt}`);
    else lines.push(`Settles ${amt} of what ${who(d.to)} ${owes(d.to)} ${who(d.from)}`);
  }
  const trip = tx.trip_id != null ? trips.get(tx.trip_id) : null;
  if (e.spending > 0) lines.push(`Spending +${formatAmount(e.spending, tx.currency)}${trip ? ` in ${trip.name}` : ''}`);
  if (e.spending < 0) lines.push(`Spending ${formatAmount(e.spending, tx.currency)}${trip ? ` in ${trip.name}` : ''}`);
  if (e.fee > 0) lines.push(`Fee ${formatAmount(e.fee, tx.currency)} recorded separately (not trip spending)`);
  if (e.income > 0) lines.push(`Income +${formatAmount(e.income, tx.currency)}`);
  if (tx.type === 'transfer' || tx.type === 'withdrawal') lines.push('Not counted as spending');
  if (tx.type === 'repayment') lines.push('Does not change spending totals');
  if (tx.type === 'expense' && e.debts.length === 0) lines.push('Personal expense: nobody owes anyone');
  return (
    <div className="effects" data-testid="effects">
      <strong>Effect on balances</strong>
      <ul>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
