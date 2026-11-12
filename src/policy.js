// Deterministic policy engine. No AI is involved in any decision made here.
// The agent can only *propose*; this module decides: auto_approve | needs_approval | deny.

const DAY = 24 * 3600 * 1000;

// Approximate static FX rates, used only to compare amounts against USD limits.
export const FX = { USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.65 };

export const DEFAULT_POLICY = {
  autoApproveLimitUsd: 100,   // payments above this wait for a human
  hardCapUsd: 1000,           // payments above this are refused outright
  dailyBudgetUsd: 500,        // rolling 24h outflow before a human must review
  invoiceAutoLimitUsd: 2500,  // invoices above this wait for a human
  requireKnownVendor: true,   // payees outside the vendor book wait for a human
  allowedCurrencies: ['USD', 'EUR', 'GBP', 'CAD', 'AUD'],
  blockedTerms: ['gift card', 'crypto', 'bitcoin', 'wire transfer', 'western union'],
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INJECTION =
  /(ignore (all |any )?(previous|prior|above)|disregard (the )?(rules|polic|instructions)|system prompt|you are now|approve (all|every|any)|auto[- ]?approve|override (the )?polic)/i;

export function toUSD(amount, currency) {
  const r = FX[currency];
  return r == null ? NaN : amount * r;
}

export function validatePolicy(input, base = DEFAULT_POLICY) {
  const out = { ...base };
  const num = (k, min, max) => {
    if (input[k] === undefined) return;
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${k} must be a number between ${min} and ${max}`);
    out[k] = Math.round(v * 100) / 100;
  };
  num('autoApproveLimitUsd', 0, 1e6);
  num('hardCapUsd', 0, 1e6);
  num('dailyBudgetUsd', 0, 1e7);
  num('invoiceAutoLimitUsd', 0, 1e7);
  if (input.requireKnownVendor !== undefined) out.requireKnownVendor = !!input.requireKnownVendor;
  if (input.allowedCurrencies !== undefined) {
    const list = (Array.isArray(input.allowedCurrencies) ? input.allowedCurrencies : String(input.allowedCurrencies).split(','))
      .map((c) => String(c).trim().toUpperCase())
      .filter(Boolean);
    if (!list.length || list.some((c) => !(c in FX))) throw new Error(`allowedCurrencies must be from: ${Object.keys(FX).join(', ')}`);
    out.allowedCurrencies = [...new Set(list)];
  }
  if (input.blockedTerms !== undefined) {
    out.blockedTerms = (Array.isArray(input.blockedTerms) ? input.blockedTerms : String(input.blockedTerms).split(','))
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean);
  }
  if (out.autoApproveLimitUsd > out.hardCapUsd) throw new Error('autoApproveLimitUsd cannot exceed hardCapUsd');
  return out;
}

const money = (a, c) => `${c} ${Number(a).toFixed(2)}`;

/**
 * @param {'payment'|'invoice'} type
 * @param {{payee_name:string,payee_email:string,amount:number,currency:string,memo:string,vendor_trusted?:boolean}} p
 * @param {{policy:object,actions:object[],now:number}} ctx
 * @param {string|null} excludeId action to ignore when looking at history (used on re-evaluation)
 */
export function evaluate(type, p, ctx, excludeId = null) {
  const { policy, actions, now } = ctx;
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  const amountOk = Number.isFinite(p.amount) && p.amount > 0;
  add('amount', 'Amount is valid', amountOk ? 'pass' : 'block', amountOk ? money(p.amount, p.currency) : 'Amount must be greater than zero.');

  const curOk = policy.allowedCurrencies.includes(p.currency) && p.currency in FX;
  add('currency', 'Currency is allowed', curOk ? 'pass' : 'block', curOk ? p.currency : `${p.currency || '(none)'} is not on the allowed list (${policy.allowedCurrencies.join(', ')}).`);

  const emailOk = EMAIL.test(p.payee_email || '');
  add('email', 'Payee has a valid PayPal email', emailOk ? 'pass' : 'block', emailOk ? p.payee_email : 'A valid PayPal email address is required.');

  const text = `${p.payee_name} ${p.memo}`.toLowerCase();
  const hits = policy.blockedTerms.filter((t) => text.includes(t));
  add('blocked_terms', 'No blocked terms', hits.length ? 'block' : 'pass', hits.length ? `Matched blocked term: ${hits.join(', ')}.` : 'Clean.');

  const inj = INJECTION.test(`${p.payee_name} ${p.memo}`);
  add('injection', 'No instruction-like text in payee/memo', inj ? 'review' : 'pass', inj ? 'Payee or memo text looks like an attempt to instruct the system. A human must look.' : 'Clean.');

  const usd = amountOk && curOk ? toUSD(p.amount, p.currency) : 0;

  if (type === 'payment') {
    const recent = actions.filter(
      (a) => a.id !== excludeId && a.type === 'payment' && ['executed', 'executing', 'pending'].includes(a.status) && now - Date.parse(a.createdAt) < DAY,
    );

    add('hard_cap', 'Under the hard per-payment cap', usd > policy.hardCapUsd ? 'block' : 'pass',
      usd > policy.hardCapUsd ? `≈ $${usd.toFixed(2)} exceeds the $${policy.hardCapUsd} hard cap. This cannot be approved.` : `≈ $${usd.toFixed(2)} ≤ $${policy.hardCapUsd}`);

    add('auto_limit', 'Within the auto-approve limit', usd > policy.autoApproveLimitUsd ? 'review' : 'pass',
      usd > policy.autoApproveLimitUsd ? `≈ $${usd.toFixed(2)} is over the $${policy.autoApproveLimitUsd} auto-approve limit.` : `≈ $${usd.toFixed(2)} ≤ $${policy.autoApproveLimitUsd}`);

    const spent = recent.filter((a) => a.status !== 'pending').reduce((n, a) => n + (a.usd || 0), 0);
    const over = spent + usd > policy.dailyBudgetUsd;
    add('daily_budget', 'Within the rolling 24h budget', over ? 'review' : 'pass',
      over ? `$${spent.toFixed(2)} already moved + ≈ $${usd.toFixed(2)} would pass the $${policy.dailyBudgetUsd} daily budget.` : `$${spent.toFixed(2)} + ≈ $${usd.toFixed(2)} ≤ $${policy.dailyBudgetUsd}`);

    const known = !policy.requireKnownVendor || !!p.vendor_trusted;
    add('vendor', 'Payee is a trusted vendor', known ? 'pass' : 'review', known ? 'In the vendor book.' : 'New payee: not in the trusted vendor book.');

    const sameAmount = recent.filter((a) => a.params.payee_email === p.payee_email && a.params.amount === p.amount && a.params.currency === p.currency);
    add('duplicate', 'Not a duplicate', sameAmount.length ? 'review' : 'pass',
      sameAmount.length ? `Same payee and amount already sent or queued in the last 24h (${sameAmount[0].id}).` : 'No identical payment in 24h.');

    const toPayee = recent.filter((a) => a.params.payee_email === p.payee_email);
    const cum = toPayee.reduce((n, a) => n + (a.usd || 0), 0) + usd;
    const splitting = toPayee.length >= 1 && usd <= policy.autoApproveLimitUsd && cum > policy.autoApproveLimitUsd;
    add('splitting', 'No payment-splitting pattern', splitting ? 'review' : 'pass',
      splitting ? `Payments to this payee total ≈ $${cum.toFixed(2)} in 24h, over the $${policy.autoApproveLimitUsd} limit that each one individually stays under.` : 'No pattern.');
  } else {
    add('invoice_limit', 'Within the invoice auto-send limit', usd > policy.invoiceAutoLimitUsd ? 'review' : 'pass',
      usd > policy.invoiceAutoLimitUsd ? `≈ $${usd.toFixed(2)} is over the $${policy.invoiceAutoLimitUsd} auto-send limit.` : `≈ $${usd.toFixed(2)} ≤ $${policy.invoiceAutoLimitUsd}`);
  }

  const decision = checks.some((c) => c.status === 'block') ? 'deny' : checks.some((c) => c.status === 'review') ? 'needs_approval' : 'auto_approve';
  return { decision, checks, usd: Math.round(usd * 100) / 100 };
}
