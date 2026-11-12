import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_POLICY } from './policy.js';

function freshState() {
  return {
    policy: { ...DEFAULT_POLICY },
    vendors: [
      { name: 'Acme Design', email: 'design@acme.example', trusted: true },
      { name: 'CloudHost Co', email: 'billing@cloudhost.example', trusted: true },
      { name: 'Dana Writes', email: 'dana@writes.example', trusted: true },
      { name: 'Pixel Print', email: 'orders@pixelprint.example', trusted: true },
    ],
    actions: [],
    audit: [],
    chat: [],
  };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createStore(file) {
  let state = freshState();
  try {
    state = { ...freshState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    /* first run */
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  // Tamper-evident log: every entry commits to the hash of the previous one.
  function audit(type, data = {}) {
    const prev = state.audit.length ? state.audit[state.audit.length - 1].hash : 'GENESIS';
    const entry = { seq: state.audit.length + 1, ts: new Date().toISOString(), type, data };
    entry.prev = prev;
    entry.hash = sha(prev + JSON.stringify({ seq: entry.seq, ts: entry.ts, type, data }));
    state.audit.push(entry);
    return entry;
  }

  function verifyAudit() {
    let prev = 'GENESIS';
    for (const e of state.audit) {
      const expect = sha(prev + JSON.stringify({ seq: e.seq, ts: e.ts, type: e.type, data: e.data }));
      if (e.prev !== prev || e.hash !== expect) return { ok: false, brokenAt: e.seq, entries: state.audit.length };
      prev = e.hash;
    }
    return { ok: true, entries: state.audit.length };
  }

  function reset() {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, freshState());
    audit('reset', {});
    save();
  }

  return {
    get state() {
      return state;
    },
    save,
    audit,
    verifyAudit,
    reset,
  };
}
