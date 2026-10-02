import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releasePreflight, releaseVersion } from './release-preflight.mjs';
import { releaseTarget } from './package-release.mjs';

test('release preflight fails closed without credentials', async () => {
  await assert.rejects(releasePreflight({}, { ci: true }), /Missing release credentials/);
});
test('ad-hoc signing cannot be used for public releases', async () => {
  await assert.rejects(
    releasePreflight({
      APPLE_SIGNING_IDENTITY: '-',
      APPLE_API_ISSUER: 'fixture',
      APPLE_API_KEY: 'fixture',
      APPLE_API_KEY_PATH: '/fixture',
    }),
    /Developer ID Application/,
  );
});
test('release target rejects unsupported targets and option injection', () => {
  assert.equal(releaseTarget('universal-apple-darwin'), 'universal-apple-darwin');
  assert.throws(() => releaseTarget('--no-bundle'), /Choose/);
  assert.throws(() => releaseTarget('x86_64-pc-windows-msvc'), /Choose/);
});

test('frontend, backend and bundle release versions agree', async () => {
  assert.match(await releaseVersion(), /^\d+\.\d+\.\d+/);
});
