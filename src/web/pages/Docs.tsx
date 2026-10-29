import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ChevronRight, Copy, Download, Eye, File, FileText, FolderPlus, Image, KeyRound, Link2, Lock, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import type { DocFolder, DocItem, DocsState, Id, Vault } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { copyText, useLedger } from '../store.tsx';
import { DangerButton, Empty, ErrorBox, Field, Modal, Spinner, fmtDate, useBusy } from '../components/ui.tsx';
import { decryptBytes, deriveMasterKey, encryptBytes, exportKey, fmtBytes, importKey, loadMaster, makeCheck, newFolderKey, newSalt, passesCheck, rememberMaster, unwrapKey, wrapKey } from '../vault.ts';

// --- shared with the public link page ------------------------------------------------------------------------
export const canPreview = (mime: string) => mime.startsWith('image/') || mime === 'application/pdf';
export const DocGlyph = ({ mime }: { mime: string }) => (mime.startsWith('image/') ? <Image /> : mime === 'application/pdf' || mime.startsWith('text/') ? <FileText /> : <File />);
export const rootOf = <F extends Pick<DocFolder, 'id' | 'parent_id'>>(folders: F[], id: Id): F | undefined => {
  let f = folders.find((x) => x.id === id);
  while (f && f.parent_id != null) f = folders.find((x) => x.id === f!.parent_id);
  return f;
};
export const pathTo = <F extends Pick<DocFolder, 'id' | 'parent_id'>>(folders: F[], id: Id): F[] => {
  const out: F[] = [];
  let f = folders.find((x) => x.id === id);
  while (f) { out.unshift(f); f = f.parent_id != null ? folders.find((x) => x.id === f!.parent_id) : undefined; }
  return out;
};

export interface BlobSlot { storage_key: string; url: string; chunk?: number }
export interface BlobLocation { url: string; chunks?: number }

