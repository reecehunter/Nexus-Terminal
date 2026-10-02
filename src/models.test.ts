import { expect, it } from 'vitest';
import { recentModels } from './models';

const models = (ids: string[]) => ids.map((id) => ({ id, ownedBy: 'openai' }));

it('limits recent aliases, orders numeric versions and preserves a selected snapshot', () => {
  const result = recentModels(
    models([
      'gpt-5.9',
      'gpt-5.10',
      'gpt-5.8',
      'gpt-5.7',
      'gpt-5.6',
      'gpt-5.5',
      'gpt-5.10-2026-10-01',
      'gpt-audio',
    ]),
    'gpt-5.10-2026-10-01',
  );
  expect(result.map((model) => model.id)).toEqual([
    'gpt-5.10',
    'gpt-5.9',
    'gpt-5.8',
    'gpt-5.7',
    'gpt-5.6',
    'gpt-5.10-2026-10-01',
  ]);
});

it('does not invent unavailable models or duplicate the selected alias', () => {
  expect(recentModels([], 'unavailable')).toEqual([]);
  expect(recentModels(models(['gpt-5.4-mini']), 'gpt-5.4-mini')).toHaveLength(1);
  expect(recentModels(models(['custom-model']), 'custom-model')[0].id).toBe('custom-model');
});
