import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [directory, version, requestedBase = ''] = process.argv.slice(2);
if (!directory || !/^[0-9A-Za-z.-]+$/.test(version))
  throw new Error('Usage: release-launcher.mjs OUTPUT VERSION [HTTPS_BASE_URL]');
const platforms = ['darwin_arm64', 'darwin_amd64', 'linux_arm64', 'linux_amd64'];
const hashes = {};
for (const platform of platforms) {
  const name = `qrtoss_${version}_${platform}`;
  hashes[platform] = createHash('sha256')
    .update(await readFile(resolve(directory, name)))
    .digest('hex');
}
await writeFile(
  resolve(directory, 'SHA256SUMS'),
  platforms.map((p) => `${hashes[p]}  qrtoss_${version}_${p}`).join('\n') + '\n',
);
if (!requestedBase) {
  process.stderr.write(
    'Set QRTOSS_DOWNLOAD_BASE_URL to generate the versioned HTTPS launcher and Homebrew formula.\n',
  );
} else {
  const url = new URL(requestedBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Download base must be an HTTPS URL without credentials, query or fragment');
  const base = url.href.replace(/\/$/, '');
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  let launcher = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'run.sh.in'),
    'utf8',
  );
  launcher = launcher
    .replaceAll('__VERSION__', quote(version))
    .replaceAll('__BASE_URL__', quote(base));
  for (const platform of platforms)
    launcher = launcher.replaceAll(`__${platform.toUpperCase()}_SHA256__`, quote(hashes[platform]));
  await writeFile(resolve(directory, 'run.sh'), launcher, { mode: 0o755 });
  const formula = `class Qrtoss < Formula\n  desc "Transfer QR text to a browser or terminal"\n  homepage "https://github.com/wistaria/qrtoss"\n  version ${JSON.stringify(version)}\n  license "MIT"\n${[
    'macos',
    'linux',
  ]
    .map(
      (os) =>
        `  on_${os} do\n${['arm', 'intel']
          .map((arch) => {
            const platform = `${os === 'macos' ? 'darwin' : 'linux'}_${arch === 'arm' ? 'arm64' : 'amd64'}`;
            return `    on_${arch} do\n      url ${JSON.stringify(`${base}/qrtoss_${version}_${platform}`)}\n      sha256 "${hashes[platform]}"\n    end`;
          })
          .join('\n')}\n  end`,
    )
    .join(
      '\n',
    )}\n  def install\n    bin.install Dir["qrtoss_*"][0] => "qrtoss"\n  end\n  test do\n    assert_match "qrtoss/1", shell_output("#{bin}/qrtoss --version")\n  end\nend\n`;
  await writeFile(resolve(directory, 'qrtoss.rb'), formula);
}
