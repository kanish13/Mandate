// The engine owns the lifecycle of every action: propose -> policy -> (execute | queue | deny) -> approve/reject.
// Nothing outside this file can cause PayPal to move money.

import crypto from 'node:crypto';
import { evaluate } from './policy.js';

const newId = () => 'act_' + crypto.randomBytes(5).toString('hex');
const EMAIL_IN_TEXT = /[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+/;

export function parseAmount(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

export function createEngine({ store, paypal }) {
  const s = () => store.state;
  const ctx = () => ({ policy: s().policy, actions: s().actions, now: Date.now() });

  function resolveVendor(q) {
    q = String(q || '').trim();
    if (!q) return null;
    const m = q.match(EMAIL_IN_TEXT);
    if (m) {
      const email = m[0].toLowerCase();
      return s().vendors.find((v) => v.email.toLowerCase() === email) || { name: email, email, trusted: false, adhoc: true };
    }
    const lc = q.toLowerCase();
    return (
      s().vendors.find((v) => v.name.toLowerCase() === lc) ||
      s().vendors.find((v) => v.name.toLowerCase().includes(lc) || lc.includes(v.name.toLowerCase())) ||
      null
    );
  }

  function budget() {
    const p = s().policy;
    const now = Date.now();
    const spent = s()
      .actions.filter((a) => a.type === 'payment' && ['executed', 'executing'].includes(a.status) && now - Date.parse(a.createdAt) < 86_400_000)
      .reduce((n, a) => n + (a.usd || 0), 0);
    return {
      moved_last_24h_usd: Math.round(spent * 100) / 100,
      daily_budget_usd: p.dailyBudgetUsd,
      remaining_usd: Math.max(0, Math.round((p.dailyBudgetUsd - spent) * 100) / 100),
      auto_approve_limit_usd: p.autoApproveLimitUsd,
      hard_cap_usd: p.hardCapUsd,
      awaiting_approval: s().actions.filter((a) => a.status === 'pending').length,
    };
  }

  async function execute(action, decidedBy) {
    action.status = 'executing';
    action.decidedBy = decidedBy;
    store.save();
    try {
      const p = action.params;
      action.result =
        action.type === 'payment'
          ? await paypal.createPayout({ email: p.payee_email, amount: p.amount, currency: p.currency, note: p.memo, senderItemId: action.id })
          : await paypal.createInvoice({ email: p.payee_email, name: p.payee_name, description: p.description, amount: p.amount, currency: p.currency, memo: p.memo, requestId: action.id });
      action.status = 'executed';
      action.executedAt = new Date().toISOString();
      store.audit('executed', { id: action.id, by: decidedBy, provider: action.result.provider, ref: action.result.id });
    } catch (e) {
      action.status = 'failed';
      action.error = e.message;
      store.audit('failed', { id: action.id, error: e.message });
    }
    store.save();
    return action;
  }

  async function propose(input, source = 'chat') {
    const type = input.type === 'invoice' ? 'invoice' : 'payment';
    const params = {
      payee_name: String(input.payee_name || input.payee_email || '').slice(0, 120),
      payee_email: String(input.payee_email || '').trim().toLowerCase(),
      amount: parseAmount(input.amount),
      currency: String(input.currency || 'USD').trim().toUpperCase(),
      memo: String(input.memo || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      description: String(input.description || '').slice(0, 200),
      vendor_trusted: !!input.vendor_trusted,
    };
    const ev = evaluate(type, params, ctx());
    const action = {
      id: newId(),
      type,
      source,
      createdAt: new Date().toISOString(),
      params,
      usd: ev.usd,
      policy: { decision: ev.decision, checks: ev.checks },
      status: ev.decision === 'deny' ? 'denied' : ev.decision === 'needs_approval' ? 'pending' : 'proposed',
      decidedBy: ev.decision === 'deny' ? 'policy' : null,
      result: null,
      error: null,
    };
    s().actions.unshift(action);
    store.audit('proposed', { id: action.id, type, source, payee: params.payee_email, amount: params.amount, currency: params.currency, decision: ev.decision });
    if (ev.decision === 'auto_approve') await execute(action, 'policy');
    store.save();
    return action;
  }

  const find = (id) => s().actions.find((a) => a.id === id);

  async function approve(id) {
    const a = find(id);
    if (!a) throw Object.assign(new Error('Unknown action'), { code: 404 });
    if (a.status !== 'pending') throw Object.assign(new Error(`Action is ${a.status}, not pending`), { code: 409 });
    // Re-check hard rules at approval time: policy may have changed, and blocks can never be overridden.
    const ev = evaluate(a.type, a.params, ctx(), a.id);
    if (ev.decision === 'deny') {
      a.status = 'denied';
      a.decidedBy = 'policy';
      a.policy = { decision: ev.decision, checks: ev.checks };
      store.audit('denied_on_approval', { id: a.id });
      store.save();
      return a;
    }
    store.audit('approved', { id: a.id, by: 'human' });
    return execute(a, 'human');
  }

  function reject(id) {
    const a = find(id);
    if (!a) throw Object.assign(new Error('Unknown action'), { code: 404 });
    if (a.status !== 'pending') throw Object.assign(new Error(`Action is ${a.status}, not pending`), { code: 409 });
    a.status = 'rejected';
    a.decidedBy = 'human';
    store.audit('rejected', { id: a.id, by: 'human' });
    store.save();
    return a;
  }

  async function refresh(id) {
    const a = find(id);
    if (!a?.result) throw Object.assign(new Error('Nothing to refresh'), { code: 404 });
    const st = a.type === 'payment' ? await paypal.payoutStatus(a.result.id) : await paypal.invoiceStatus(a.result.id);
    a.result.status = a.type === 'payment' ? st.itemStatus || st.status : st.status;
    a.result.checkedAt = new Date().toISOString();
    store.audit('status_refreshed', { id: a.id, status: a.result.status });
    store.save();
    return a;
  }

  function summarize(a) {
    return {
      action_id: a.id,
      status: a.status === 'executed' ? 'executed' : a.status === 'pending' ? 'pending_human_approval' : a.status,
      decision: a.policy.decision,
      reasons: a.policy.checks.filter((c) => c.status !== 'pass').map((c) => c.detail),
      reference: a.result?.id,
      provider: a.result?.provider,
      error: a.error || undefined,
    };
  }

  // The only surface an AI agent (or a peer agent) gets. Note: no "execute" and no "approve".
  function toolbox(source) {
    const touched = [];
    return {
      touched,
      async propose_payment(a = {}) {
        const v = resolveVendor(a.payee);
        if (!v) return { error: `No vendor matches "${a.payee}" and no PayPal email was given. Ask the user for the payee's PayPal email.` };
        const act = await propose({ type: 'payment', payee_name: v.name, payee_email: v.email, vendor_trusted: !!v.trusted && !v.adhoc, amount: a.amount, currency: a.currency, memo: a.memo }, source);
        touched.push(act.id);
        return summarize(act);
      },
      async propose_invoice(a = {}) {
        if (!EMAIL_IN_TEXT.test(String(a.client_email || ''))) return { error: 'An invoice needs the client\'s email address. Ask the user for it.' };
        const act = await propose({ type: 'invoice', payee_name: a.client_name || a.client_email, payee_email: a.client_email, amount: a.amount, currency: a.currency, description: a.description, memo: a.memo || a.description }, source);
        touched.push(act.id);
        return summarize(act);
      },
      get_budget_status: () => budget(),
      list_vendors: () => s().vendors.map(({ name, email, trusted }) => ({ name, email, trusted })),
    };
  }

  return { propose, approve, reject, refresh, budget, toolbox, resolveVendor, find };
}
