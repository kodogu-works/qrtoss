import { LEASE_RENEW_MS } from './capacity.ts';

/** Renew without waiting for the service; the adapter handles failures best effort. */
export function maintainLease(
  renew: () => void,
  timeout: (callback: () => void, ms: number) => () => void,
) {
  let active = true;
  let cancel: () => void;
  function tick() {
    if (!active) return;
    renew();
    if (active) cancel = timeout(tick, LEASE_RENEW_MS);
  }
  cancel = timeout(tick, LEASE_RENEW_MS);
  return () => {
    active = false;
    cancel();
  };
}