/** Sends ciphertext to storage: one PUT to a signed bucket URL, or one PUT per chunk to the API. */
export async function putCipher(slot: BlobSlot, ct: ArrayBuffer): Promise<void> {
  if (!slot.chunk) {
    const r = await fetch(slot.url, { method: 'PUT', body: ct });
    if (!r.ok) throw new Error(`Upload failed (${r.status}). If this is a new bucket, check its CORS rule.`);
    return;
  }
  for (let n = 0, off = 0; off < ct.byteLength; n += 1, off += slot.chunk) {
    const r = await fetch(`${slot.url}?n=${n}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: ct.slice(off, off + slot.chunk) });
    if (!r.ok) throw new Error(`Upload failed on part ${n + 1} (${r.status})`);
  }
}
/** Fetches ciphertext back: one signed URL, or every chunk in order. */
export async function fetchCipher(loc: BlobLocation): Promise<ArrayBuffer> {
  if (loc.chunks == null) {
    const r = await fetch(loc.url);
    if (!r.ok) throw new Error(`Could not fetch the file (${r.status})`);
    return r.arrayBuffer();
  }
  if (!loc.chunks) throw new Error('This file has no data stored; upload it again');
  const parts: ArrayBuffer[] = [];
  for (let n = 0; n < loc.chunks; n += 1) {
    const r = await fetch(`${loc.url}?n=${n}`);
    if (!r.ok) throw new Error(`Could not fetch part ${n + 1} of the file (${r.status})`);
    parts.push(await r.arrayBuffer());
  }
  return new Blob(parts).arrayBuffer();
}
/** Fetches the ciphertext, decrypts it here, and hands back an object URL the browser can show or save. */
export async function openDecrypted(doc: Pick<DocItem, 'iv' | 'mime'>, key: CryptoKey, loc: BlobLocation): Promise<string> {
  const plain = await decryptBytes(key, doc.iv, await fetchCipher(loc)).catch(() => { throw new Error('This file could not be decrypted with the key you have'); });
  return URL.createObjectURL(new Blob([plain], { type: doc.mime }));
}
export const saveBlobUrl = (url: string, name: string) => {
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

export function Preview({ doc, url, onClose }: { doc: Pick<DocItem, 'name' | 'mime' | 'size'>; url: string; onClose: () => void }) {
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <Modal title={doc.name} onClose={onClose} wide>
      <div className="stack">
        {doc.mime.startsWith('image/') ? <img className="doc-preview-img" src={url} alt={doc.name} /> : doc.mime === 'application/pdf' ? <iframe className="doc-preview" src={url} title={doc.name} /> : <p className="muted">No preview for this type; download it instead.</p>}
        <div className="row between"><a className="btn" href={url} download={doc.name}><Download />Download</a><span className="faint small">{fmtBytes(doc.size)} · decrypted in your browser</span></div>
      </div>
    </Modal>
  );
}

export function DocRows({ docs, onOpen, onRename, onDelete }: { docs: Pick<DocItem, 'id' | 'name' | 'mime' | 'size' | 'created_at'>[]; onOpen: (d: DocItem) => void; onRename?: (d: DocItem) => void; onDelete?: (d: DocItem) => Promise<void> }) {
  if (!docs.length) return <Empty title="Nothing here yet">{onRename ? 'Add passport scans, visas, tickets, boarding passes or photos. Everything is encrypted before it leaves this device.' : 'This folder is empty.'}</Empty>;
  return (
    <div className="panel">
      {docs.map((d) => (
        <div className="doc-row" key={d.id} data-testid={`doc-${d.id}`}>
          <span className="doc-glyph"><DocGlyph mime={d.mime} /></span>
          <button type="button" className="info" onClick={() => onOpen(d as DocItem)}>
            <span className="name">{d.name}</span>
            <span className="meta">{fmtBytes(d.size)} · {fmtDate(d.created_at.slice(0, 10))}</span>
          </button>
          <span className="actions">
            <button className="small ghost icon" title={canPreview(d.mime) ? 'View' : 'Download'} aria-label={canPreview(d.mime) ? 'View' : 'Download'} onClick={() => onOpen(d as DocItem)}>{canPreview(d.mime) ? <Eye /> : <Download />}</button>
            {onRename && <button className="small ghost icon" title="Rename" aria-label="Rename" onClick={() => onRename(d as DocItem)}><Pencil /></button>}
            {onDelete && <DangerButton confirm={`Delete "${d.name}"? This cannot be undone.`} onConfirm={() => onDelete(d as DocItem)}><Trash2 /></DangerButton>}
          </span>
        </div>
      ))}
    </div>
  );
}

// --- vault setup and unlock ------------------------------------------------------------------------------------
function VaultSetup({ email, onDone }: { email: string; onDone: (master: CryptoKey) => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const [recovery, setRecovery] = useState<{ key: string; master: CryptoKey } | null>(null);
  const [copied, setCopied] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await api('POST', '/api/auth/login', { email, password }); // proves it is the login password, so there is one password to remember
        const salt = newSalt();
        const master = await deriveMasterKey(password, salt);
        await api('POST', '/api/docs/vault', { salt, ...(await makeCheck(master)) });
        await rememberMaster(master);
        setRecovery({ key: await exportKey(master), master });
        setErr(null);
      } catch (x) { setErr(errorText(x)); }
    });
  };
  if (recovery) {
    return (
      <div className="panel pad stack" style={{ maxWidth: 560 }}>
        <h2><KeyRound /> Save your recovery key</h2>
        <p className="muted small">Your documents are encrypted with a key derived from your password. If you ever lose the password, this recovery key is the only other way in. Keep it in a password manager; it is shown once.</p>
        <div className="recovery" data-testid="recovery-key">{recovery.key}</div>
        <div className="row">
          <button onClick={() => void copyText(recovery.key).then(() => setCopied(true))}><Copy />{copied ? 'Copied' : 'Copy'}</button>
          <button className="primary" onClick={() => onDone(recovery.master)} data-testid="recovery-done">I have saved it</button>
        </div>
      </div>
    );
  }
  return (
    <form className="panel pad stack" style={{ maxWidth: 480 }} onSubmit={submit} data-testid="vault-setup">
      <h2><Lock /> Set up your document vault</h2>
      <p className="muted small">Files are encrypted on this device before upload, with a key derived from your login password. Nobody else, including the server, can read them. Enter your password to create the vault.</p>
      <Field label="Your login password"><input type="password" value={password} autoFocus autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} data-testid="vault-password" /></Field>
      <ErrorBox error={err} />
      <button className="primary" type="submit" disabled={busy || !password}>{busy ? <Spinner /> : <Lock />}Create vault</button>
    </form>
  );
}

function Unlock({ vault, onDone }: { vault: Vault; onDone: (master: CryptoKey) => void }) {
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        const master = useRecovery ? await importKey(recovery.trim()) : await deriveMasterKey(password, vault.salt);
        if (!(await passesCheck(master, vault.check_iv, vault.check_ct))) throw new Error(useRecovery ? 'That recovery key does not open this vault' : 'Wrong password');
        await rememberMaster(master);
        onDone(master);
      } catch (x) { setErr(errorText(x)); }
    });
  };
  return (
    <form className="panel pad stack" style={{ maxWidth: 480 }} onSubmit={submit} data-testid="vault-unlock">
      <h2><Lock /> Unlock your documents</h2>
      <p className="muted small">Your files are encrypted; the key is derived from your password and kept only in this tab.</p>
      {useRecovery
        ? <Field label="Recovery key"><input value={recovery} autoFocus onChange={(e) => setRecovery(e.target.value)} /></Field>
        : <Field label="Password"><input type="password" value={password} autoFocus autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} data-testid="unlock-password" /></Field>}
      <ErrorBox error={err} />
      <div className="row between">
        <button className="primary" type="submit" disabled={busy || !(useRecovery ? recovery : password)} data-testid="unlock-submit">{busy ? <Spinner /> : <Lock />}Unlock</button>
        <button type="button" className="ghost small" onClick={() => setUseRecovery((v) => !v)}>{useRecovery ? 'Use password' : 'Use recovery key'}</button>
      </div>
    </form>
  );
}

// --- the page --------------------------------------------------------------------------------------------------
export function Docs({ folderId }: { folderId: number | null }) {
  const { user } = useLedger();
  const [d, setD] = useState<DocsState | null>(null);
  const [master, setMaster] = useState<CryptoKey | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const keys = useRef(new Map<Id, CryptoKey>());
  const reload = async () => setD(await api<DocsState>('GET', '/api/docs'));
  useEffect(() => {
    void reload().catch((e) => setErr(errorText(e)));
    void loadMaster().then(setMaster);
  }, []);
  // A key remembered by this tab must still open the vault (it was re-keyed if the password changed elsewhere).
  useEffect(() => {
    if (d?.vault && master) void passesCheck(master, d.vault.check_iv, d.vault.check_ct).then((ok) => { if (!ok) { keys.current.clear(); setMaster(null); } });
  }, [d?.vault?.check_ct, master]);
  if (err) return <div className="stack"><h1>Documents</h1><ErrorBox error={err} /></div>;
  if (!d || master === undefined) return <div className="center-box"><Spinner /></div>;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Documents</h1><div className="sub">Passports, visas, tickets and boarding passes, encrypted on your device before they are stored</div></div>
      </div>
      {!d.vault ? <VaultSetup email={user?.email ?? ''} onDone={(m) => { setMaster(m); void reload(); }} />
        : !master ? <Unlock vault={d.vault} onDone={setMaster} />
          : <Browser d={d} master={master} keys={keys.current} folderId={folderId} reload={reload} />}
    </div>
  );
}

function Browser({ d, master, keys, folderId, reload }: { d: DocsState; master: CryptoKey; keys: Map<Id, CryptoKey>; folderId: number | null; reload: () => Promise<void> }) {
  const { trips, state } = useLedger();
  const folders = d.folders;
  const roots = folders.filter((f) => f.parent_id == null);
  const personal = roots.find((f) => f.trip_id == null);
  const current = (folderId != null && !Number.isNaN(folderId) ? folders.find((f) => f.id === folderId) : undefined) ?? personal;
  const root = current ? rootOf(folders, current.id) : undefined;
  const [busy, run] = useBusy();
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ doc: DocItem; url: string } | null>(null);
  const [share, setShare] = useState(false);
  const [naming, setNaming] = useState<{ kind: 'folder' | 'doc'; id?: Id; value: string } | null>(null);
  const [over, setOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const keyFor = async (folder: DocFolder) => {
    const r = rootOf(folders, folder.id)!;
    let k = keys.get(r.id);
    if (!k) { k = await unwrapKey(master, r.key_iv!, r.key_ct!); keys.set(r.id, k); }
    return k;
  };
  const createRoot = async (name: string, trip_id: Id | null) => {
    const k = await newFolderKey();
    const f = await api<DocFolder>('POST', '/api/docs/folders', { name, trip_id, ...(await wrapKey(master, k)) });
    keys.set(f.id, k);
    await reload();
    return f;
  };
  // The first visit creates the Personal folder.
  useEffect(() => { if (!personal) void run(() => createRoot('Personal', null).then(() => undefined).catch((e) => setErr(errorText(e)))); }, [personal]);
  const act = (fn: () => Promise<void>) => run(async () => { try { await fn(); setErr(null); } catch (e) { setErr(errorText(e)); } });

  const upload = (files: File[]) => act(async () => {
    if (!current || !files.length) return;
    const key = await keyFor(current);
    try {
      let i = 0;
      for (const file of files) {
        i += 1;
        setProgress(`Encrypting and uploading ${i} of ${files.length}: ${file.name}`);
        const mime = file.type || 'application/octet-stream';
        const { iv, ct } = await encryptBytes(key, await file.arrayBuffer());
        const slot = await api<BlobSlot>('POST', '/api/docs/upload', { folder_id: current.id, name: file.name, mime, size: file.size });
        await putCipher(slot, ct);
        await api('POST', '/api/docs', { folder_id: current.id, name: file.name, mime, size: file.size, storage_key: slot.storage_key, iv });
      }
    } finally { setProgress(null); }
    await reload();
  });
  const open = (doc: DocItem) => act(async () => {
    const folder = folders.find((f) => f.id === doc.folder_id)!;
    const loc = await api<BlobLocation>('GET', `/api/docs/${doc.id}/url`);
    const obj = await openDecrypted(doc, await keyFor(folder), loc);
    if (canPreview(doc.mime)) setPreview({ doc, url: obj }); else saveBlobUrl(obj, doc.name);
  });
  const saveName = (e: FormEvent) => {
    e.preventDefault();
    if (!naming) return;
    const n = naming;
    void act(async () => {
      if (n.kind === 'doc') await api('PUT', `/api/docs/${n.id}`, { name: n.value });
      else if (n.id != null) await api('PUT', `/api/docs/folders/${n.id}`, { name: n.value });
      else await api('POST', '/api/docs/folders', { name: n.value, parent_id: current!.id });
      setNaming(null);
      await reload();
    });
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); void upload([...e.dataTransfer.files]); };

  if (!current || !root) return <div className="center-box"><Spinner /></div>;
  const docs = d.documents.filter((x) => x.folder_id === current.id);
  const subfolders = folders.filter((f) => f.parent_id === current.id);
  const crumbs = pathTo(folders, current.id);
  const tripName = (f: DocFolder) => (f.trip_id != null ? trips.get(f.trip_id)?.name ?? f.name : f.name);
  const tripsWithout = state.trips.filter((t) => !t.archived && !roots.some((f) => f.trip_id === t.id));
  const canDeleteFolder = (current.parent_id != null || current.trip_id != null) && !docs.length && !subfolders.length; // Personal stays; empty trip folders and subfolders can go
  const used = d.documents.reduce((sum, x) => sum + x.size, 0);
  return (
    <div className="docs">
      <nav className="nav doc-nav" aria-label="Folders">
        {roots.map((f) => <a key={f.id} href={`#/docs/${f.id}`} className={root.id === f.id ? 'active' : ''}>{f.trip_id != null ? <Link2 /> : <Lock />}<span className="label">{tripName(f)}</span></a>)}
        {tripsWithout.length > 0 && <div className="nav-label">Trips without a folder</div>}
        {tripsWithout.map((t) => <button key={t.id} type="button" className="ghost nav-add" disabled={busy} onClick={() => void act(async () => { const f = await createRoot(t.name, t.id); window.location.hash = `#/docs/${f.id}`; })}><Plus /><span className="label">{t.name}</span></button>)}
      </nav>
      <div className="stack" onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <div className="row between">
          <div className="crumbs">{crumbs.map((f, i) => <span key={f.id}>{i > 0 && <ChevronRight />}<a href={`#/docs/${f.id}`}>{i === 0 ? tripName(f) : f.name}</a></span>)}</div>
          <div className="row">
            <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ''; }} data-testid="doc-file" />
            <button className="primary" disabled={busy} onClick={() => fileInput.current?.click()} data-testid="doc-upload"><Upload />Upload</button>
            <button disabled={busy} onClick={() => setNaming({ kind: 'folder', value: '' })}><FolderPlus />New folder</button>
            {current.parent_id == null && current.trip_id != null && <button disabled={busy} onClick={() => setShare(true)} data-testid="doc-share"><Link2 />{d.shares.some((s) => s.folder_id === current.id) ? 'Shared' : 'Share'}</button>}
            {current.parent_id != null && <button className="ghost small" onClick={() => setNaming({ kind: 'folder', id: current.id, value: current.name })}><Pencil />Rename</button>}
            {canDeleteFolder && <DangerButton confirm={`Delete the empty folder "${tripName(current)}"?`} onConfirm={async () => { await api('DELETE', `/api/docs/folders/${current.id}`); window.location.hash = current.parent_id != null ? `#/docs/${current.parent_id}` : '#/docs'; await reload(); }}>Delete folder</DangerButton>}
          </div>
        </div>
        {naming && (
          <form className="row" onSubmit={saveName}>
            <input value={naming.value} autoFocus placeholder={naming.kind === 'folder' ? 'Folder name' : 'File name'} onChange={(e) => setNaming({ ...naming, value: e.target.value })} data-testid="doc-name" />
            <button className="primary small" type="submit" disabled={busy || !naming.value.trim()}>{naming.id != null ? 'Rename' : 'Create'}</button>
            <button className="ghost small" type="button" onClick={() => setNaming(null)}>Cancel</button>
          </form>
        )}
        {subfolders.length > 0 && <div className="chips">{subfolders.map((f) => <a key={f.id} className="chip" href={`#/docs/${f.id}`}><FolderPlus className="cat-glyph" />{f.name}</a>)}</div>}
        {progress && <div className="info-box"><Spinner /> {progress}</div>}
        <ErrorBox error={err} />
        <DocRows docs={docs} onOpen={open} onRename={(doc) => setNaming({ kind: 'doc', id: doc.id, value: doc.name })} onDelete={async (doc) => { await api('DELETE', `/api/docs/${doc.id}`); await reload(); }} />
        <div className={`dropzone${over ? ' over' : ''}`}>Drop files here, or use Upload. Each file is encrypted in this browser before it is stored{d.storage === 'db' ? ', in the ledger’s own database' : ''}.</div>
        <div className="faint small" data-testid="doc-usage">{d.documents.length} file{d.documents.length === 1 ? '' : 's'} · {fmtBytes(used)} stored{d.storage === 'r2' ? ' of the 10 GB free on Cloudflare R2' : ''}</div>
      </div>
      {preview && <Preview doc={preview.doc} url={preview.url} onClose={() => setPreview(null)} />}
      {share && <DocShareModal folder={root} name={tripName(root)} shares={d.shares.filter((s) => s.folder_id === root.id)} keyFor={() => keyFor(root)} reload={reload} onClose={() => setShare(false)} />}
    </div>
  );
}

