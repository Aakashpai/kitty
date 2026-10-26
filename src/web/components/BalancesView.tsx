import { useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { computeBalances, computeHomeBalances, formatAmount, pairwiseDebts, settlementPlan, type Id, type Tx } from '../../engine/index.ts';
import { useLedger } from '../store.tsx';
import { useTxForm } from './txFormContext.ts';
import { Avatar, Empty, Money, MoneyList } from './ui.tsx';

type Mode = 'currency' | 'home';
const readMode = (): Mode => {
  try { return localStorage.getItem('balances-mode') === 'home' ? 'home' : 'currency'; } catch { return 'currency'; }
};

/** Who owes whom (exact, per currency), each person's net, and a minimal settlement plan; optionally everything valued in the home currency. */
export function BalancesView({ txs, tripId }: { txs: Tx[]; tripId: Id | null }) {
  const { who, me, people, readOnly, rateCtx } = useLedger();
  const openForm = useTxForm();
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem('balances-mode', m); } catch { /* ignore */ } };
  const b = useMemo(() => computeBalances(txs), [txs]);
  const h = useMemo(() => computeHomeBalances(txs, rateCtx), [txs, rateCtx]);
  const pairs = pairwiseDebts(b);
  const plan = settlementPlan(b.net);
  const home = rateCtx.home;
  const foreign = pairs.some((d) => d.currency !== home);
  const inHome = mode === 'home' && foreign;
  const trip = tripId != null ? rateCtx.trips.find((t) => t.id === tripId) : undefined;
  const rateFor = (cur: string) => (cur === home ? 1 : (trip?.rates?.[cur] ?? rateCtx.rates[cur] ?? null));
  const nameOf = (id: Id) => people.get(id)?.name ?? `#${id}`;
  const Person = ({ id }: { id: Id }) => <span className="who"><Avatar id={id} name={nameOf(id)} small />{who(id)}</span>;
  const record = (from: Id, to: Id, currency: string, amount: number) => {
    const rate = inHome && currency !== home ? rateFor(currency) : null;
    const desc = `${who(from)} settles with ${who(to)}`.replace('You settles', 'You settle');
    openForm({ initial: rate
      ? { type: 'repayment', payer_id: from, payee_id: to, currency: home, amount: Math.round(amount * rate), settled_currency: currency, settled_amount: amount, trip_id: tripId, full_settlement: 1, description: desc }
      : { type: 'repayment', payer_id: from, payee_id: to, currency, amount, trip_id: tripId, full_settlement: 1, description: desc } });
  };
  const view = inHome ? h : b;
  const pairsV = pairwiseDebts(view);
  const nets = [...view.net].filter(([, m]) => [...m.values()].some((v) => v !== 0)).sort(([a], [c]) => (a === me.id ? -1 : c === me.id ? 1 : nameOf(a).localeCompare(nameOf(c))));
  const usedCurrencies = [...new Set(pairs.map((d) => d.currency).filter((c) => c !== home))];
  const rateNote = usedCurrencies.map((c) => { const r = rateFor(c); return r ? `1 ${c} = ${formatAmount(Math.round(r * 100), home)}` : `${c}: no rate set`; }).join(' · ');
  if (!pairs.length) return <Empty title="All settled up">{tripId != null ? 'Nothing outstanding on this trip.' : 'Nobody owes anyone anything.'}</Empty>;
  return (
    <div className="stack">
      {foreign && (
        <div className="row between">
          <div className="seg" data-testid="balance-mode">
            <button className={!inHome ? 'on' : ''} onClick={() => setMode('currency')}>By currency</button>
            <button className={inHome ? 'on' : ''} onClick={() => setMode('home')}>In {home}</button>
          </div>
          {inHome && <span className="faint small">Card charges at their real {home} amount; the rest at {rateNote}.{h.unconverted.size ? ` Unconverted: ${[...h.unconverted].map(([c, v]) => formatAmount(v, c)).join(', ')} (set a rate under Accounts & Cash).` : ''}</span>}
        </div>
      )}
      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h3>Who owes whom{inHome ? ` (in ${home})` : ''}</h3><span className="faint small">{pairsV.length} open</span></div>
          <div className="table-wrap">
            <table data-testid="pairwise">
              <tbody>
                {pairsV.map((d) => (
                  <tr key={`${d.from}-${d.to}-${d.currency}`}>
                    <td><span className="who"><Person id={d.from} /><span className="arrow"><ArrowRight /></span><Person id={d.to} /></span></td>
                    <td className="num"><Money amount={d.amount} currency={d.currency} /></td>
                    {!readOnly && !inHome && <td className="actions"><button className="small" onClick={() => record(d.from, d.to, d.currency, d.amount)}>Settle</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">{inHome ? `Every debt valued in ${home} and netted per pair.` : `Exact positions from every expense, refund and repayment${tripId != null ? ' tagged to this trip' : ''}. Each currency is kept separate.`}</div>
        </div>
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3>Simplest way to settle</h3><span className="faint small">{plan.length} payment{plan.length === 1 ? '' : 's'} instead of {pairs.length}</span></div>
            <div className="table-wrap">
              <table data-testid="settlement-plan">
                <tbody>
                  {plan.map((d, i) => {
                    const r = inHome && d.currency !== home ? rateFor(d.currency) : null;
                    return (
                      <tr key={i}>
                        <td><span className="who"><Person id={d.from} /><span className="arrow"><ArrowRight /></span><Person id={d.to} /></span></td>
                        <td className="num"><Money amount={d.amount} currency={d.currency} />{r ? <div className="faint small">≈ {formatAmount(Math.round(d.amount * r), home)}</div> : null}</td>
                        {!readOnly && <td className="actions"><button className="small" onClick={() => record(d.from, d.to, d.currency, d.amount)}>Record</button></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!readOnly && <div className="panel-foot">{inHome ? `Record files the payment in ${home} and marks which foreign debt it settles, so both currencies stay exact.` : `Recording one opens a repayment${tripId != null ? ' tagged to this trip' : ''} for you to review before saving.`}</div>}
          </div>
          <div className="panel">
            <div className="panel-head"><h3>Net position{inHome ? ` (in ${home})` : ''}</h3></div>
            <div className="table-wrap">
              <table data-testid="net-position">
                <tbody>
                  {nets.map(([id, m]) => (
                    <tr key={id}>
                      <td><Person id={id} /></td>
                      <td className="num"><MoneyList map={m} sign /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
