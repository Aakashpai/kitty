import { useEffect, useState } from 'react';
import { ChevronRight, FolderPlus } from 'lucide-react';
import type { DocItem, Id, SharedDocs } from '../../engine/index.ts';
import { api, errorText } from '../api.ts';
import { APP_NAME, Logo } from '../components/ui.tsx';
import { importKey } from '../vault.ts';
import { DocRows, Preview, canPreview, openDecrypted, pathTo, saveBlobUrl, type BlobLocation } from './Docs.tsx';

/** A shared document folder, opened from a link whose hash carries the folder key. Read-only; decryption happens here. */
export function DocsShared({ token, keyB64 }: { token: string; keyB64: string }) {
  const [data, setData] = useState<SharedDocs | null>(null);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [folder, setFolder] = useState<Id | null>(null);
  const [preview, setPreview] = useState<{ doc: DocItem; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<SharedDocs>('GET', `/api/docs/shared/${token}`).then((s) => { setData(s); setFolder(s.folder.id); }).catch((e) => setErr(errorText(e)));
    importKey(keyB64).then(setKey).catch(() => setErr('This link is missing its key. Ask for the full link, including everything after the # sign.'));
  }, [token, keyB64]);
  const open = async (doc: DocItem) => {
    if (!key) return;
    setBusy(true);
    try {
      const loc = await api<BlobLocation>('GET', `/api/docs/shared/${token}/${doc.id}/url`);
      const obj = await openDecrypted(doc, key, loc);
      if (canPreview(doc.mime)) setPreview({ doc, url: obj }); else saveBlobUrl(obj, doc.name);
      setErr(null);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  };
  if (err && !data) return <div className="center-box down"><h2>This link doesn’t work</h2><p className="muted">{err}</p></div>;
  if (!data || !key || folder == null) return <div className="center-box"><span className="pulse" aria-hidden /><p className="muted">Opening the shared folder…</p></div>;
  const all = [{ id: data.folder.id, name: data.folder.name, parent_id: null as Id | null }, ...data.folders];
  const crumbs = pathTo(all, folder);
  const sub = data.folders.filter((f) => f.parent_id === folder);
  const docs = data.documents.filter((x) => x.folder_id === folder);
  return (
    <div className="shared">
      <header className="shared-head">
        <span className="brand" style={{ padding: 0 }}><span className="mark"><Logo size={16} /></span><span>{APP_NAME}</span></span>
        <span className="badge">View only</span>
      </header>
      <main className="main simple-main" style={{ margin: '0 auto' }}>
        <div className="page-head"><div><h1>{data.folder.name}</h1><div className="sub">Shared documents · decrypted in your browser, nothing is stored on this device</div></div></div>
        <div className="stack">
          {crumbs.length > 1 && <div className="crumbs">{crumbs.map((f, i) => <span key={f.id}>{i > 0 && <ChevronRight />}<button type="button" className="ghost small" onClick={() => setFolder(f.id)}>{f.name}</button></span>)}</div>}
          {sub.length > 0 && <div className="chips">{sub.map((f) => <button key={f.id} type="button" className="chip" onClick={() => setFolder(f.id)}><FolderPlus className="cat-glyph" />{f.name}</button>)}</div>}
          {err && <div className="error-box">{err}</div>}
          <div style={{ opacity: busy ? 0.7 : 1 }}><DocRows docs={docs} onOpen={(doc) => void open(doc)} /></div>
        </div>
      </main>
      {preview && <Preview doc={preview.doc} url={preview.url} onClose={() => setPreview(null)} />}
    </div>
  );
}
