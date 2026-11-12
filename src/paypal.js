// PayPal client: OAuth2 + Payouts + Invoicing against the SANDBOX REST API.
// With no credentials it falls back to a clearly-labelled simulation so the app is runnable by anyone.

import crypto from 'node:crypto';

const SANDBOX = 'https://api-m.sandbox.paypal.com';

export function createPayPal({ clientId, secret, baseUrl, fetchImpl = fetch, simulateDelayMs = 350 } = {}) {
  const live = !!(clientId && secret);
  const base = (baseUrl || SANDBOX).replace(/\/$/, '');
  if (/^https:\/\/api(-m)?\.paypal\.com/i.test(base)) {
    throw new Error('Mandate is sandbox-only. Refusing to use the live PayPal API.');
  }

  let tok = null;
  async function token() {
    if (tok && tok.exp > Date.now() + 30_000) return tok.value;
    const r = await fetchImpl(base + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`PayPal auth failed (${r.status}): ${j.error_description || j.error || 'unknown error'}`);
    tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
    return tok.value;
  }

  async function api(method, pathname, body, headers = {}) {
    const r = await fetchImpl(base + pathname, {
      method,
      headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let j = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    if (!r.ok) {
      const detail = j.details?.[0]?.description || j.message || j.error_description || text.slice(0, 200);
      throw new Error(`PayPal ${method} ${pathname} failed (${r.status}): ${detail}${j.debug_id ? ` [debug_id ${j.debug_id}]` : ''}`);
    }
    return { json: j, status: r.status };
  }

  const fakeId = (p) => `${p}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const amt = (n) => Number(n).toFixed(2);

  return {
    mode: live ? 'sandbox' : 'simulated',
    label: live ? 'PayPal Sandbox (live API)' : 'Simulated PayPal (no credentials)',

    // Payouts API: idempotent through sender_batch_id (we use our action id).
    async createPayout({ email, amount, currency, note, senderItemId }) {
      if (!live) {
        await sleep(simulateDelayMs);
        return { provider: 'simulated', kind: 'payout', id: fakeId('SIM-PAYOUT'), status: 'SUCCESS', link: null };
      }
      const { json } = await api('POST', '/v1/payments/payouts', {
        sender_batch_header: {
          sender_batch_id: senderItemId,
          email_subject: 'You have a payment',
          email_message: 'Payment sent by Mandate (sandbox).',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: email,
            amount: { value: amt(amount), currency },
            note: (note || 'Payment').slice(0, 160),
            sender_item_id: senderItemId,
          },
        ],
      });
      return {
        provider: 'paypal-sandbox',
        kind: 'payout',
        id: json.batch_header?.payout_batch_id,
        status: json.batch_header?.batch_status || 'PENDING',
        link: null,
      };
    },

    // Invoicing API v2: next invoice number -> create draft -> send -> read back the recipient link.
    async createInvoice({ email, name, description, amount, currency, memo, requestId }) {
      if (!live) {
        await sleep(simulateDelayMs);
        return { provider: 'simulated', kind: 'invoice', id: fakeId('SIM-INV'), status: 'SENT', link: null };
      }
      let invoiceNumber;
      try {
        const n = await api('POST', '/v2/invoicing/generate-next-invoice-number', {});
        invoiceNumber = n.json.invoice_number;
      } catch {
        invoiceNumber = undefined; // PayPal can assign one itself
      }
      const [given, ...rest] = String(name || email).trim().split(/\s+/);
      const created = await api(
        'POST',
        '/v2/invoicing/invoices',
        {
          detail: { ...(invoiceNumber ? { invoice_number: invoiceNumber } : {}), currency_code: currency, note: memo || undefined },
          primary_recipients: [{ billing_info: { name: { given_name: given, surname: rest.join(' ') || undefined }, email_address: email } }],
          items: [{ name: (description || 'Services').slice(0, 200), quantity: '1', unit_amount: { currency_code: currency, value: amt(amount) } }],
        },
        { 'PayPal-Request-Id': requestId },
      );
      const href = created.json.href;
      if (!href) throw new Error('PayPal did not return an invoice href');
      const invPath = new URL(href).pathname;
      await api('POST', invPath + '/send', { send_to_recipient: true, send_to_invoicer: false });
      let link = null;
      try {
        const got = await api('GET', invPath);
        link = got.json.detail?.metadata?.recipient_view_url || null;
      } catch {
        /* link is a nicety */
      }
      return { provider: 'paypal-sandbox', kind: 'invoice', id: invPath.split('/').pop(), status: 'SENT', link };
    },

    async payoutStatus(batchId) {
      if (!live) return { status: 'SUCCESS', itemStatus: 'SUCCESS' };
      const { json } = await api('GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
      return { status: json.batch_header?.batch_status, itemStatus: json.items?.[0]?.transaction_status };
    },

    async invoiceStatus(invoiceId) {
      if (!live) return { status: 'SENT' };
      const { json } = await api('GET', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
      return { status: json.status };
    },

    // Webhook signature verification through PayPal's own verify endpoint.
    async verifyWebhook({ headers, event, webhookId }) {
      if (!live) return false;
      const { json } = await api('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event,
      });
      return json.verification_status === 'SUCCESS';
    },
  };
}
