import { createApp } from './app.ts';

const url = process.env.TURSO_DATABASE_URL ?? process.env.LEDGER_DB ?? 'file:data/ledger.db';
const port = Number(process.env.PORT ?? 3210);
const { server } = await createApp({ url, authToken: process.env.TURSO_AUTH_TOKEN });
server.listen(port, () => console.log(`Ledger API on http://localhost:${port} (db: ${url})`));
