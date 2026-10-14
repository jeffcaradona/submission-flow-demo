// Tracks open SSE connections per user and fans status events out to them.
//
// A connection is registered BEFORE its snapshot is read from the database.
// Live events that arrive while the snapshot query is in flight are buffered and
// flushed after the snapshot, so a completion can never fall into the gap
// between "read current status" and "start listening".

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createStatusHub() {
  const byUser = new Map();

  return {
    connect(userId, res) {
      const client = { res, ready: false, buffer: [] };
      const set = byUser.get(userId) ?? new Set();
      set.add(client);
      byUser.set(userId, set);

      return {
        // Send the current state, then anything that happened while we were reading it.
        open(snapshot) {
          res.write(snapshot.map((row) => frame('snapshot', row)).join(''));
          for (const buffered of client.buffer) res.write(buffered);
          client.buffer.length = 0;
          client.ready = true;
        },
        close() {
          const clients = byUser.get(userId);
          clients?.delete(client);
          if (clients && clients.size === 0) byUser.delete(userId);
        },
      };
    },

    publish(userId, data) {
      const payload = frame('status', data);
      for (const client of byUser.get(userId) ?? []) {
        if (client.ready) client.res.write(payload);
        else client.buffer.push(payload);
      }
    },

    clientCount(userId) {
      return byUser.get(userId)?.size ?? 0;
    },
  };
}
