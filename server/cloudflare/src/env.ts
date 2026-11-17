import type { RoomDO } from './room.ts';
import type { CapacityDO } from './capacity.ts';
import type { CapacityOptions } from '../../../packages/relay-core/src/capacity.ts';

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>;
  CAPACITY: DurableObjectNamespace<CapacityDO>;
  ASSETS: Fetcher;
  PUBLIC_ORIGIN: string;
  MAX_ROOMS?: string;
  MAX_SOCKETS?: string;
  MAX_UNAUTHENTICATED_SOCKETS?: string;
  MAX_SOCKETS_PER_IP?: string;
  IPV6_PREFIX_LENGTH?: string;
  LOG_LEVEL?: string;
}
export function positive(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('CONFIG_INVALID');
  return Number(value);
}
export function capacityOptions(env: Env): CapacityOptions {
  return {
    maxRooms: positive(env.MAX_ROOMS, 1000),
    maxSockets: positive(env.MAX_SOCKETS, 2200),
    maxUnauthenticatedSockets: positive(env.MAX_UNAUTHENTICATED_SOCKETS, 100),
    maxSocketsPerIp: positive(env.MAX_SOCKETS_PER_IP, 60),
  };
}
export function prefixLength(env: Env) {
  const prefix = positive(env.IPV6_PREFIX_LENGTH, 64);
  if (prefix > 128) throw new Error('CONFIG_INVALID');
  return prefix;
}
export function capacity(env: Env) {
  return env.CAPACITY.get(env.CAPACITY.idFromName('global'));
}
