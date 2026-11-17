for (const [name, tag] of [
  ['node', '26.13.0-bookworm-slim'],
  ['caddy', '2.11.2-alpine'],
]) {
  const auth = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/${name}:pull`,
  ).then((r) => r.json());
  const r = await fetch(`https://registry-1.docker.io/v2/library/${name}/manifests/${tag}`, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  if (!r.ok) throw new Error(`${name}:${tag}: ${r.status}`);
  console.log(`${name}:${tag}@${r.headers.get('docker-content-digest')}`);
}
