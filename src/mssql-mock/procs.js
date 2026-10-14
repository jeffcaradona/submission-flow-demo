// The "stored procedures". Each one takes ({ store, options }, params) where
// params use the same names the caller passed to request.input() (no leading @)
// and returns { recordsets, returnValue?, output? }.
//
// Rows come back snake_case, like columns would from a real result set.

import { randomUUID } from 'node:crypto';
import { RequestError } from './errors.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = (rows) => ({ recordsets: [rows], returnValue: 0 });

function need(params, names, procName) {
  for (const name of names) {
    if (params[name] === undefined) {
      throw new RequestError(
        `Procedure or function '${procName}' expects parameter '@${name}', which was not supplied.`,
        { number: 201, procName },
      );
    }
  }
}

const statusRow = (r) => ({
  request_id: r.request_id,
  status: r.status,
  package_count: r.package_count,
  result_message: r.result_message,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export const procs = {
  // Write the one-line JSON body and get out. Duplicate (user, key) -> existing id, is_new = 0.
  async usp_InsertUserRequest({ store }, params) {
    need(params, ['UserId', 'IdempotencyKey', 'Payload'], 'usp_InsertUserRequest');
    const { UserId, IdempotencyKey, Payload } = params;
    const now = new Date();
    const row = {
      request_id: randomUUID(),
      user_id: UserId,
      idempotency_key: IdempotencyKey,
      payload: Payload,
      status: 'Accepted',
      package_count: null,
      result_message: null,
      created_at: now,
      updated_at: now,
    };
    try {
      store.userRequest.insert(row);
      return result([{ request_id: row.request_id, is_new: 1 }]);
    } catch (err) {
      if (err.number !== 2627) throw err;
      const existing = store.userRequest.findByUnique('UQ_user_request_user_key', [UserId, IdempotencyKey]);
      return result([{ request_id: existing.request_id, is_new: 0 }]);
    }
  },

  // Claim (Accepted -> Processing), do the work, finish (Completed | Failed).
  // Only the caller that wins the claim returns claimed = 1.
  async usp_ProcessUserRequest({ store, options }, params) {
    need(params, ['RequestId'], 'usp_ProcessUserRequest');
    const { RequestId } = params;

    const row = store.userRequest.get(RequestId);
    if (!row || row.status !== 'Accepted') {
      return result([{ request_id: RequestId, claimed: 0, status: row?.status ?? null }]);
    }
    // Committed before the work starts, so other sessions can see 'Processing'.
    store.userRequest.update(RequestId, { status: 'Processing', updated_at: new Date() });

    await wait(options.processMs ?? 0);

    let patch;
    try {
      const packages = JSON.parse(row.payload).packages;
      if (!Array.isArray(packages) || packages.length === 0) throw new Error('No packages in request');
      // Mock-only failure switch so the Failed path can be demonstrated.
      if (packages.includes('POISON')) throw new Error("Package 'POISON' was rejected");
      patch = {
        status: 'Completed',
        package_count: packages.length,
        result_message: `Processed ${packages.length} package(s)`,
      };
    } catch (err) {
      patch = { status: 'Failed', result_message: err.message };
    }
    const done = store.userRequest.update(RequestId, { ...patch, updated_at: new Date() });
    return result([{ ...statusRow(done), claimed: 1 }]);
  },

  async usp_GetRequestStatus({ store }, params) {
    need(params, ['UserId', 'RequestId'], 'usp_GetRequestStatus');
    const row = store.userRequest.get(params.RequestId);
    return result(row && row.user_id === params.UserId ? [statusRow(row)] : []);
  },

  // Newest first.
  async usp_GetUserRequests({ store }, params) {
    need(params, ['UserId'], 'usp_GetUserRequests');
    const top = Number(params.Top ?? 20);
    const rows = store.userRequest
      .all()
      .filter((r) => r.user_id === params.UserId)
      .reverse()
      .slice(0, top)
      .map(statusRow);
    return result(rows);
  },
};
