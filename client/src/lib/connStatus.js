import { useEffect, useState } from 'react';

// Health of each saved connection, learned passively from API responses and
// "down" alerts (no extra polling of the servers). connId -> { down, message }.

// Error codes that mean "can't reach / talk to the server", not a SQL error.
const CONN_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_ACCESS_DENIED_ERROR', 'ER_CON_COUNT_ERROR',
  'ER_HOST_IS_BLOCKED', 'ER_HOST_NOT_PRIVILEGED', 'ER_SERVER_SHUTDOWN', 'ER_TOO_MANY_USER_CONNECTIONS', 'SSH_FAILED',
]);
export const isConnError = (code) => !!code && CONN_CODES.has(code);

let status = {};
const listeners = new Set();

export function setConnStatus(id, down, message = '') {
  if (!id) return;
  const cur = status[id];
  if (!down && !cur?.down) return;
  if (down && cur?.down && cur.message === message) return;
  status = { ...status, [id]: { down, message } };
  for (const l of listeners) l(status);
}

export function useConnStatus() {
  const [s, setS] = useState(status);
  useEffect(() => {
    listeners.add(setS);
    setS(status);
    return () => listeners.delete(setS);
  }, []);
  return s;
}
