import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, KeyRound, Receipt, Smartphone, Zap } from 'lucide-react';
import type { Trip } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { copyText, useLedger } from '../store.tsx';
import { DangerButton, ErrorBox, Spinner, fmtDate, fmtWhen, useBusy } from './ui.tsx';

interface Key { id: number; created_at: string; last_used_at: string | null }

/**
 * Apple Pay → Kitty. One Shortcuts automation per iPhone sends each Apple Pay payment here; the server only asks on the
 * dates of an open trip you are on, so a new trip with dates starts working with no extra setup.
 */
export function ShortcutSetup({ trip }: { trip: Trip }) {
  const { state, owner, reload } = useLedger();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [link, setLink] = useState(state.settings.shortcut_link ?? '');
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  useEffect(() => { void api<Key[]>('GET', '/api/keys').then(setKeys).catch((e) => setErr(errorText(e))); }, []);
  const act = (fn: () => Promise<unknown>) => run(async () => {
    try {
      await fn();
      setErr(null);
    } catch (e) {
      setErr(errorText(e));
    }
  });
  const newKey = () => act(async () => {
    const k = await api<Key & { token: string }>('POST', '/api/keys');
    setToken(k.token);
    setKeys(await api<Key[]>('GET', '/api/keys'));
  });
  const copy = async (what: string, text: string) => {
    await copyText(text);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1500);
  };
  const Code = ({ id, text, show = text }: { id: string; text: string; show?: ReactNode }) => (
    <span className="code-copy"><code>{show}</code><button type="button" className="ghost small" onClick={() => void copy(id, text)} aria-label={`Copy ${id}`}>{copied === id ? <Check /> : <Copy />}</button></span>
  );
  const url = `${window.location.origin}/api/shortcut`;
  const auth = `Bearer ${token ?? 'your-key'}`;
  const shared = state.settings.shortcut_link;

  return (
    <div className="stack" data-testid="shortcut-setup">
      <div className="info-box small" data-testid="shortcut-status">
        {trip.closed ? `${trip.name} is closed, so the shortcut won’t ask about it.`
          : trip.start_date && trip.end_date ? <>From <strong>{fmtDate(trip.start_date)}</strong> to <strong>{fmtDate(trip.end_date)}</strong>, every Apple Pay payment pops up “add to {trip.name}?” with <em>Split with the group</em>, <em>Just me</em>, <em>Edit in Kitty</em> or <em>Skip</em>. Other days stay silent.</>
          : <>Give {trip.name} a start and end date (Edit) so the shortcut knows when to ask.</>}
        {' '}Set up once per iPhone; every trip with dates then works by itself.
      </div>

      <section className="stack tight">
        <h3 className="row"><KeyRound />1. Your key</h3>
        {token ? (
          <>
            <Code id="key" text={token} />
            <span className="hint">Shown once. It goes into the shortcut and lets it add your Apple Pay payments on trip days, nothing else. Revoke it any time.</span>
          </>
        ) : keys?.length ? (
          <span className="muted small">You have a key, made {fmtDate(keys[0]!.created_at.slice(0, 10))}{keys[0]!.last_used_at ? `, last used ${fmtWhen(keys[0]!.last_used_at)}` : ', not used yet'}. Lost it? Make a new one.</span>
        ) : keys ? <span className="muted small">No key yet.</span> : <Spinner />}
        <div className="row">
          <button className={keys?.length ? '' : 'primary'} disabled={busy} onClick={() => void newKey()} data-testid="new-key">{keys?.length ? 'New key' : 'Create my key'}</button>
          {keys?.map((k) => <DangerButton key={k.id} confirm="Revoke this key? The shortcut on that phone stops working until you give it a new one." onConfirm={async () => { await api('DELETE', `/api/keys/${k.id}`); setKeys(await api<Key[]>('GET', '/api/keys')); if (keys.length === 1) setToken(null); }}>Revoke {keys.length > 1 ? fmtDate(k.created_at.slice(0, 10)) : 'key'}</DangerButton>)}
        </div>
      </section>

      <section className="stack tight">
        <h3 className="row"><Smartphone />2. The “Kitty Apple Pay” shortcut</h3>
        {shared && <a className="btn primary" href={shared} target="_blank" rel="noreferrer" data-testid="get-shortcut">Get the shortcut</a>}
        <details open={!shared}>
          <summary>{shared ? 'Or build it yourself' : 'Build it once (about 3 minutes)'}</summary>
          <ol className="steps">
            <li>Open <strong>Shortcuts</strong> → <strong>+</strong>, name it <strong>Kitty Apple Pay</strong>.</li>
            <li>Add <strong>Get Contents of URL</strong>. URL: <Code id="url" text={url} />. Tap the arrow: Method <strong>POST</strong>; Header <code>Authorization</code> = <Code id="auth" text={auth} />; Request Body <strong>JSON</strong> with these Text fields:
              <ul>
                <li><code>amount</code> = Shortcut Input → <em>Amount</em></li>
                <li><code>merchant</code> = Shortcut Input → <em>Merchant</em></li>
                <li><code>card</code> = Shortcut Input → <em>Card or Pass</em> (optional)</li>
                <li><code>date</code> = <em>Current Date</em> (tap it → Date Format → <strong>ISO 8601</strong>)</li>
              </ul>
            </li>
            <li>Add <strong>Get Dictionary Value</strong>: <code>ask</code> in Contents of URL. Then <strong>If</strong> Dictionary Value <strong>is</strong> <code>yes</code>.</li>
            <li>Inside the If: <strong>Get Dictionary Value</strong> <code>prompt</code> (from the same Contents of URL), then <strong>Choose from Menu</strong> with that as the prompt and four items: <em>Split with the group</em>, <em>Just me</em>, <em>Edit in Kitty</em>, <em>Skip</em>.</li>
            <li>Under <em>Split with the group</em>: copy the step-2 action and add a field <code>action</code> = <code>split</code>, then <strong>Show Notification</strong> with Contents of URL. Under <em>Just me</em>: the same with <code>mine</code>. Under <em>Edit in Kitty</em>: the same with <code>edit</code>, then <strong>Open URLs</strong> with Contents of URL. Leave <em>Skip</em> empty.</li>
          </ol>
        </details>
      </section>

      <section className="stack tight">
        <h3 className="row"><Smartphone />3. Run it on every Apple Pay tap</h3>
        <ol className="steps">
          <li>In Shortcuts open <strong>Automation</strong> → <strong>New Automation</strong> → <strong>Transaction</strong>.</li>
          <li>Pick your cards, keep all categories, choose <strong>Run Immediately</strong>, then <strong>Next</strong>.</li>
          <li>Choose <strong>Kitty Apple Pay</strong> (it receives the payment as Shortcut Input). Done: pay with Apple Pay on a trip day to try it.</li>
        </ol>
        <span className="hint">Needs iOS 17 or later and a card in Apple Wallet. “Edit in Kitty” opens Safari, so stay signed in there too.</span>
      </section>

      <section className="stack tight">
        <h3 className="row"><Zap />Kitty expense: cash in two taps</h3>
        <span className="hint">For cash and anything not paid with Apple Pay, without opening Kitty. In the app itself, the + Add button already opens a one-screen Quick add on trip days.</span>
        <details>
          <summary>Build it (about 2 minutes, uses the same key)</summary>
          <ol className="steps">
            <li>New shortcut named <strong>Kitty expense</strong>. Add <strong>Ask for Input</strong> (Number, prompt “Amount”), then <strong>Ask for Input</strong> (Text, prompt “What for?”).</li>
            <li>Add <strong>Choose from Menu</strong> with <em>Everyone</em> and <em>Just me</em>.</li>
            <li>Under each: <strong>Get Contents of URL</strong> like step 2 above (same URL and Authorization) with JSON fields <code>amount</code> = the first Provided Input, <code>merchant</code> = the second, <code>date</code> = Current Date (ISO 8601), <code>paid</code> = <code>cash</code>, and <code>action</code> = <code>split</code> under Everyone or <code>mine</code> under Just me. Then <strong>Show Notification</strong> with Contents of URL.</li>
            <li>Put it where your thumb is: Share → <strong>Add to Home Screen</strong>, or Settings → Accessibility → Touch → <strong>Back Tap</strong> → Double Tap → Kitty expense, or just say “Hey Siri, Kitty expense”.</li>
          </ol>
        </details>
        <span className="hint">Type the amount in the trip’s currency; it comes out of your cash wallet in that currency, so cash in hand stays right.</span>
      </section>

      <section className="stack tight">
        <h3 className="row"><Receipt />Share to Kitty: Google Pay receipts</h3>
        <span className="hint">In Google Pay open a payment → Share → <strong>Share to Kitty</strong>. Kitty opens it filled in: a repayment when it is a friend (matched by the UPI ID on People, else the name), otherwise an expense. Check it and save. Sharing the same receipt twice is caught by its UPI transaction ID.</span>
        <details>
          <summary>Build it (about 1 minute, no key needed)</summary>
          <ol className="steps">
            <li>New shortcut named <strong>Share to Kitty</strong>. Tap ⓘ, turn on <strong>Show in Share Sheet</strong> and let it receive <strong>Images</strong>.</li>
            <li>Add <strong>Extract Text from Image</strong> (Shortcut Input), then <strong>URL Encode</strong> that Text.</li>
            <li>Add <strong>Open URLs</strong> with <Code id="receipt" text={`${window.location.origin}/#/receipt?text=`} /> followed by the URL Encoded Text.</li>
          </ol>
        </details>
        <span className="hint">It opens in Safari, so stay signed in to Kitty there.</span>
      </section>

      {owner && (
        <section className="stack tight">
          <h3>Share the shortcut with friends</h3>
          <span className="hint">After building it: in Shortcuts, tap ⓘ on Kitty Apple Pay → Share → Set Up Import Questions (ask for the Authorization value, so each friend pastes their own key) → Copy iCloud Link, and paste it here. Friends then get it from this panel and only do steps 1 and 3.</span>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('PUT', '/api/settings', { shortcut_link: link.trim() || null }); await reload(); }); }}>
            <input value={link} placeholder="https://www.icloud.com/shortcuts/…" onChange={(e) => setLink(e.target.value)} style={{ flex: 1, minWidth: 0 }} data-testid="shortcut-link" />
            <button type="submit" disabled={busy || link.trim() === (shared ?? '')}>Save</button>
          </form>
        </section>
      )}
      <ErrorBox error={err} />
    </div>
  );
}
