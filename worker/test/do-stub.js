// In-memory stand-ins for a SQLite-backed Durable Object's storage API and its namespace binding.
// Values are structured-cloned like the real storage. transaction() works on a copy and swaps it in only on success.
import { ItemSync } from '../src/index.js';

const sorted = (m) => [...m.keys()].sort();
function api(get) {
  const one = (k) => { const v = get().get(k); return v === undefined ? undefined : structuredClone(v); };
  return {
    async get(k) { if (Array.isArray(k)) { if (k.length > 128) throw new Error('get: more than 128 keys'); const out = new Map(); for (const x of k) { const v = one(x); if (v !== undefined) out.set(x, v); } return out; } return one(k); },
    async put(k, v) {
      if (typeof k === 'object') { const e = Object.entries(k); if (e.length > 128) throw new Error('put: more than 128 entries'); for (const [a, b] of e) get().set(a, structuredClone(b)); return; }
      get().set(k, structuredClone(v));
    },
    async delete(k) { if (Array.isArray(k)) { if (k.length > 128) throw new Error('delete: more than 128 keys'); let n = 0; for (const x of k) n += get().delete(x) ? 1 : 0; return n; } return get().delete(k); },
    async list({ prefix = '', start, end, limit } = {}) {
      const out = new Map();
      for (const k of sorted(get())) {
        if (!k.startsWith(prefix) || (start !== undefined && k < start) || (end !== undefined && k >= end)) continue;
        out.set(k, structuredClone(get().get(k)));
        if (limit && out.size >= limit) break;
      }
      return out;
    },
  };
}
export function memStorage() {
  let m = new Map();
  const s = api(() => m);
  s.m = () => m;
  s.deleteAll = async () => { m = new Map(); };
  s.transaction = async (fn) => {
    const copy = new Map([...m].map(([k, v]) => [k, structuredClone(v)]));
    const tx = api(() => copy);
    tx.rollback = () => { throw new Error('rollback'); };
    const out = await fn(tx);
    m = copy;
    return out;
  };
  return s;
}
// One ItemSync instance per name, memoized, so concurrent calls share its in-memory `running` state and storage.
export function doNamespace() {
  const objs = new Map();
  const ns = {
    objs, env: null, calls: [],
    idFromName: (name) => ({ name, toString: () => 'do:' + name }),
    get(id) {
      return { fetch: async (url, init) => {
        let o = objs.get(id.name);
        if (!o) { const state = { id, storage: memStorage() }; o = { state, inst: new ItemSync(state, ns.env) }; objs.set(id.name, o); }
        const req = url instanceof Request ? url : new Request(url, init);
        ns.calls.push({ name: id.name, op: new URL(req.url).pathname.slice(1) });
        return o.inst.fetch(req);
      } };
    },
    storage: (name) => objs.get(name)?.state.storage.m(),
  };
  return ns;
}
