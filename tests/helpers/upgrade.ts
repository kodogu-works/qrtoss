import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { randomBytes } from 'node:crypto';

/** Raw HTTP avoids WebSocket clients rejecting malformed offers before sending. */
export function websocketUpgrade(
  url: string,
  origin: string,
  protocols?: string | string[],
  path?: string,
) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        url,
        {
          ...(path === undefined ? {} : { path }),
          headers: {
            Host: new URL(origin).host,
            Origin: origin,
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            ...(protocols === undefined ? {} : { 'Sec-WebSocket-Protocol': protocols }),
          },
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (body += chunk));
          response.on('error', reject);
          response.on('end', () =>
            resolve({ status: response.statusCode!, headers: response.headers, body }),
          );
        },
      );
      request.on('upgrade', (response, socket) => {
        socket.destroy();
        resolve({ status: response.statusCode!, headers: response.headers, body: '' });
      });
      request.on('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('UPGRADE_TIMEOUT')));
      request.end();
    },
  );
}
