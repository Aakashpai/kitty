import { useMemo, useState } from 'react';
import { ArrowRight, Copy } from 'lucide-react';
import { computeBalances, computeHomeBalances, currencySymbol, effectsOf, emptyTx, formatAmount, forwardDebts, negligible, pairwiseDebts, squareUp, toMajor, type Debt, type Id, type Tx } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { copyText, useLedger } from '../store.tsx';
import { localToday } from './QuickAdd.tsx';
import { useTxForm } from './txFormContext.ts';
import { Avatar, Empty, Money, MoneyList } from './ui.tsx';

type Mode = 'currency' | 'home';
const readMode = (): Mode => {
  try { return localStorage.getItem('balances-mode') === 'home' ? 'home' : 'currency'; } catch { return 'currency'; }
};

/** "Call it square" on a negligible leftover: after asking, saves rounding entries that clear it for good; nothing is paid. */
export function SquareButton({ txs, from, to }: { txs: Tx[]; from: Id; to: Id }) {
  const { rateCtx, readOnly, people, reload } = useLedger();
  const [busy, setBusy] = useState(false);
  const plan = useMemo(() => squareUp(txs, rateCtx, from, to), [txs, rateCtx, from, to]);
  if (readOnly || !plan) return null;
  const home = rateCtx.home, first = (id: Id) => people.get(id)?.name.split(' ')[0] ?? `#${id}`;
  const total = plan.reduce((s, q) => s + q.amount, 0);
  const go = async () => {
    if (!window.confirm(`Call ${first(from)} and ${first(to)} square? Kitty saves a ${formatAmount(total, home)} rounding entry so this leftover is gone for good. No money changes hands, and you can delete the entry to undo it.`)) return;
    setBusy(true);
    try {
      for (const q of plan) {
        await api('POST', '/api/transactions', { ...emptyTx('repayment', localToday(), home), description: 'Called square: exchange-rate leftover', notes: `No money changed hands. Clears what exchange rates and rounding left over (under ${currencySymbol(home)}10); balances in each currency are unchanged.`, trip_id: q.trip_id, amount: q.amount, payer_id: q.from, payee_id: q.to, settled_currency: home, settled_amount: q.settles, full_settlement: 1 });
      }
      await reload();
    } catch (e) {
      window.alert(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return <button className="small ghost" disabled={busy} onClick={() => void go()} data-testid="call-square">Call it square</button>;
}

/** Who owes whom (exact, per currency), each person's net, and a minimal settlement plan; optionally everything valued in the home currency. */
export function BalancesView({ txs, tripId }: { txs: Tx[]; tripId: Id | null }) {
  const { who, me, people, readOnly, rateCtx } = useLedger();
  const openForm = useTxForm();
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem('balances-mode', m); } catch { /* ignore */ } };
  const b = useMemo(() => computeBalances(txs), [txs]);
  const h = useMemo(() => computeHomeBalances(txs, rateCtx), [txs, rateCtx]);
  const pairs = pairwiseDebts(b);
  const plan = forwardDebts(pairs); // debts passed along real chains only; never a route between people the money did not flow through
  const home = rateCtx.home;
  const foreign = pairs.some((d) => d.currency !== home);
  const inHome = mode === 'home' && foreign;
  const trip = tripId != null ? rateCtx.trips.find((t) => t.id === tripId) : undefined;
  const rateFor = (cur: string) => (cur === home ? 1 : (trip?.rates?.[cur] ?? rateCtx.rates[cur] ?? null));
  const nameOf = (id: Id) => people.get(id)?.name ?? `#${id}`;
  const Person = ({ id }: { id: Id }) => <span className="who"><Avatar id={id} name={nameOf(id)} small />{who(id)}</span>;
  /** The trip a pair's open debt in one currency comes from, when it is all from one trip; null when mixed or outside trips. */
  const sourceTrip = (from: Id, to: Id, currency: string): Id | null => {
    const left = new Map<Id | null, number>();
    for (const t of txs) for (const d of effectsOf(t).debts) {
      const sign = d.currency !== currency ? 0 : d.from === from && d.to === to ? 1 : d.from === to && d.to === from ? -1 : 0;
      if (sign) left.set(t.trip_id, (left.get(t.trip_id) ?? 0) + sign * d.amount);
    }
    const open = [...left].filter(([, v]) => v !== 0);
    return open.length === 1 ? open[0]![0] : null;
  };
  const record = (from: Id, to: Id, currency: string, amount: number) => {
    const rate = inHome && currency !== home ? rateFor(currency) : null;
    const desc = `${who(from)} settles with ${who(to)}`.replace('You settles', 'You settle');
    const trip_id = tripId ?? sourceTrip(from, to, currency); // settling from All still lands on the trip it settles, so that trip's balances clear too
    openForm({ initial: rate
      ? { type: 'repayment', payer_id: from, payee_id: to, currency: home, amount: Math.round(amount * rate), settled_currency: currency, settled_amount: amount, trip_id, full_settlement: 1, description: desc }
      : { type: 'repayment', payer_id: from, payee_id: to, currency, amount, trip_id, full_settlement: 1, description: desc } });
  };
  const [copied, setCopied] = useState<number | null>(null);
  const first = (id: Id) => nameOf(id).split(' ')[0]!;
  /** WhatsApp-ready reminder for one settlement line, with a UPI deep link when the payee has an ID. */
  const requestText = (d: Debt) => {
    const payee = people.get(d.to), rate = d.currency === home ? 1 : rateFor(d.currency);
    const inr = rate ? Math.round(d.amount * rate) : null;
    const where = trip ? ` for ${trip.name}` : '';
    const amount = d.currency === home ? formatAmount(d.amount, home) : `${formatAmount(d.amount, d.currency)}${inr ? ` (≈ ${formatAmount(inr, home)} at 1 ${d.currency} = ${rate})` : ''}`;
    let text = `Hi ${first(d.from)}, settling up${where}: you owe ${nameOf(d.to)} ${amount}.`;
    if (payee?.upi_id && inr) text += `\nPay via UPI: upi://pay?pa=${encodeURIComponent(payee.upi_id)}&pn=${encodeURIComponent(payee.name)}&am=${toMajor(inr, home)}&cu=${home}&tn=${encodeURIComponent(`Kitty${where}`)}`;
    else if (!payee?.upi_id) text += `\n(Add ${first(d.to)}'s UPI ID under People to include a payment link.)`;
    return text;
  };
  const copyRequest = async (text: string, key: number) => {
    await copyText(text);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1500);
  };
  const allText = () => [`Settling up${trip ? ` for ${trip.name}` : ''}:`, ...plan.map((d) => `• ${first(d.from)} → ${first(d.to)}: ${formatAmount(d.amount, d.currency)}${d.currency !== home && rateFor(d.currency) ? ` (≈ ${formatAmount(Math.round(d.amount * rateFor(d.currency)!), home)})` : ''}`), 'Sent from Kitty'].join('\n');
  const view = inHome ? h : b;
  const tiny = (d: Debt) => d.currency === home && negligible(d.amount, home);
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
                  <tr key={`${d.from}-${d.to}-${d.currency}`} className={tiny(d) ? 'faint' : undefined}>
                    <td><span className="who"><Person id={d.from} /><span className="arrow"><ArrowRight /></span><Person id={d.to} /></span></td>
                    <td className="num"><Money amount={d.amount} currency={d.currency} />{tiny(d) ? <div className="small">negligible</div> : null}</td>
                    {!readOnly && (!inHome || tiny(d)) && <td className="actions">{tiny(d) ? <SquareButton txs={txs} from={d.from} to={d.to} /> : <button className="small" onClick={() => record(d.from, d.to, d.currency, d.amount)}>Settle</button>}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">{inHome ? `Every debt valued in ${home} and netted per pair.` : `Exact positions from every expense, refund and repayment${tripId != null ? ' tagged to this trip' : ''}. Each currency is kept separate.`}{pairsV.some(tiny) ? ` Under ${currencySymbol(home)}10 is left over from exchange rates and rounding: shown so nothing is hidden, nothing to settle; Call it square clears it for good if you both agree.` : ''}</div>
        </div>
        <div className="stack">
          <div className="panel">
            <div className="panel-head"><h3>Fewer payments</h3><span className="row"><span className="faint small">{plan.length} payment{plan.length === 1 ? '' : 's'} instead of {pairs.length}</span><button className="small ghost" onClick={() => void copyRequest(allText(), -1)} data-testid="copy-all"><Copy />{copied === -1 ? 'Copied' : 'Copy all'}</button></span></div>
            <div className="table-wrap">
              <table data-testid="settlement-plan">
                <tbody>
                  {plan.map((d, i) => {
                    const r = inHome && d.currency !== home ? rateFor(d.currency) : null;
                    return (
                      <tr key={i}>
                        <td><span className="who"><Person id={d.from} /><span className="arrow"><ArrowRight /></span><Person id={d.to} /></span></td>
                        <td className="num"><Money amount={d.amount} currency={d.currency} />{r ? <div className="faint small">≈ {formatAmount(Math.round(d.amount * r), home)}</div> : null}</td>
                        <td className="actions">
                          <button className="small ghost" onClick={() => void copyRequest(requestText(d), i)} title="Copy a message with the amount and a UPI link" data-testid={`copy-request-${i}`}><Copy />{copied === i ? 'Copied' : 'Request'}</button>
                          {!readOnly && <button className="small" onClick={() => record(d.from, d.to, d.currency, d.amount)}>Record</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="panel-foot">Request copies a WhatsApp-ready message with the amount and, when the receiver has a UPI ID set under People, a tap-to-pay link.{!readOnly ? (inHome ? ` Record files the payment in ${home} and marks which foreign debt it settles.` : ' Record opens a repayment for you to review before saving.') : ''}</div>
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
