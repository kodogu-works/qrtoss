import type { Server } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';

/** Delay selected receiver notifications while preserving the real relay's state machine. */
export function socketProxy(
  server: Server,
  target: string,
  origin: string,
  hooks: {
    receiverControl(type: string): void;
    receiverMessage(message: Record<string, any>, forward: () => void): Promise<void>;
  },
) {
  const proxy = new WebSocketServer({ server, perMessageDeflate: false });
  proxy.on('connection', (client) => {
    const upstream = new WebSocket(target.replace('http:', 'ws:') + '/ws', 'qrtoss.v1', { origin });
    let role = '';
    const pending: Array<string> = [];
    let incoming = Promise.resolve();
    const forward = (data: string) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(data) : pending.push(data);
    client.on('message', (raw) => {
      const data = raw.toString(),
        message = JSON.parse(data);
      if (message.type === 'auth') {
        role = message.role;
      }
      if (role === 'receiver') hooks.receiverControl(message.type);
      forward(data);
    });
    upstream.on('open', () => {
      for (const data of pending.splice(0)) upstream.send(data);
    });
    upstream.on('message', (raw) => {
      const data = raw.toString();
      const deliver = () => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      };
      incoming = incoming.then(() =>
        role === 'receiver' ? hooks.receiverMessage(JSON.parse(data), deliver) : deliver(),
      );
    });
    client.on('close', () => upstream.close());
    upstream.on('close', () => {
      void incoming.then(() => client.close());
    });
    client.on('error', () => upstream.terminate());
    upstream.on('error', () => client.terminate());
  });
  return proxy;
}
