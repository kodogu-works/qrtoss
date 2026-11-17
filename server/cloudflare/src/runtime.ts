export const RPC_TIMEOUT_MS = 2000;
export function random(bytes: number) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
export async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export async function equal(a: Uint8Array, b: Uint8Array) {
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}
export async function withDeadline<T>(operation: Promise<T>, ms = RPC_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SERVICE_UNAVAILABLE')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export function bestEffort(operation: Promise<unknown>) {
  return withDeadline(operation).then(
    () => {},
    () => {},
  );
}

/** Reserved and abnormal close codes must never be put on the wire. */
export function closeSocket(socket: WebSocket | undefined, code = 1011, reason = '') {
  if (!socket || socket.readyState >= 2) return;
  const valid =
    [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ||
    (code >= 3000 && code <= 4999);
  try {
    socket.close(valid ? code : 1011, reason);
  } catch {
    /* A concurrently closed socket needs no retry. */
  }
}
