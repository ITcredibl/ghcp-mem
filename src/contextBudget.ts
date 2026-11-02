import { createHash } from 'node:crypto';

export function estimatedContextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function fitContextBlocks(
  prefix: string,
  blocks: readonly string[],
  suffix: string,
  maxTokens: number,
): {
  text: string;
  omitted: number;
} {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Invalid context budget');
  const kept: string[] = [];
  if (estimatedContextTokens(prefix + suffix) > maxTokens)
    return { text: '', omitted: blocks.length };
  for (const block of blocks) {
    if (estimatedContextTokens(prefix + [...kept, block].join('\n\n') + suffix) <= maxTokens)
      kept.push(block);
  }
  return { text: prefix + kept.join('\n\n') + suffix, omitted: blocks.length - kept.length };
}

export function budgetResults<T>(
  items: readonly T[],
  maxTokens = 1200,
): {
  count: number;
  results: T[];
  receipt: { sha256: string; measurement: string; maxTokens: number; omitted: number };
} {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > 32000) {
    throw new Error('maxTokens must be an integer between 128 and 32000');
  }
  const results: T[] = [];
  const envelope = () => ({
    count: results.length,
    results,
    receipt: {
      sha256: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
      measurement: 'utf8-bytes/4-estimate',
      maxTokens,
      omitted: items.length - results.length,
    },
  });
  for (const item of items) {
    results.push(item);
    if (estimatedContextTokens(JSON.stringify(envelope(), null, 2)) > maxTokens) results.pop();
  }
  return envelope();
}
