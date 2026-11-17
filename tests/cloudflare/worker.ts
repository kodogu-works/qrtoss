// Test-only entry point. None of these control routes or RPCs is in the deployed bundle.
import {
  createWorker,
  RoomDO as BaseRoomDO,
  CapacityDO as BaseCapacityDO,
} from '../../server/cloudflare/src/index.ts';
import type { Env } from '../../server/cloudflare/src/env.ts';
import type { BridgeClock } from '../../server/cloudflare/src/bridge.ts';
interface TestEnv extends Env {
  TEST_NOW: string;
  TEST_WALL: string;
}
export class RoomDO extends BaseRoomDO {
  private upgrades = 0;
  private virtualNow?: number;
  private virtualWall?: number;
  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    this.virtualNow = env.TEST_NOW === 'real' ? undefined : Number(env.TEST_NOW);
    this.virtualWall = env.TEST_WALL === 'real' ? undefined : Number(env.TEST_WALL);
  }
  protected now() {
    return this.virtualNow ?? Date.now();
  }
  protected wallNow() {
    return this.virtualWall ?? Date.now();
  }
  setClock(now?: number, wall?: number) {
    this.virtualNow = now;
    this.virtualWall = wall;
  }
  sweep() {
    this.core.sweep();
  }
  protected leaseTimeout(callback: () => void, ms: number) {
    const deadline = this.now() + ms;
    const timer = setInterval(() => {
      if (this.now() >= deadline) {
        clearInterval(timer);
        callback();
      }
    }, 10);
    return () => clearInterval(timer);
  }
  fetch(request: Request) {
    this.upgrades++;
    return super.fetch(request);
  }
  stats() {
    return { ...this.core.stats(), upgrades: this.upgrades };
  }
  restart() {
    this.ctx.abort('TEST_ROOM_RESTART');
  }
  shutdown() {
    this.core.shutdown();
  }
}
export class CapacityDO extends BaseCapacityDO {
  private virtualNow?: number;
  constructor(ctx: DurableObjectState, env: TestEnv) {
    super(ctx, env);
    this.virtualNow = env.TEST_NOW === 'real' ? undefined : Number(env.TEST_NOW);
  }
  protected now() {
    return this.virtualNow ?? Date.now();
  }
  setClock(now?: number) {
    this.virtualNow = now;
  }
  stats() {
    return this.state.stats();
  }
  restart() {
    this.ctx.abort('TEST_CAPACITY_RESTART');
  }
}
let time: number | undefined;
let wall: number | undefined;
let capacityMode = 'normal';
const clock: BridgeClock = {
  now: () => time ?? Date.now(),
  timeout(callback, ms) {
    // Poll the virtual clock inside the socket's own request context. Workers
    // forbid sending on its I/O objects from the test control request.
    const deadline = clock.now() + ms;
    const timer = setInterval(() => {
      if (clock.now() >= deadline) {
        clearInterval(timer);
        callback();
      }
    }, 10);
    return () => clearInterval(timer);
  },
};
const worker = createWorker(clock);
const rooms = new Set<string>();
export default {
  async fetch(request: Request, env: TestEnv, ctx: ExecutionContext) {
    if (new URL(request.url).hostname === 'test.internal') {
      const command = await request.json<{ now?: number; wall?: number; action?: string }>();
      time = command.now;
      wall = command.wall;
      if (command.action?.startsWith('capacity-'))
        capacityMode = command.action.slice('capacity-'.length);
      let cap = env.CAPACITY.get(
        env.CAPACITY.idFromName('global'),
      ) as unknown as DurableObjectStub<CapacityDO>;
      await cap.setClock(time);
      if (command.action === 'restart-capacity') {
        try {
          await cap.restart();
        } catch {
          /* Deliberately discarded volatile state. */
        }
        cap = env.CAPACITY.get(
          env.CAPACITY.idFromName('global'),
        ) as unknown as DurableObjectStub<CapacityDO>;
      }
      const stats = { rooms: 0, sockets: 0, upgrades: 0 };
      for (const id of rooms) {
        let room = env.ROOM.get(env.ROOM.idFromName(id)) as unknown as DurableObjectStub<RoomDO>;
        await room.setClock(time, command.wall);
        if (command.action === 'restart-rooms') {
          try {
            await room.restart();
          } catch {
            /* Deliberately discard volatile room state. */
          }
          room = env.ROOM.get(env.ROOM.idFromName(id)) as unknown as DurableObjectStub<RoomDO>;
        }
        if (command.action === 'sweep') await room.sweep();
        if (command.action === 'shutdown') await room.shutdown();
        const current = await room.stats();
        stats.rooms += current.rooms;
        stats.sockets += current.sockets;
        stats.upgrades += current.upgrades;
      }
      return Response.json({ ...stats, capacity: await cap.stats() });
    }
    if (env.TEST_NOW !== 'real' && time === undefined) time = Number(env.TEST_NOW);
    const testEnv = {
      ...env,
      CAPACITY:
        capacityMode === 'normal'
          ? env.CAPACITY
          : {
              idFromName: (name: string) => env.CAPACITY.idFromName(name),
              get: () =>
                new Proxy(
                  {},
                  {
                    get: () => () =>
                      capacityMode === 'unavailable'
                        ? Promise.reject(new Error('TEST_CAPACITY_UNAVAILABLE'))
                        : new Promise(() => {}),
                  },
                ),
            },
      ROOM: {
        idFromName: (name: string) => env.ROOM.idFromName(name),
        get: (id: DurableObjectId) => {
          const stub = env.ROOM.get(id) as unknown as DurableObjectStub<RoomDO>;
          return {
            async create(room: string, receiver: Uint8Array, sender: Uint8Array) {
              await stub.setClock(time, wall);
              return stub.create(room, receiver, sender);
            },
            fetch: (input: RequestInfo, init?: RequestInit) => stub.fetch(input, init),
          };
        },
      },
    } as unknown as TestEnv;
    const response = await worker.fetch(request, testEnv, ctx);
    if (response.status === 201 && new URL(request.url).pathname === '/api/v1/rooms') {
      const result = await response.clone().json<{ room: string }>();
      rooms.add(result.room);
    }
    return response;
  },
} satisfies ExportedHandler<TestEnv>;
