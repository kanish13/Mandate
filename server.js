import fs from 'node:fs';
import path from 'node:path';
import { createStore } from './src/store.js';
import { createPayPal } from './src/paypal.js';
import { createAgent } from './src/agent.js';
import { createEngine } from './src/engine.js';
import { createApp } from './src/app.js';

// Tiny .env loader (no dependencies).
try {
  for (const line of fs.readFileSync(path.join(import.meta.dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* no .env: fine */
}

const e = process.env;
const store = createStore(e.MANDATE_DATA || path.join(import.meta.dirname, 'data', 'state.json'));
const paypal = createPayPal({ clientId: e.PAYPAL_CLIENT_ID, secret: e.PAYPAL_CLIENT_SECRET, baseUrl: e.PAYPAL_BASE_URL });
const agent = createAgent({ apiKey: e.ANTHROPIC_API_KEY, model: e.MANDATE_MODEL || 'claude-sonnet-5-5', baseUrl: e.ANTHROPIC_BASE_URL });
const engine = createEngine({ store, paypal });
const app = createApp({ store, engine, paypal, agent, env: e });

const port = Number(e.PORT) || 3000;
const host = e.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`\n  Mandate running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`  PayPal : ${paypal.label}`);
  console.log(`  AI     : ${agent.label}\n`);
});
