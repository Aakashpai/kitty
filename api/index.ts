// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/server/app.ts';

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error('TURSO_DATABASE_URL is not set');
const app = createApp({ url, authToken: process.env.TURSO_AUTH_TOKEN, secret: process.env.SESSION_SECRET, staticDir: null });

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await (await app).handle(req, res);
}
