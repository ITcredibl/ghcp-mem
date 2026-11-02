import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { budgetResults, estimatedContextTokens, fitContextBlocks } from '../contextBudget';

test('context budget includes envelope and never splits a record', () => {
  const result = budgetResults(
    [
      { id: 'large', text: 'x'.repeat(5000) },
      { id: 'small', text: 'useful' },
    ],
    200,
  );
  assert.deepEqual(
    result.results.map((item) => item.id),
    ['small'],
  );
  assert.equal(result.receipt.omitted, 1);
  assert.ok(estimatedContextTokens(JSON.stringify(result, null, 2)) <= 200);
  assert.equal(
    result.receipt.sha256,
    createHash('sha256').update(JSON.stringify(result.results)).digest('hex'),
  );
});

test('text budgets reserve prefix and closing trust boundary', () => {
  const result = fitContextBlocks('begin\n', ['x'.repeat(1000), 'small'], '\nend', 10);
  assert.equal(result.text, 'begin\nsmall\nend');
  assert.equal(result.omitted, 1);
  assert.equal(fitContextBlocks('x'.repeat(100), [], 'end', 1).text, '');
  assert.throws(() => budgetResults([], NaN));
  assert.throws(() => budgetResults([], 1));
  assert.equal(estimatedContextTokens(''), 0);
});
