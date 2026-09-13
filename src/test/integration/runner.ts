/**
 * Entry point loaded by @vscode/test-electron inside the Extension
 * Development Host (`extensionTestsPath`). Which suite runs is selected by
 * the GHCP_MEM_ITEST_PHASE env var set in scripts/run-integration-tests.mjs.
 *
 * Deliberately framework-free: the repo's unit suite uses node:test against
 * mocks, and pulling mocha in just for a handful of host tests would add a
 * dependency for no expressive gain.
 */
import { registerPlainSuite } from './plainSuite';
import { registerEncryptedSuite } from './encryptedSuite';

type TestFn = () => Promise<void>;

export class Harness {
  readonly tests: Array<{ name: string; fn: TestFn }> = [];

  test(name: string, fn: TestFn): void {
    this.tests.push({ name, fn });
  }
}

export async function run(): Promise<void> {
  const phase = process.env.GHCP_MEM_ITEST_PHASE ?? 'plain';
  const harness = new Harness();
  switch (phase) {
    case 'plain':
      registerPlainSuite(harness);
      break;
    case 'encrypted':
      registerEncryptedSuite(harness);
      break;
    default:
      throw new Error(`unknown GHCP_MEM_ITEST_PHASE: ${phase}`);
  }

  console.log(`[itest] phase "${phase}" — ${harness.tests.length} test(s)`);
  const failures: string[] = [];
  for (const { name, fn } of harness.tests) {
    const startedAt = Date.now();
    try {
      await fn();
      console.log(`[itest]   PASS ${name} (${Date.now() - startedAt}ms)`);
    } catch (err) {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`[itest]   FAIL ${name}\n${detail}`);
      failures.push(name);
    }
  }
  if (failures.length > 0) {
    throw new Error(`[itest] phase "${phase}": ${failures.length} failed — ${failures.join(', ')}`);
  }
  console.log(`[itest] phase "${phase}" — all tests passed`);
}
