// A small in-memory stand-in for the parts of node-mssql this app uses:
//
//   const pool = new sql.ConnectionPool(config); await pool.connect();
//   const { recordset, output, returnValue } = await pool.request()
//     .input('Name', sql.NVarChar(128), value)
//     .execute('dbo.usp_Something');
//
// Everything goes through stored procedures, matching how the real app talks to
// MSSQL. To swap in the real driver, change the "#mssql" entry in package.json
// "imports" to "mssql" (and drop the `mock` key from the pool config).

import { ConnectionError, RequestError } from './errors.js';
import { createStore } from './store.js';
import { procs } from './procs.js';

export { ConnectionError, RequestError };

export const MAX = 65535;

const makeType = (typeName) => {
  const type = (length) => ({ typeName, length });
  type.typeName = typeName;
  return type;
};
export const NVarChar = makeType('NVarChar');
export const VarChar = makeType('VarChar');
export const Int = makeType('Int');
export const UniqueIdentifier = makeType('UniqueIdentifier');
export const DateTime2 = makeType('DateTime2');

// Shared by every pool that does not inject config.mock.store (tests do).
let defaultStore = createStore();
export function resetMockDatabase() {
  defaultStore = createStore();
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const bareName = (name) => name.replace(/[[\]]/g, '').replace(/^dbo\./i, '');

export class Request {
  #pool;
  #params = new Map();
  #outputs = new Map();

  constructor(pool) {
    this.#pool = pool;
  }

  // input(name, value) or input(name, type, value), like node-mssql.
  input(name, typeOrValue, maybeValue) {
    this.#params.set(name, arguments.length >= 3 ? maybeValue : typeOrValue);
    return this;
  }

  output(name, _type, value = null) {
    this.#outputs.set(name, value);
    return this;
  }

  execute(procName) {
    return this.#pool._exec(procName, Object.fromEntries(this.#params), this.#outputs);
  }
}

export class ConnectionPool {
  constructor(config = {}) {
    this.config = config;
    this.connected = false;
    this._store = undefined;
  }

  async connect() {
    await tick();
    this._store = this.config.mock?.store ?? defaultStore;
    this.connected = true;
    return this;
  }

  request() {
    return new Request(this);
  }

  async close() {
    await tick();
    this.connected = false;
  }

  // Internal: called by Request.execute().
  async _exec(rawName, params, outputs) {
    if (!this.connected) throw new ConnectionError('Connection is closed.');
    const procName = bareName(rawName);
    const proc = procs[procName];
    if (!proc) {
      throw new RequestError(`Could not find stored procedure '${rawName}'.`, {
        number: 2812,
        procName: rawName,
      });
    }
    await tick();
    let res;
    try {
      res = await proc({ store: this._store, options: this.config.mock ?? {} }, params);
    } catch (err) {
      if (err instanceof RequestError) err.procName ??= procName;
      throw err;
    }
    const recordsets = res.recordsets ?? [];
    return {
      recordsets,
      recordset: recordsets[0],
      output: { ...Object.fromEntries(outputs), ...res.output },
      rowsAffected: res.rowsAffected ?? [],
      returnValue: res.returnValue ?? 0,
    };
  }
}

let globalPool;
export async function connect(config) {
  globalPool = new ConnectionPool(config);
  return globalPool.connect();
}
export async function close() {
  await globalPool?.close();
  globalPool = undefined;
}

export default {
  ConnectionPool,
  Request,
  ConnectionError,
  RequestError,
  connect,
  close,
  MAX,
  NVarChar,
  VarChar,
  Int,
  UniqueIdentifier,
  DateTime2,
};
