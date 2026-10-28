import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { computeBalances, computeHomeBalances, formatAmount, pairwiseDebts, settlementPlan, shareOf, spendingBy, type Id, type Tx } from '../../engine/index.ts';
import { useLedger } from '../store.tsx';
import { TxList } from '../components/TxList.tsx';
import { TxDetail } from '../components/TxDetail.tsx';
import { Avatar, MoneyList } from '../components/ui.tsx';
import { ScopeSeg, inScope } from './Transactions.tsx';

const RECENT = 8;

/** Phone-first summary: your position, who pays whom, what was spent, latest entries. Used by the in-app "Simple view" and by simple share links. */
export function SimpleView({ scope, onScope, focus: focusProp }: { scope: string; onScope?: (s: string) => void; focus?: Id }) {
  const { state, me, who, people, readOnly, rateCtx } = useLedger();
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Tx | null>(null);
  // A person share link, or the admin opening someone from People: the page speaks about that person and shows only their entries.
  const focus = focusProp ?? (readOnly && state.shared_person_id != null ? me.id : null);
  const subject = focus ?? me.id;
  const involves = (t: Tx, p: Id) => t.payer_id === p || t.payee_id === p || t.splits.some((s) => s.person_id === p);
  const txs = useMemo(() => state.transactions.filter((t) => inScope(t, scope) && (focus == null || involves(t, focus))), [state.transactions, scope, focus]);
  const b = useMemo(() => computeBalances(txs), [txs]);
  const h = useMemo(() => computeHomeBalances(txs, rateCtx), [txs, rateCtx]);
  const home = rateCtx.home;
  const trip = /^\d+$/.test(scope) ? rateCtx.trips.find((t) => t.id === Number(scope)) : undefined;
  const rateFor = (cur: string) => (cur === home ? 1 : (trip?.rates?.[cur] ?? rateCtx.rates[cur] ?? null));
  const myNet = b.net.get(subject) ?? new Map<string, number>();
  const myHome = h.net.get(subject)?.get(home) ?? 0;
  const foreign = txs.some((t) => t.currency !== home);
  const exact = !h.unconverted.size;
  const settled = myHome === 0 && ![...myNet.values()].some((v) => v !== 0);
  const debts = focus != null ? pairwiseDebts(b).filter((d) => d.from === focus || d.to === focus) : settlementPlan(b.net);
  const isYou = subject === me.id;
  const name = isYou ? 'You' : who(subject);
  const own = isYou ? 'Your' : `${who(subject)}’s`;
  const myShare = new Map<string, number>();
  for (const tx of txs) { const v = shareOf(tx, subject); if (v) myShare.set(tx.currency, (myShare.get(tx.currency) ?? 0) + v); }
  // One row per pair with every currency between them, plus a home-currency estimate when rates allow.
  const pairs = new Map<string, { from: Id; to: Id; amounts: Map<string, number>; est: number; partial: boolean }>();
  for (const d of debts) {
    const key = `${d.from}-${d.to}`;
    const p = pairs.get(key) ?? { from: d.from, to: d.to, amounts: new Map<string, number>(), est: 0, partial: false };
    p.amounts.set(d.currency, (p.amounts.get(d.currency) ?? 0) + d.amount);
    const r = rateFor(d.currency);
    if (r) p.est += Math.round(d.amount * r); else p.partial = true;
    pairs.set(key, p);
  }
  const spend = spendingBy(txs, () => 'all').get('all') ?? new Map<string, number>();
  const Person = ({ id }: { id: Id }) => <span className="who"><Avatar id={id} name={people.get(id)?.name ?? '?'} small />{who(id)}</span>;
  const recent = showAll ? txs : txs.slice(0, RECENT);
  return (
    <div className="simple stack">
      {onScope && state.trips.length > 0 && <ScopeSeg value={scope} onChange={onScope} testId="simple-scope" />}
      {(!readOnly || focus != null) && (
        <div className={`simple-hero ${myHome > 0 ? 'pos' : myHome < 0 ? 'neg' : ''}`} data-testid="simple-hero">
          <div className="label">{settled ? `${name} ${isYou ? 'are' : 'is'} settled up` : myHome > 0 ? `${name} ${isYou ? 'are' : 'is'} owed` : myHome < 0 ? `${name} ${isYou ? 'owe' : 'owes'}` : `${own} position`}</div>
          {myHome !== 0 && exact && <div className="big">{formatAmount(Math.abs(myHome), home)}</div>}
          {foreign && !settled && <div className={exact ? 'muted small' : 'big'}><MoneyList map={myNet} sign /></div>}
        </div>
      )}
      <section>
        <h2>Settle up</h2>
        <div className="panel" data-testid="simple-settle">
          {pairs.size === 0 && <div className="simple-row muted">Nobody owes anyone anything.</div>}
          {[...pairs.values()].map((p) => (
            <div className="simple-row" key={`${p.from}-${p.to}`}>
              <span className="pair"><Person id={p.from} /><span className="arrow"><ArrowRight /></span><Person id={p.to} /></span>
              <span className="amt"><MoneyList map={p.amounts} />{p.est && [...p.amounts.keys()].some((c) => c !== home) ? <span className="faint small">≈ {formatAmount(p.est, home)}{p.partial ? ' + more' : ''}</span> : null}</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{focus != null ? `${own} share of spending` : `Spent${trip ? ` on ${trip.name}` : ''}`}</h2>
        <div className="panel"><div className="simple-row"><span className="muted">{focus != null ? 'Across the entries below' : 'Everyone together'}</span><span className="amt"><MoneyList map={focus != null ? myShare : spend} empty="Nothing yet" /></span></div></div>
      </section>
      <section>
        <div className="row between"><h2>{showAll ? 'All entries' : 'Latest'}</h2>{txs.length > RECENT && <button className="ghost small" onClick={() => setShowAll((v) => !v)} data-testid="simple-more">{showAll ? 'Show fewer' : `Show all ${txs.length}`}</button>}</div>
        <div className="panel"><TxList txs={recent} showTrip={!trip} onSelect={setSelected} as={subject} /></div>
      </section>
      {selected && <TxDetail tx={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