function DocShareModal({ folder, name, shares, keyFor, reload, onClose }: { folder: DocFolder; name: string; shares: DocsState['shares']; keyFor: () => Promise<CryptoKey>; reload: () => Promise<void>; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [busy, run] = useBusy();
  const linkOf = async (token: string) => `${window.location.origin}${window.location.pathname}#/docs/s/${token}/${await exportKey(await keyFor())}`;
  return (
    <Modal title={`Share ${name} documents`} onClose={onClose}>
      <div className="stack">
        <p className="muted small">Anyone with the link can view and download what is in this folder, straight in their browser. The link carries the folder’s key after the # sign, which browsers never send to the server, so only people you give the link to can read the files. Turn a link off any time.</p>
        {shares.length > 0 && (
          <div className="panel">
            {shares.map((x) => (
              <div className="doc-row" key={x.id}>
                <span className="doc-glyph"><Link2 /></span>
                <span className="info"><span className="name">{x.label || 'View-only link'}</span><span className="meta">Created {fmtDate(x.created_at.slice(0, 10))}</span></span>
                <span className="actions">
                  <button className="small" onClick={() => void linkOf(x.token).then((l) => copyText(l)).then(() => { setCopied(x.id); window.setTimeout(() => setCopied(null), 1500); })}><Copy />{copied === x.id ? 'Copied' : 'Copy link'}</button>
                  <button className="small danger" disabled={busy} onClick={() => void run(async () => { await api('DELETE', `/api/docs/shares/${x.id}`); await reload(); })}><Trash2 />Turn off</button>
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input value={label} placeholder="Label (optional), e.g. For the group chat" onChange={(e) => setLabel(e.target.value)} />
          <button className="primary" disabled={busy} onClick={() => void run(async () => { try { await api('POST', '/api/docs/shares', { folder_id: folder.id, label: label || null }); setLabel(''); await reload(); setErr(null); } catch (e) { setErr(errorText(e)); } })}>{busy ? <Spinner /> : <Link2 />}New link</button>
        </div>
        <ErrorBox error={err} />
      </div>
    </Modal>
  );
}
