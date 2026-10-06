'use strict';
// Optimistic, atomic transactions: simultaneous readers conflict and retry;
// writes are not visible until commit, and reads after writes are forbidden.
function database(seed) {
  const rows = new Map(Object.entries(seed));
  let revision = 0;
  const ref = (path) => ({ path, id: path.split('/').at(-1), get: async () => snap(path), set: async (value) => { rows.set(path, structuredClone(value)); revision++; } });
  const snap = (path) => ({ exists: rows.has(path), id: path.split('/').at(-1), data: () => structuredClone(rows.get(path)), ref: ref(path) });
  return {
    rows,
    collection: (name) => {
      const filters = [];
      const query = {
        doc: (id) => ref(`${name}/${id}`),
        where: (field, op, value) => { filters.push([field, op, value]); return query; },
        orderBy: () => query, limit: () => query,
        get: async () => {
          const docs = [...rows.entries()].filter(([path, row]) => path.startsWith(`${name}/`) && filters.every(([f, op, v]) => op === 'in' ? v.includes(row[f]) : row[f] === v))
            .map(([path]) => snap(path));
          return { docs, empty: !docs.length, size: docs.length };
        },
      };
      return query;
    },
    runTransaction: async (fn) => {
      for (let retry = 0; retry < 20; retry++) {
        const at = revision;
        const writes = [];
        const result = await fn({
          get: async (doc) => { if (writes.length) throw new Error('read after write'); return snap(doc.path); },
          set: (doc, data) => writes.push([doc.path, structuredClone(data)]),
          update: (doc, patch) => writes.push([doc.path, { ...rows.get(doc.path), ...structuredClone(patch) }]),
        });
        if (at !== revision) continue;
        for (const [path, data] of writes) rows.set(path, data);
        if (writes.length) revision++;
        return result;
      }
      throw new Error('retry limit');
    },
  };
}

module.exports = { database };
