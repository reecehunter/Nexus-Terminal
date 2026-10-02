import type { ModelOption } from './types';

export function modelLabel(modelId: string): string {
  return modelId
    .replace(/^gpt-/i, 'GPT-')
    .replace(
      /-(sol|terra|luna)$/i,
      (_, family: string) => ` ${family[0].toUpperCase()}${family.slice(1)}`,
    );
}

export function uniqueModels(models: ModelOption[]): ModelOption[] {
  return models.filter(
    (model, index, all) => all.findIndex((candidate) => candidate.id === model.id) === index,
  );
}

export function recentModels(models: ModelOption[], selected: string): ModelOption[] {
  // Prefer versioned text aliases; snapshots and specialist models remain in More options.
  const aliases = models.filter((model) =>
    /^gpt-\d+(?:\.\d+)?(?:-(?:mini|nano|sol|terra|luna))?$/.test(model.id),
  );
  aliases.sort((left, right) => {
    const leftVersion = left.id
      .match(/\d+(?:\.\d+)?/)![0]
      .split('.')
      .map(Number);
    const rightVersion = right.id
      .match(/\d+(?:\.\d+)?/)![0]
      .split('.')
      .map(Number);
    return (
      rightVersion[0] - leftVersion[0] ||
      (rightVersion[1] ?? 0) - (leftVersion[1] ?? 0) ||
      Number(/-(mini|nano)$/.test(left.id)) - Number(/-(mini|nano)$/.test(right.id)) ||
      left.id.localeCompare(right.id)
    );
  });
  const recent = aliases.slice(0, 5);
  const current = models.find((model) => model.id === selected);
  return uniqueModels(current ? [...recent, current] : recent);
}
