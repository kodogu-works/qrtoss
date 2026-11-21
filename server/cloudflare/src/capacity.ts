import { DurableObject } from 'cloudflare:workers';
import { CapacityState, type SocketLease } from '../../../packages/relay-core/src/capacity.ts';
import { capacityOptions, type Env } from './env.ts';

export class CapacityDO extends DurableObject<Env> {
  protected readonly state: CapacityState;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state = new CapacityState(capacityOptions(env), () => this.now());
  }
  protected now() {
    return Date.now();
  }
  acquireRoom(id: string, ip: string) {
    return this.state.acquireRoom(id, ip);
  }
  renewRoom(id: string) {
    this.state.renewRoom(id);
  }
  releaseRoom(id: string) {
    this.state.releaseRoom(id);
  }
  acquireNetwork(id: string, ip: string) {
    return this.state.acquireNetwork(id, ip);
  }
  renewNetwork(id: string) {
    this.state.renewNetwork(id);
  }
  releaseNetwork(id: string) {
    this.state.releaseNetwork(id);
  }
  acquireSocket(id: string, ip: string) {
    return this.state.acquireSocket(id, ip);
  }
  renewSocket(id: string, lease: SocketLease) {
    this.state.renewSocket(id, lease);
  }
  authenticateSocket(id: string) {
    this.state.authenticateSocket(id);
  }
  releaseSocket(id: string) {
    this.state.releaseSocket(id);
  }
  canAuthenticate(ip: string) {
    return this.state.canAuthenticate(ip);
  }
  authenticationFailed(ip: string) {
    this.state.authenticationFailed(ip);
  }
}
