/** Same-origin mount path, shared by the build configuration and browser. */
export function validateBasePath(value: string): string {
  if (
    !value.endsWith('/') ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(value) ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(
      'QRTOSS_BASE_PATH must be / or an absolute path with a trailing / and URL-safe segments',
    );
  }
  return value;
}

export function createAppPaths(basePath: string) {
  const base = validateBasePath(basePath);
  return {
    home: base,
    sender: `${base}send`,
    rooms: `${base}api/v1/rooms`,
    socket: `${base}ws`,
    pairings: `${base}api/v2/pairings`,
    pairingSocket: `${base}api/v2/pairings/socket`,
    networks: `${base}api/v2/networks`,
    networkSocket: `${base}api/v2/networks/socket`,
  } as const;
}

export type AppPaths = ReturnType<typeof createAppPaths>;
