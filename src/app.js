import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { validatePolicy } from './policy.js';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };

export function createApp({ store, engine, paypal, agent, env = {} }) {
  const s = () => store.state;

  const send = (res, code, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };

  const readBody = (req, limit = 1_000_000) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('Body too large'), { code: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const readJson = async (req) => {
    const raw = await readBody(req);
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw Object.assign(new Error('Invalid JSON'), { code: 400 });
    }
  };

  function publicState() {
    return {
      mode: { paypal: paypal.mode, paypalLabel: paypal.label, ai: agent.mode, aiLabel: agent.label },
      budget: engine.budget(),
      policy: s().policy,
      vendors: s().vendors,
      actions: s().actions.slice(0, 200),
      chat: s().chat.slice(-60),
      audit: s().audit.slice(-80).reverse(),
      auditCount: s().audit.length,
    };
  }

  async function route(req, res, url) {
    const m = req.method;
    const p = url.pathname;

    // Basic CSRF guard: browsers send Origin on cross-site writes.
    if (m !== 'GET' && req.headers.origin) {
      let ok = false;
      try {
        ok = new URL(req.headers.origin).host === req.headers.host;
      } catch {
        /* bad origin */
      }
      if (!ok) return send(res, 403, { error: 'Cross-origin request refused' });
    }

    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
    if (m === 'GET' && p === '/api/state') return send(res, 200, publicState());

    if (m === 'POST' && p === '/api/chat') {
      const body = await readJson(req);
      const message = String(body.message || '').trim().slice(0, 4000);
      if (!message) return send(res, 400, { error: 'Say something first.' });
      const history = s().chat.map((c) => ({ role: c.role, text: c.text }));
      s().chat.push({ role: 'user', text: message, ts: new Date().toISOString() });
      const tb = engine.toolbox('chat');
      const out = await agent.run({ message, history, toolbox: tb });
      s().chat.push({ role: 'agent', text: out.reply, actionIds: tb.touched, planner: out.planner, ts: new Date().toISOString() });
      if (s().chat.length > 200) s().chat.splice(0, s().chat.length - 200);
      store.audit('chat', { planner: out.planner, proposals: tb.touched.length });
      store.save();
      return send(res, 200, { reply: out.reply, actionIds: tb.touched, planner: out.planner });
    }

    let mm;
    if (m === 'POST' && (mm = p.match(/^\/api\/actions\/([\w]+)\/(approve|reject|refresh)$/))) {
      const [, id, op] = mm;
      const a = await engine[op](id);
      return send(res, 200, a);
    }

    if (m === 'PUT' && p === '/api/policy') {
      const body = await readJson(req);
      try {
        s().policy = validatePolicy(body, s().policy);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      store.audit('policy_changed', s().policy);
      store.save();
      return send(res, 200, s().policy);
    }

    if (m === 'POST' && p === '/api/vendors') {
      const b = await readJson(req);
      const name = String(b.name || '').trim().slice(0, 80);
      const email = String(b.email || '').trim().toLowerCase();
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return send(res, 400, { error: 'A name and a valid email are required.' });
      const existing = s().vendors.find((v) => v.email === email);
      if (existing) Object.assign(existing, { name, trusted: !!b.trusted });
      else s().vendors.push({ name, email, trusted: !!b.trusted });
      store.audit('vendor_saved', { name, email, trusted: !!b.trusted });
      store.save();
      return send(res, 200, s().vendors);
    }

    if (m === 'DELETE' && (mm = p.match(/^\/api\/vendors\/(.+)$/))) {
      const email = decodeURIComponent(mm[1]).toLowerCase();
      s().vendors = s().vendors.filter((v) => v.email !== email);
      store.audit('vendor_removed', { email });
      store.save();
      return send(res, 200, s().vendors);
    }

    if (m === 'GET' && p === '/api/audit/verify') return send(res, 200, store.verifyAudit());

    if (m === 'POST' && p === '/api/reset') {
      store.reset();
      return send(res, 200, publicState());
    }

    // Agent-to-agent: a peer agent asks us to pay it. Same policy engine, same human-approval path.
    if (m === 'GET' && p === '/.well-known/agent.json') {
      return send(res, 200, {
        name: 'Mandate',
        description: 'Policy-bound payment agent. Peer agents may request payment; every request is evaluated by a deterministic policy and may require human approval.',
        endpoints: { request_payment: { method: 'POST', path: '/api/a2a/payment-request', body: { from_agent: 'string', payee_email: 'string', amount: 'number', currency: 'string', memo: 'string' }, auth: env.MANDATE_A2A_KEY ? 'bearer' : 'none (local demo)' } },
        settlement: 'PayPal Payouts (sandbox)',
      });
    }

    if (m === 'POST' && p === '/api/a2a/payment-request') {
      if (env.MANDATE_A2A_KEY && req.headers.authorization !== `Bearer ${env.MANDATE_A2A_KEY}`) return send(res, 401, { error: 'Unauthorized' });
      const b = await readJson(req);
      const from = String(b.from_agent || 'unknown-agent').replace(/[^\w.\- ]/g, '').slice(0, 40) || 'unknown-agent';
      const tb = engine.toolbox(`agent:${from}`);
      const out = await tb.propose_payment({ payee: b.payee_email, amount: b.amount, currency: b.currency, memo: b.memo });
      store.save();
      return send(res, out.error ? 422 : 200, out);
    }

    // PayPal webhooks: signature verified through PayPal before anything changes.
    if (m === 'POST' && p === '/api/webhooks/paypal') {
      if (!env.PAYPAL_WEBHOOK_ID || paypal.mode !== 'sandbox') return send(res, 501, { error: 'Webhook verification is not configured (set PAYPAL_WEBHOOK_ID and sandbox credentials).' });
      const raw = await readBody(req);
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'Invalid JSON' });
      }
      const ok = await paypal.verifyWebhook({ headers: req.headers, event, webhookId: env.PAYPAL_WEBHOOK_ID }).catch(() => false);
      if (!ok) return send(res, 401, { error: 'Signature verification failed' });
      const r = event.resource || {};
      const ids = [r.payout_batch_id, r.batch_header?.payout_batch_id, r.invoice?.id, r.id].filter(Boolean);
      const a = s().actions.find((x) => x.result && ids.includes(x.result.id));
      if (a) {
        a.result.status = String(event.event_type || '').split('.').pop();
        a.result.checkedAt = new Date().toISOString();
        store.audit('webhook', { id: a.id, event: event.event_type });
        store.save();
      }
      return send(res, 200, { received: true, matched: !!a });
    }

    if (m === 'GET') return serveStatic(res, p);
    return send(res, 404, { error: 'Not found' });
  }

  function serveStatic(res, p) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  return http.createServer(async (req, res) => {
    try {
      await route(req, res, new URL(req.url, 'http://local'));
    } catch (e) {
      send(res, e.code && Number.isInteger(e.code) ? e.code : 500, { error: e.message || 'Server error' });
    }
  });
}
