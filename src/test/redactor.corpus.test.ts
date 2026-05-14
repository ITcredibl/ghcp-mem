import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, looksSensitive } from '../redactor';

const OPTS = { redactSecrets: true, honorPrivateTags: true };

/**
 * Corpus-style regression test: a single realistic blob with 20+ secrets of
 * different shapes. We assert each category gets flagged AND that no raw
 * secret literal survives in the redacted output. This is the kind of test
 * that catches regressions where someone tweaks one regex and unknowingly
 * weakens another.
 *
 * Test values below are synthetic — no real credentials.
 */

interface Fixture {
  /** Human-readable label for failure messages. */
  label: string;
  /** Input snippet containing a single secret. */
  input: string;
  /** Substring that must NOT appear in the redacted output. */
  forbidden: string;
  /** Category we expect to fire (from RedactionResult.categories). */
  expectedCategory: string;
}

const FIXTURES: Fixture[] = [
  {
    label: 'AWS access key',
    input: 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    forbidden: 'AKIAIOSFODNN7EXAMPLE',
    expectedCategory: 'aws-access-key',
  },
  {
    label: 'GitHub classic PAT',
    input: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    forbidden: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    expectedCategory: 'github-token',
  },
  {
    label: 'GitHub fine-grained PAT',
    input: 'token: github_pat_' + 'A'.repeat(82),
    forbidden: 'github_pat_' + 'A'.repeat(82),
    expectedCategory: 'github-pat-fine',
  },
  {
    label: 'npm token',
    input: 'npmrc: //registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789',
    forbidden: 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    expectedCategory: 'npm-token',
  },
  {
    label: 'Anthropic API key',
    input: 'ANTHROPIC_API_KEY=sk-ant-' + 'A'.repeat(30),
    forbidden: 'sk-ant-' + 'A'.repeat(30),
    expectedCategory: 'anthropic-key',
  },
  {
    label: 'OpenAI API key',
    input: 'OPENAI_API_KEY=sk-' + 'B'.repeat(40),
    forbidden: 'sk-' + 'B'.repeat(40),
    expectedCategory: 'openai-key',
  },
  {
    label: 'Stripe live key',
    input: 'STRIPE_KEY=sk_live_' + 'c'.repeat(30),
    forbidden: 'sk_live_' + 'c'.repeat(30),
    expectedCategory: 'stripe-key',
  },
  {
    label: 'Google API key',
    // Google rule wants AIza + exactly 35 chars (39 total). Bare value so
    // the password-assign rule doesn't claim the same span.
    input: 'key value AIzaSyA' + 'B'.repeat(32),
    forbidden: 'AIzaSyA' + 'B'.repeat(32),
    expectedCategory: 'google-api',
  },
  {
    label: 'Slack bot token',
    input: 'SLACK_TOKEN=xoxb-12345-67890-abcdefghij',
    forbidden: 'xoxb-12345-67890-abcdefghij',
    expectedCategory: 'slack-token',
  },
  {
    label: 'JWT',
    input: 'Authorization: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    forbidden: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    expectedCategory: 'jwt',
  },
  {
    label: 'Bearer token header',
    input: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789=="',
    forbidden: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789==',
    expectedCategory: 'bearer-token',
  },
  {
    label: 'Postgres URL with password',
    input: 'DATABASE_URL=postgres://app:hunter2sekret@db.example.com:5432/prod',
    forbidden: ':hunter2sekret@',
    expectedCategory: 'db-url-password',
  },
  {
    label: 'MongoDB SRV URL with password',
    input: 'MONGO=mongodb+srv://admin:s0meS3cret@cluster.mongodb.net/app',
    forbidden: ':s0meS3cret@',
    expectedCategory: 'db-url-password',
  },
  {
    label: 'PEM private key',
    input: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIB\n-----END PRIVATE KEY-----',
    forbidden: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIB',
    expectedCategory: 'private-key-block',
  },
  {
    label: 'Azure storage conn string',
    input: 'AZ_CONN=DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHE=;EndpointSuffix=core.windows.net',
    forbidden: 'AccountKey=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHE=',
    expectedCategory: 'azure-storage-conn',
  },
  {
    label: 'Azure Service Bus conn string',
    input: 'SB=Endpoint=sb://mybus.servicebus.windows.net/;SharedAccessKeyName=RootKey;SharedAccessKey=abcDEFghiJKLmnoPQRstuVWXyz1234567890abcd=',
    forbidden: 'SharedAccessKey=abcDEFghiJKLmnoPQRstuVWXyz1234567890abcd=',
    expectedCategory: 'azure-sb-conn',
  },
  {
    label: 'Azure Cosmos conn string',
    input: 'COSMOS=AccountEndpoint=https://x.documents.azure.com:443/;AccountKey=Zm9vYmFyYmF6cXV4Y29ycXVldWZmbHU=',
    forbidden: 'AccountKey=Zm9vYmFyYmF6cXV4Y29ycXVldWZmbHU=',
    expectedCategory: 'azure-cosmos-conn',
  },
  {
    label: 'Azure SQL conn string',
    input: 'SQL=Server=tcp:srv.database.windows.net,1433;User ID=adm;Password=P@ssw0rd!23;Database=db',
    forbidden: 'Password=P@ssw0rd!23',
    expectedCategory: 'azure-sql-conn',
  },
  {
    label: 'password= assignment',
    input: 'config: password=hunter2isnotgreat',
    forbidden: 'password=hunter2isnotgreat',
    expectedCategory: 'password-assign',
  },
  {
    label: 'email',
    input: 'Contact: dev.team@example.com for support',
    forbidden: 'dev.team@example.com',
    expectedCategory: 'email',
  },
  {
    label: 'private tag',
    input: 'note: <private>do not share this internal plan</private>',
    forbidden: 'do not share this internal plan',
    expectedCategory: 'private-tag',
  },
];

