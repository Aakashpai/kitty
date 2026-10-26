// Runs the API server (with reload) and the Vite dev server together; Ctrl-C stops both.
import { spawn } from 'node:child_process';
const procs = [
  spawn('node', ['--watch', '--env-file-if-exists=.env', '--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/server/index.ts'], { stdio: 'inherit' }),
  spawn('yarn', ['vite'], { stdio: 'inherit' }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
