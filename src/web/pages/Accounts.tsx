import { useState } from 'react';
import { Banknote, ChevronLeft, Coins, CreditCard, Landmark, Pencil, Plus, Wallet, type LucideIcon } from 'lucide-react';
import { ACCOUNT_TYPES, accountEntries, parseAmount, toMajor, type Account } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { COMMON_CURRENCIES, useLedger } from '../store.tsx';
import { TxDetail } from '../components/TxDetail.tsx';
import { DangerButton, Empty, ErrorBox, Field, Modal, Money, Spinner, Stat, TypeBadge, fmtDate, useBusy } from '../components/ui.tsx';

const ACCOUNT_ICON: Record<Account['type'], LucideIcon> = { cash: Banknote, bank: Landmark, card: CreditCard, wallet: Wallet, other: Coins };
const typeLabel = (t: Account['type']) => (t === 'cash' ? 'Cash holding' : t[0]!.toUpperCase() + t.slice(1));
const AccountIcon = ({ type }: { type: Account['type'] }) => { const I = ACCOUNT_ICON[type]; return <span className="ticon sm"><I /></span>; };

function AccountForm({ existing, onClose }: { existing?: Account; onClose: () => void }) {
  const { state, me, reload } = useLedger();
  const [a, setA] = useState<Omit<Account, 'id'>>(existing ?? { person_id: me.id, name: '', type: 'cash', currency: state.settings.home_currency, opening_balance: 0, archived: 0 });
  const [opening, setOpening] = useState(existing ? toMajor(existing.opening_balance, existing.currency) : '0');
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const parsed = parseAmount(opening || '0', a.currency);
  const save = () => {
    if (parsed == null) return setErr('Opening balance is not a valid amount');
    void run(async () => {
      try {
        const body = { ...a, opening_balance: parsed };
        if (existing) await api('PUT', `/api/accounts/${existing.id}`, body);
        else await api('POST', '/api/accounts', body);
        await reload();
        onClose();
      } catch (e) {
        setErr(errorText(e));
      }
    });
  };
  return (
    <Modal title={existing ? 'Edit account' : 'New account or cash holding'} onClose={onClose}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Name" className="span-2"><input value={a.name} autoFocus placeholder="SGD cash, HDFC savings, Amex…" onChange={(e) => setA({ ...a, name: e.target.value })} data-testid="account-name" /></Field>
          <Field label="Type">
            <select value={a.type} onChange={(e) => setA({ ...a, type: e.target.value as Account['type'] })} data-testid="account-type">
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
            </select>
          </Field>
          <Field label="Currency">
            <input list="currencies" value={a.currency} maxLength={3} onChange={(e) => setA({ ...a, currency: e.target.value.toUpperCase() })} data-testid="account-currency" />
            <datalist id="currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Opening balance" hint="Balance before the first transaction you record"><input inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} data-testid="account-opening" /></Field>
          <Field label="Owner">
            <select value={a.person_id} onChange={(e) => setA({ ...a, person_id: Number(e.target.value) })}>
              {state.people.map((p) => <option key={p.id} value={p.id}>{p.is_me ? 'You' : p.name}</option>)}
            </select>
          </Field>
        </div>
        {existing && <label className="check"><input type="checkbox" checked={!!a.archived} onChange={(e) => setA({ ...a, archived: e.target.checked ? 1 : 0 })} /><span>Archived</span></label>}
        <ErrorBox error={err} />
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !a.name.trim() || parsed == null} onClick={save} data-testid="save-account">{busy && <Spinner />}{existing ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </Modal>
  );
}