test('redactor corpus — every fixture is fully redacted', () => {
  for (const fx of FIXTURES) {
    const r = redact(fx.input, OPTS);
    assert.ok(
      !r.text.includes(fx.forbidden),
      `[${fx.label}] forbidden secret literal still appears in redacted text:\n  in:  ${fx.input}\n  out: ${r.text}`,
    );
    assert.ok(
      r.categories.includes(fx.expectedCategory),
      `[${fx.label}] expected category "${fx.expectedCategory}", got [${r.categories.join(', ')}]`,
    );
    assert.ok(r.redactionCount >= 1, `[${fx.label}] expected redactionCount >= 1`);
  }
});

test('redactor corpus — looksSensitive flags every secret-bearing snippet', () => {
  for (const fx of FIXTURES) {
    // Some lightweight categories (email/IPv4) aren't in the cheap fast-path.
    // We accept that — only require the heavier ones to fire here.
    if (fx.expectedCategory === 'email' || fx.expectedCategory === 'private-tag') continue;
    assert.ok(
      looksSensitive(fx.input),
      `[${fx.label}] looksSensitive() should return true for: ${fx.input}`,
    );
  }
});

test('redactor corpus — clean text is untouched', () => {
  const clean = 'Refactored the search ranker to use RRF k=60 — see contextStore.ts line 342.';
  const r = redact(clean, OPTS);
  assert.equal(r.text, clean);
  assert.equal(r.redactionCount, 0);
  assert.deepEqual(r.categories, []);
});

test('redactor corpus — multiple secrets in one blob all redacted', () => {
  const blob = [
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    'OPENAI_API_KEY=sk-' + 'B'.repeat(40),
    'DATABASE_URL=postgres://app:hunter2sekret@db.example.com:5432/prod',
  ].join('\n');
  const r = redact(blob, OPTS);
  assert.ok(!r.text.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!r.text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789AB'));
  assert.ok(!r.text.includes('sk-' + 'B'.repeat(40)));
  assert.ok(!r.text.includes(':hunter2sekret@'));
  assert.ok(r.redactionCount >= 4, `expected >=4 redactions, got ${r.redactionCount}`);
});
