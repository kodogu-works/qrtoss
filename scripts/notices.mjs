import { readFile, readdir, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
let out =
  '# Third-party notices\n\nqrtoss itself is MIT licensed; see LICENSE.md. The following components retain their original licenses.\n\n';
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path || pkg.dev) continue;
  const files = await readdir(path);
  const licenses = files.filter((n) => /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(n));
  out += `## ${path.replace('node_modules/', '')} ${pkg.version}\n\nLicense: ${pkg.license ?? 'See upstream license'}\n\n`;
  if (!licenses.length) throw new Error('Missing license text: ' + path);
  for (const file of licenses) {
    out += `### ${file}\n\n${await readFile(path + '/' + file, 'utf8')}\n\n`;
  }
}
// qr-scanner's bundled decoder derives from jsQR.
out +=
  '## jsQR (decoder bundled in qr-scanner)\n\n' +
  (await readFile('node_modules/jsqr/LICENSE', 'utf8')) +
  '\n';
const go = [
  ['github.com/coder/websocket', 'v1.8.15'],
  ['github.com/boombuler/barcode', 'v1.1.0'],
  ['golang.org/x/term', 'v0.32.0'],
  ['golang.org/x/sys', 'v0.33.0'],
];
const cache = process.env.GOMODCACHE;
if (cache) {
  for (const [name, version] of go) {
    const dir = `${cache}/${name}@${version}`;
    const files = (await readdir(dir)).filter((n) => /^(LICENSE|PATENTS)(\.|$)/.test(n));
    if (!files.length) throw new Error('Missing module license: ' + dir);
    out += `\n## ${name} ${version}\n\n`;
    for (const file of files) out += `### ${file}\n\n${await readFile(dir + '/' + file, 'utf8')}\n`;
  }
} else throw new Error('Set GOMODCACHE to the downloaded Go module cache to include CLI notices');
if (!process.env.GOROOT) throw new Error('Set GOROOT to include the Go standard library license');
out += '\n## Go standard library\n\n';
for (const file of ['LICENSE', 'PATENTS'])
  out += `### ${file}\n\n${await readFile(process.env.GOROOT + '/' + file, 'utf8')}\n`;
await writeFile('THIRD_PARTY_NOTICES', out);
