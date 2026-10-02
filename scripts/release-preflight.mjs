import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function releaseVersion() {
  const [application, frontend, backend] = await Promise.all([
    readFile('src-tauri/tauri.conf.json', 'utf8'),
    readFile('package.json', 'utf8'),
    readFile('src-tauri/Cargo.toml', 'utf8'),
  ]);
  const version = JSON.parse(application).version;
  const rustVersion = backend.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (JSON.parse(frontend).version !== version || rustVersion !== version) {
    throw new Error(
      'Release versions must match in package.json, Cargo.toml, and tauri.conf.json.',
    );
  }
  return version;
}

export async function releasePreflight(environment = process.env, { ci = false } = {}) {
  await releaseVersion();
  const required = [
    'APPLE_SIGNING_IDENTITY',
    'APPLE_API_ISSUER',
    'APPLE_API_KEY',
    'APPLE_API_KEY_PATH',
  ];
  if (ci) required.push('APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD');
  const missing = required.filter((name) => !environment[name]?.trim());
  if (missing.length)
    throw new Error(`Missing release credentials: ${missing.join(', ')}. See docs/RELEASING.md.`);
  if (!environment.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application: ')) {
    throw new Error('Public releases require a Developer ID Application signing identity.');
  }
  await access(environment.APPLE_API_KEY_PATH);
  const key = await readFile(environment.APPLE_API_KEY_PATH, 'utf8');
  if (!key.includes('-----BEGIN PRIVATE KEY-----'))
    throw new Error('The notarization key must be a PEM private key.');
  if (!ci) {
    const identities = spawnSync(
      '/usr/bin/security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8' },
    );
    if (
      identities.status !== 0 ||
      !identities.stdout.includes(`"${environment.APPLE_SIGNING_IDENTITY}"`)
    ) {
      throw new Error(
        'Install the configured Developer ID certificate and private key in Keychain before releasing.',
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await releasePreflight(process.env, { ci: process.argv.includes('--ci') });
    process.stdout.write('Release credentials are configured.\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
