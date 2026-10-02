import { mkdir, readdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseTarget(target) {
  if (!['aarch64-apple-darwin', 'x86_64-apple-darwin', 'universal-apple-darwin'].includes(target)) {
    throw new Error('Choose aarch64-apple-darwin, x86_64-apple-darwin, or universal-apple-darwin.');
  }
  return target;
}

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0)
    throw new Error(`${basename(command)} failed; release packaging stopped.`);
  return result.stdout ?? '';
}

export async function packageRelease(target) {
  releaseTarget(target);
  const bundle = resolve('src-tauri', 'target', target, 'release', 'bundle');
  const application = resolve(bundle, 'macos', 'Nexus.app');
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', application]);
  // codesign reports metadata on stderr; inspect it separately without exposing signing credentials.
  const metadata = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', application], {
    encoding: 'utf8',
  });
  if (
    metadata.status !== 0 ||
    !metadata.stderr.includes('Authority=Developer ID Application:') ||
    !metadata.stderr.includes('runtime')
  ) {
    throw new Error('The app must have a Developer ID signature and hardened runtime.');
  }
  run('/usr/bin/xcrun', ['stapler', 'validate', application]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', application]);
  const binaryArchitectures = run(
    '/usr/bin/lipo',
    ['-archs', resolve(application, 'Contents', 'MacOS', 'nexus')],
    true,
  )
    .trim()
    .split(/\s+/);
  const expected = target.startsWith('universal')
    ? ['arm64', 'x86_64']
    : [target.startsWith('aarch64') ? 'arm64' : 'x86_64'];
  if (expected.some((architecture) => !binaryArchitectures.includes(architecture)))
    throw new Error('The bundled binary is missing a requested architecture.');
  const { version } = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  const label = target.startsWith('universal')
    ? 'universal'
    : target.startsWith('aarch64')
      ? 'apple-silicon'
      : 'intel';
  const output = resolve('release', label);
  await mkdir(output, { recursive: true });
  const images = (await readdir(resolve(bundle, 'dmg'))).filter((file) => file.endsWith('.dmg'));
  if (images.length !== 1)
    throw new Error('Expected exactly one DMG installer. Clean the bundle output and retry.');
  const diskImage = resolve(bundle, 'dmg', images[0]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', diskImage]);
  // Tauri notarizes the app. The outer DMG needs its own ticket for offline installation.
  const credentials = ['APPLE_API_KEY_PATH', 'APPLE_API_KEY', 'APPLE_API_ISSUER'];
  if (credentials.some((name) => !process.env[name]))
    throw new Error('Missing DMG notarization credentials.');
  const submission = JSON.parse(
    run(
      '/usr/bin/xcrun',
      [
        'notarytool',
        'submit',
        diskImage,
        '--key',
        process.env.APPLE_API_KEY_PATH,
        '--key-id',
        process.env.APPLE_API_KEY,
        '--issuer',
        process.env.APPLE_API_ISSUER,
        '--wait',
        '--output-format',
        'json',
      ],
      true,
    ),
  );
  if (submission.status !== 'Accepted')
    throw new Error('Apple did not accept the DMG notarization submission.');
  run('/usr/bin/xcrun', ['stapler', 'staple', diskImage]);
  run('/usr/bin/xcrun', ['stapler', 'validate', diskImage]);
  run('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=2',
    diskImage,
  ]);
  const installer = resolve(output, `Nexus_${version}_${label}.dmg`);
  const archive = resolve(output, `Nexus_${version}_${label}.app.zip`);
  await copyFile(diskImage, installer);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', application, archive]);
  const checksums = await Promise.all(
    [installer, archive].map(
      async (file) =>
        `${createHash('sha256')
          .update(await readFile(file))
          .digest('hex')}  ${basename(file)}`,
    ),
  );
  await writeFile(resolve(output, `SHA256SUMS-${label}.txt`), `${checksums.join('\n')}\n`);
  process.stdout.write(`Verified release assets: ${output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await packageRelease(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
