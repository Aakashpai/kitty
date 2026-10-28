import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(<App />);

// Installable, opens offline. Not on the Vite dev server (port 5173), where files change on every save.
if ('serviceWorker' in navigator && location.port !== '5173') void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
