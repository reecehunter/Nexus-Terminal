import { expect, it } from 'vitest';
import { maskUserHostOutput } from './terminal-output';

it('masks user@host tokens while preserving surrounding terminal output', () => {
  expect(maskUserHostOutput('ssh real-user@real-host\n', 'demo@recording')).toBe(
    'ssh demo@recording\n',
  );
});

it('leaves output unchanged when SSH spoofing is disabled', () => {
  expect(maskUserHostOutput('real-user@real-host', null)).toBe('real-user@real-host');
});

it('uses the configured username and hostname prompt colors', () => {
  expect(
    maskUserHostOutput('real-user@real-host', 'demo@recording', {
      user: '#112233',
      host: '#aabbcc',
    }),
  ).toBe('[38;2;17;34;51mdemo[39m@[38;2;170;187;204mrecording[39m');
});
