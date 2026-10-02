import { spawnSync } from 'node:child_process';
import { releasePreflight } from './release-preflight.mjs';
import { packageRelease, releaseTarget } from './package-release.mjs';

try {
  if (process.platform !== 'darwin') throw new Error('macOS releases must be built on a Mac.');
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--target'))
    throw new Error('Usage: npm run app:release -- [--target <macOS target>]');
  const target = releaseTarget(args[1] ?? 'universal-apple-darwin');
  await releasePreflight();
  const result = spawnSync(
    'npm',
    ['run', 'tauri', '--', 'build', '--target', target, '--bundles', 'app,dmg'],
    { stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) throw new Error('Signed build or notarization failed.');
  await packageRelease(target);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
