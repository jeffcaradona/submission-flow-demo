// In-memory "tables". The unique index throws the same error number SQL Server
// does (2627), so the insert sproc can use the real try-insert / catch-duplicate
// idempotency pattern instead of a racy check-then-insert.

import { RequestError } from './errors.js';

export class Table {
  #name;
  #pk;
  #rows = new Map();
  #uniques;

  constructor(name, { primaryKey, uniques = {} }) {
    this.#name = name;
    this.#pk = primaryKey;
    this.#uniques = Object.entries(uniques).map(([indexName, columns]) => ({
      indexName,
      columns,
      keys: new Map(),
    }));
  }

  #keyOf(row, columns) {
    return JSON.stringify(columns.map((c) => row[c]));
  }

  insert(row) {
    for (const u of this.#uniques) {
      if (u.keys.has(this.#keyOf(row, u.columns))) {
        const dup = u.columns.map((c) => row[c]).join(', ');
        throw new RequestError(
          `Violation of UNIQUE KEY constraint '${u.indexName}'. Cannot insert duplicate key in object 'dbo.${this.#name}'. The duplicate key value is (${dup}).`,
          { number: 2627 },
        );
      }
    }
    for (const u of this.#uniques) u.keys.set(this.#keyOf(row, u.columns), row[this.#pk]);
    this.#rows.set(row[this.#pk], { ...row });
    return { ...row };
  }

  get(pk) {
    const row = this.#rows.get(pk);
    return row && { ...row };
  }

  findByUnique(indexName, values) {
    const index = this.#uniques.find((u) => u.indexName === indexName);
    const pk = index?.keys.get(JSON.stringify(values));
    return pk === undefined ? undefined : this.get(pk);
  }

  update(pk, patch) {
    const current = this.#rows.get(pk);
    if (!current) return undefined;
    Object.assign(current, patch);
    return { ...current };
  }

  // Insertion order, oldest first.
  all() {
    return [...this.#rows.values()].map((r) => ({ ...r }));
  }
}

export function createStore() {
  return {
    userRequest: new Table('user_request', {
      primaryKey: 'request_id',
      uniques: { UQ_user_request_user_key: ['user_id', 'idempotency_key'] },
    }),
  };
}
