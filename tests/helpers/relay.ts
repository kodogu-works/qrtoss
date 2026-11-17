import { createRelay, type RelayOptions } from '../../server/src/index.ts';

export async function createTestRelay(options: RelayOptions) {
  if (process.env.QRTOSS_TEST_RELAY === 'cloudflare') {
    const { createCloudflareRelay } = await import('../cloudflare/fixture.ts');
    return createCloudflareRelay(options);
  }
  return createRelay(options);
}
