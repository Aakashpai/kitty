// Phone notifications (Web Push): no outside service beyond each browser's own push server, which is free.
import webpush from 'web-push';
import { formatAmount, type Id, type Tx, type UserPublic } from '../engine/index.ts';
import type { Db } from './db.ts';

/** Keys are made once and kept in settings, so phones stay subscribed across deploys; the private half never leaves the server. */
async function keys(db: Db): Promise<{ publicKey: string; privateKey: string }> {
  const stored = (await db.getSetting('vapid')) ?? (await db.initSetting('vapid', JSON.stringify(webpush.generateVAPIDKeys())));
  return JSON.parse(stored) as { publicKey: string; privateKey: string };
}
export const publicKey = async (db: Db) => (await keys(db)).publicKey;

/**
 * Tells the people in an entry (and the owner, who sees everything) that someone else added, edited or commented on it.
 * Never fails the request: a dead subscription is dropped, anything else is ignored.
 */
export async function announce(db: Db, actor: UserPublic, tx: Tx, what: 'added' | 'edited' | { comment: string }) {
  const targets = (await db.pushTargets()).filter((s) => s.user_id !== actor.id);
  if (!targets.length) return;
  const involved = new Set([tx.payer_id, tx.payee_id, ...tx.splits.map((s) => s.person_id)]);
  const to = targets.filter((s) => s.role === 'owner' || (s.person_id != null && involved.has(s.person_id)));
  if (!to.length) return;
  const { people, trips } = await db.names();
  const by = (actor.person_id != null ? people.get(actor.person_id) : null) ?? actor.name;
  const label = tx.description || tx.type;
  const trip = tx.trip_id != null ? trips.get(tx.trip_id) : undefined;
  const { publicKey: pub, privateKey } = await keys(db);
  const owner = to.find((s) => s.role === 'owner')?.email ?? targets[0]!.email;
  await Promise.allSettled(to.map(async (s) => {
    const share = tx.splits.find((x) => x.person_id === s.person_id)?.amount;
    const payload = typeof what === 'object'
      ? { title: `${by} on “${label}”`, body: what.comment.slice(0, 140) }
      : { title: `${by} ${what} ${label}`, body: [formatAmount(tx.amount, tx.currency), share ? `your share ${formatAmount(share, tx.currency)}` : '', trip ?? ''].filter(Boolean).join(' · ') };
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...payload, url: trip ? `/#/trips/${tx.trip_id}` : '/#/transactions', tag: `tx-${tx.id}` }), { vapidDetails: { subject: `mailto:${owner}`, publicKey: pub, privateKey }, TTL: 86_400, timeout: 4000 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.removePushSub(s.endpoint).catch(() => undefined); // the phone unsubscribed or the app was removed
    }
  }));
}
