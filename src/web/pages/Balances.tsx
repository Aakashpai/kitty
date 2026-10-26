import { useState } from 'react';
import { useLedger } from '../store.tsx';
import { BalancesView } from '../components/BalancesView.tsx';
import { ScopeSeg, inScope } from './Transactions.tsx';

export function Balances() {
  const { state } = useLedger();
  const [scope, setScope] = useState('');
  const txs = state.transactions.filter((t) => inScope(t, scope));
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Balances & Settlement</h1><div className="sub">Repayments tagged to a trip count towards that trip; untagged ones count only under “All”.</div></div>
      </div>
      <ScopeSeg value={scope} onChange={setScope} testId="balance-scope" />
      <BalancesView txs={txs} tripId={scope && scope !== 'none' ? Number(scope) : null} />
    </div>
  );
}