function AccountDetail({ account }: { account: Account }) {
  const { state, balances, who } = useLedger();
  const [edit, setEdit] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const rows = accountEntries(state.transactions, account).reverse();
  const selectedTx = selected != null ? state.transactions.find((t) => t.id === selected) : undefined;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <a href="#/accounts" className="back"><ChevronLeft />All accounts</a>
          <h1 className="row" style={{ gap: 10 }}><AccountIcon type={account.type} />{account.name}</h1>
          <div className="sub">{typeLabel(account.type)} · {account.currency} · {who(account.person_id)}</div>
        </div>
        <div className="row">
          <button onClick={() => setEdit(true)}><Pencil />Edit</button>
          {account.type === 'cash' && <a className="btn" href={`#/imports/${account.id}`}>Reconcile</a>}
          <a className="btn" href={`#/imports/${account.id}/import`}>Import statement</a>
        </div>
      </div>
      <div className="grid-4">
        <Stat label="Balance" testId="account-balance"><Money amount={balances.accounts.get(account.id) ?? 0} currency={account.currency} /></Stat>
        <Stat label="Opening balance"><Money amount={account.opening_balance} currency={account.currency} /></Stat>
        <Stat label="Movements">{rows.length}</Stat>
      </div>
      {rows.length === 0 ? <Empty title="No movements yet">Transactions that use this account will appear here with a running balance.</Empty> : (
        <div className="panel table-wrap">
          <table data-testid="account-ledger">
            <thead><tr><th>Date</th><th>Type</th><th>Description</th><th className="num">Change</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tx.id} className="clickable" onClick={() => setSelected(r.tx.id)}>
                  <td className="nowrap muted">{fmtDate(r.tx.date)}</td>
                  <td><TypeBadge type={r.tx.type} /></td>
                  <td>{r.tx.description}{r.tx.fee_amount && r.tx.from_account_id === account.id ? <span className="faint small"> · incl. fee {toMajor(r.tx.fee_amount, account.currency)}</span> : null}</td>
                  <td className="num"><Money amount={r.delta} currency={account.currency} sign /></td>
                  <td className="num"><Money amount={r.balance} currency={account.currency} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <AccountForm existing={account} onClose={() => setEdit(false)} />}
      {selectedTx && <TxDetail tx={selectedTx} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function Accounts({ id }: { id: number | null }) {
  const { state, accounts, balances, reload, who } = useLedger();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [home, setHome] = useState(state.settings.home_currency);
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const account = id != null ? accounts.get(id) : undefined;
  if (id != null && !account) return <Empty title="Account not found"><a href="#/accounts">Back</a></Empty>;
  if (account) return <AccountDetail account={account} />;
  const saveHome = () => run(async () => {
    try {
      await api('PUT', '/api/settings', { home_currency: home });
      await reload();
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  });
  const archive = (a: Account) => run(async () => {
    try {
      await api('PUT', `/api/accounts/${a.id}`, { ...a, archived: a.archived ? 0 : 1 });
      await reload();
    } catch (e) {
      setErr(errorText(e));
    }
  });
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Accounts & Cash</h1><div className="sub">Balances are derived from transactions, never edited by hand</div></div>
        <button className="primary" onClick={() => setCreating(true)} data-testid="new-account"><Plus />New account</button>
      </div>
      <ErrorBox error={err} />
      {state.accounts.length === 0 ? (
        <Empty title="No accounts yet">Add a cash holding for each currency you carry, plus the bank accounts and cards you pay from. Expenses can also be recorded without any account.</Empty>
      ) : (
        <div className="panel table-wrap">
          <table data-testid="accounts-table">
            <thead><tr><th>Name</th><th>Type</th><th>Owner</th><th className="num">Balance</th><th></th></tr></thead>
            <tbody>
              {state.accounts.map((a) => (
                <tr key={a.id} style={{ opacity: a.archived ? 0.55 : 1 }}>
                  <td><a href={`#/accounts/${a.id}`} className="who" style={{ color: 'inherit' }}><AccountIcon type={a.type} />{a.name}{a.archived ? <span className="badge">archived</span> : null}</a></td>
                  <td className="muted">{typeLabel(a.type)}</td>
                  <td className="muted">{who(a.person_id)}</td>
                  <td className="num"><Money amount={balances.accounts.get(a.id) ?? 0} currency={a.currency} /></td>
                  <td className="actions">
                    <button className="small ghost" onClick={() => setEditing(a)}>Edit</button>
                    <button className="small ghost" disabled={busy} onClick={() => void archive(a)}>{a.archived ? 'Unarchive' : 'Archive'}</button>
                    <DangerButton confirm={`Delete ${a.name}? Only possible if no transactions use it.`} onConfirm={async () => { await api('DELETE', `/api/accounts/${a.id}`); await reload(); }}>Delete</DangerButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel pad">
        <h3>Home currency</h3>
        <div className="row" style={{ marginTop: 8 }}>
          <input list="currencies" value={home} maxLength={3} style={{ width: 96 }} onChange={(e) => setHome(e.target.value.toUpperCase())} data-testid="home-currency" />
          <datalist id="currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
          <button onClick={() => void saveHome()} disabled={busy || home === state.settings.home_currency}>{busy && <Spinner />}Save</button>
          <span className="faint small">Default for new accounts and personal transactions. Nothing is ever converted automatically.</span>
        </div>
      </div>
      {creating && <AccountForm onClose={() => setCreating(false)} />}
      {editing && <AccountForm existing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
