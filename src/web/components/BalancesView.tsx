import { ArrowRight } from 'lucide-react';
import { computeBalances, pairwiseDebts, settlementPlan, type Id, type Tx } from '../../engine/index.ts';
import { useLedger } from '../store.tsx';
import { useTxForm } from './txFormContext.ts';
import { Avatar, Empty, Money, MoneyList } from './ui.tsx';

/** Who owes whom (exact), each person's net, and a minimal settlement plan for a set of transactions. */
export function BalancesView({ txs, tripId }: { txs: Tx[]; tripId: Id | null }) {
  const { who, me, people, readOnly } = useLedger();
  const openForm = useTxForm();
  const b = computeBalances(txs);
  const pairs = pairwiseDebts(b);
  const plan = settlementPlan(b.net);
  const record = (from: Id, to: Id, currency: string, amount: number) =>
    openForm({ initial: { type: 'repayment', payer_id: from, payee_id: to, currency, amount, trip_id: tripId, full_settlement: 1, description: `${who(from)} settles with ${who(to)}`.replace('You settles', 'You settle') } });
  const nameOf = (id: Id) => people.get(id)?.name ?? `#${id}`;
  const Person = ({ id }: { id: Id }) => <span className="who"><Avatar id={id} name={nameOf(id)} small />{who(id)}</span>;
  const nets = [...b.net].filter(([, m]) => [...m.values()].some((v) => v !== 0)).sort(([a], [c]) => (a === me.id ? -1 : c === me.id ? 1 : nameOf(a).localeCompare(nameOf(c))));
  if (!pairs.length) return <Empty title="All settled up">{tripId != null ? 'Nothing outstanding on this trip.' : 'Nobody owes anyone anything.'}</Empty>;
  return (
    <div className="grid-2">
      <div className="panel">
        <div className="panel-head"><h3>Who owes whom</h3><span className="faint small">{pairs.length} open</span></div>
        <div className="table-wrap">
          <table data-testid="pairwise">
            <tbody>
              {pairs.map((d) => (
                <tr key={`${d.from}-${d.to}-${d.currency}`}>
                  <td><span className="who"><Person id={d.from} /><span className="arrow"><ArrowRight /></span><Person id={d.to} /></span></td>
                  <td className="num"><Money amount={d.amount} currency={d.currency} /></td>
                  {!readOnly && <td className="actions"><button className="small" onClick={() => record(d.from, d.to, d.currency, d.amount)}>Settle</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-foot">Exact positions from every expense, refund and repayment{tripId != null ? ' tagged to this trip' : ''}. Each currency is kept separate.</div>
      </div>
      <div className="stack">
        <div className="panel">
          <div className="panel-head"><h3>Simplest way to settle</h3><span className="faint small">{plan.length} payment{plan.length === 1 ? '' : 's'} instead of {pairs.length}</span></div>
          <div className="table-wrap">
            <table data-testid="settlement-plan">
              <tbody>
                {plan.map((d, i) => (
                  <tr key={i}>
                    <td><span className="who"><Person id={d.from} /><span className="arrow"><ArrowRight /></span><Person id={d.to} /></span></td>
                    <td className="num"><Money amount={d.amount} currency={d.currency} /></td>
                    {!readOnly && <td className="actions"><button className="small" onClick={() => record(d.from, d.to, d.currency, d.amount)}>Record</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!readOnly && <div className="panel-foot">Recording one opens a repayment{tripId != null ? ' tagged to this trip' : ''} for you to review before saving.</div>}
        </div>
        <div className="panel">
          <div className="panel-head"><h3>Net position</h3></div>
          <div className="table-wrap">
            <table>
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
  );
}
