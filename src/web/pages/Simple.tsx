import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { computeBalances, computeHomeBalances, formatAmount, pairwiseDebts, type Id, type Tx } from '../../engine/index.ts';
import { useLedger } from '../store.tsx';
import { TxList } from '../components/TxList.tsx';
import { TxDetail } from '../components/TxDetail.tsx';
import { CategorySpend, type CategoryPick } from '../components/CategorySpend.tsx';
import { Avatar, Money, MoneyList } from '../components/ui.tsx';
import { ScopeSeg, inScope } from './Transactions.tsx';

const RECENT = 8;

/** Phone-first summary: your position, who pays whom, what was spent, latest entries. Used by the in-app "Simple view" and by simple share links. */
export function SimpleView({ scope, onScope, focus: focusProp }: { scope: string; onScope?: (s: string) => void; focus?: Id }) {
  const { state, me, who, people, readOnly, rateCtx } = useLedger();
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<Tx | null>(null);
  const [cat, setCat] = useState<CategoryPick | null>(null);
  // A person share link, or the admin opening someone from People: the page speaks about that person and shows only their entries.
  const focus = focusProp ?? (readOnly && state.shared_person_id != null ? me.id : null);
  const subject = focus ?? me.id;
  const involves = (t: Tx, p: Id) => t.payer_id === p || t.payee_id === p || t.splits.some((s) => s.person_id === p);
  const txs = useMemo(() => state.transactions.filter((t) => inScope(t, scope) && (focus == null || involves(t, focus))), [state.transactions, scope, focus]);
  const b = useMemo(() => computeBalances(txs), [txs]);
  const h = useMemo(() => computeHomeBalances(txs, rateCtx), [txs, rateCtx]);
  const home = rateCtx.home;
  const trip = /^\d+$/.test(scope) ? rateCtx.trips.find((t) => t.id === Number(scope)) : undefined;
  const myNet = b.net.get(subject) ?? new Map<string, number>();
  const myHome = h.net.get(subject)?.get(home) ?? 0;
  const foreign = txs.some((t) => t.currency !== home);
  const exact = !h.unconverted.size;
  const settled = myHome === 0 && ![...myNet.values()].some((v) => v !== 0);
  const isYou = subject === me.id;
  const name = isYou ? 'You' : who(subject);
  const own = isYou ? 'Your' : `${who(subject)}’s`;
  // Exact pair debts. The home-currency figure comes from the same calculation as the headline, so the two always agree;
  // the per-currency pieces sit underneath (negative = owed back the other way). Without a rate for some currency, pieces only.
  const mine = (d: { from: Id; to: Id }) => focus == null || d.from === focus || d.to === focus;
  const rows: { from: Id; to: Id; home: number | null; parts: Map<string, number> }[] = [];
  const addPart = (parts: Map<string, number>, cur: string, v: number) => parts.set(cur, (parts.get(cur) ?? 0) + v);
  if (exact) {
    for (const d of pairwiseDebts(h).filter(mine)) {
      const parts = new Map<string, number>();
      for (const x of pairwiseDebts(b)) {
        if (x.from === d.from && x.to === d.to) addPart(parts, x.currency, x.amount);
        else if (x.from === d.to && x.to === d.from) addPart(parts, x.currency, -x.amount);
      }
      rows.push({ from: d.from, to: d.to, home: d.amount, parts });
    }
  } else {
    for (const x of pairwiseDebts(b).filter(mine)) {
      let row = rows.find((r) => r.from === x.from && r.to === x.to);
      if (!row) rows.push((row = { from: x.from, to: x.to, home: null, parts: new Map() }));
      addPart(row.parts, x.currency, x.amount);
    }
  }
  const Person = ({ id }: { id: Id }) => <span className="who"><Avatar id={id} name={people.get(id)?.name ?? '?'} small />{who(id)}</span>;
  const listed = cat ? txs.filter(cat.match) : txs;
  const recent = showAll ? listed : listed.slice(0, RECENT);
  return (
    <div className="simple stack">
      {onScope && state.trips.length > 0 && <ScopeSeg value={scope} onChange={(s) => { setCat(null); onScope(s); }} testId="simple-scope" />}
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
          {rows.length === 0 && <div className="simple-row muted">Nobody owes anyone anything.</div>}
          {rows.map((p) => (
            <div className="simple-row" key={`${p.from}-${p.to}`}>
              <span className="pair"><Person id={p.from} /><span className="arrow"><ArrowRight /></span><Person id={p.to} /></span>
              <span className="amt">
                {p.home != null ? <Money amount={p.home} currency={home} /> : <MoneyList map={p.parts} />}
                {p.home != null && [...p.parts.keys()].some((c) => c !== home) ? <span className="faint small"><MoneyList map={p.parts} /></span> : null}
              </span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{focus != null ? `${own} share of spending` : `Spent${trip ? ` on ${trip.name}` : ''}`}</h2>
        <CategorySpend txs={txs} person={readOnly && focus == null ? undefined : subject} label={isYou ? 'You' : who(subject)} everyone={focus == null} selected={cat?.label ?? null} onSelect={setCat} />
      </section>
      <section>
        <div className="row between"><h2>{cat ? cat.label : showAll ? 'All entries' : 'Latest'}</h2>{listed.length > RECENT && <button className="ghost small" onClick={() => setShowAll((v) => !v)} data-testid="simple-more">{showAll ? 'Show fewer' : `Show all ${listed.length}`}</button>}</div>
        <div className="panel"><TxList txs={recent} showTrip={!trip} onSelect={setSelected} as={subject} /></div>
      </section>
      {selected && <TxDetail tx={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
