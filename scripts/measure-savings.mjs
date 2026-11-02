import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareTaskUsage } = require('../out-test/src/savings.js');

try {
  const [baselinePath, memoryPath] = process.argv.slice(2);
  if (!baselinePath || !memoryPath)
    throw new Error('Usage: npm run measure:savings -- baseline.json memory.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const memory = JSON.parse(readFileSync(memoryPath, 'utf8'));
  if (!baseline || !memory || typeof baseline !== 'object' || typeof memory !== 'object')
    throw new Error('Usage records must be objects');
  const comparison = compareTaskUsage(baseline, memory);
  console.log(
    JSON.stringify(
      {
        ...comparison,
        measurement: 'matched-provider-usage',
        includesAuxiliaryWork: true,
        billingSavings: null,
      },
      null,
      2,
    ),
  );
  if (comparison.savingsPercent === null) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cannot compare usage records');
  process.exitCode = 1;
}
