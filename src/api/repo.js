// The only place the API talks to the database, and only via stored procedures.
// Rows come back snake_case from MSSQL; the rest of the API sees camelCase DTOs.

import sql from '#mssql';

const toDto = (row) => ({
  id: row.request_id,
  status: row.status,
  packageCount: row.package_count,
  message: row.result_message,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export function createRepo(pool) {
  return {
    async insertUserRequest({ userId, idempotencyKey, payloadJson }) {
      const { recordset } = await pool
        .request()
        .input('UserId', sql.NVarChar(128), userId)
        .input('IdempotencyKey', sql.NVarChar(64), idempotencyKey)
        .input('Payload', sql.NVarChar(sql.MAX), payloadJson)
        .execute('dbo.usp_InsertUserRequest');
      const row = recordset[0];
      return { requestId: row.request_id, isNew: row.is_new === 1 };
    },

    // claimed = false means another caller already owns (or finished) this request.
    async processUserRequest(requestId) {
      const { recordset } = await pool
        .request()
        .input('RequestId', sql.UniqueIdentifier, requestId)
        .execute('dbo.usp_ProcessUserRequest');
      const row = recordset[0];
      return row.claimed === 1 ? { claimed: true, request: toDto(row) } : { claimed: false, request: null };
    },

    async getRequestStatus(userId, requestId) {
      const { recordset } = await pool
        .request()
        .input('UserId', sql.NVarChar(128), userId)
        .input('RequestId', sql.UniqueIdentifier, requestId)
        .execute('dbo.usp_GetRequestStatus');
      return recordset[0] ? toDto(recordset[0]) : null;
    },

    async getUserRequests(userId, top = 20) {
      const { recordset } = await pool
        .request()
        .input('UserId', sql.NVarChar(128), userId)
        .input('Top', sql.Int, top)
        .execute('dbo.usp_GetUserRequests');
      return recordset.map(toDto);
    },
  };
}
