import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, RedactOptions } from '../redactor';

const ON: RedactOptions = {
  redactSecrets: true,
  honorPrivateTags: true,
  detectHighEntropy: true,
};
const OFF: RedactOptions = { redactSecrets: true, honorPrivateTags: true };

test('entropy — high-entropy mixed token is redacted when enabled', () => {
  // 32-char random token mixing upper/lower/digits — no named rule matches it.
  const token = 'Xk9Qp2Lm7Za4Rb1Tc8Wd5Ye3Uf6Vg0H';
  const r = redact(`opaque session = ${token}`, ON);
  assert.match(r.text, /\[REDACTED:high-entropy\]#[a-f0-9]{16}/);
  assert.ok(!r.text.includes(token));
  assert.ok(r.categories.includes('high-entropy'));
});

test('entropy — pass is off by default (no detectHighEntropy flag)', () => {
  const token = 'Xk9Qp2Lm7Za4Rb1Tc8Wd5Ye3Uf6Vg0H';
  const r = redact(`opaque session = ${token}`, OFF);
  assert.ok(r.text.includes(token));
});

test('entropy — lowercase hex git SHA is spared (only 2 char classes)', () => {
  const sha = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // 40-char sha1, lower hex
  const r = redact(`commit ${sha}`, ON);
  assert.ok(r.text.includes(sha), 'git SHA must not be redacted by entropy pass');
});

test('entropy — ordinary prose is untouched', () => {
  const prose = 'The quick brown fox refactors the authentication module today.';
  const r = redact(prose, ON);
  assert.equal(r.text, prose);
});

test('entropy — base64 credential blob is redacted', () => {
  const blob = 'dXNlcjpzdXBlclNlY3JldFBhc3N3b3JkMTIzNDU2Nzg5MA==';
  const r = redact(`auth blob ${blob}`, ON);
  assert.ok(!r.text.includes(blob));
  assert.match(r.text, /\[REDACTED:high-entropy\]/);
});

test('entropy — short tokens below the length floor are spared', () => {
  const short = 'Ab1Cd2Ef3'; // 9 chars, < 24
  const r = redact(`id ${short}`, ON);
  assert.ok(r.text.includes(short));
});

// ── Adversarial corpus (v1.10.2 redactor hardening regressions) ──────────────

test('adversarial — base64 PEM line is NOT flagged azure-storage-key (even with entropy on)', () => {
  // Real PEM bodies contain lines of this shape; the v1.10.2 named rule now
  // requires an "AccountKey=" / `key=` / `"key":` context. With entropy ON
  // the line may still get caught under `high-entropy`, but never under the
  // azure-storage-key tag — that's the false-positive class we fixed.
  const pemLine = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvK7L4F6e9DfX0pX2YzqxPzNqVwH7T8X==';
  const r = redact(`-----BEGIN CERTIFICATE-----\n${pemLine}\n-----END CERTIFICATE-----`, ON);
  assert.ok(!r.categories.includes('azure-storage-key'));
});

test('adversarial — JWT body matched by named rule is not double-redacted', () => {
  // A well-formed three-segment JWT — the named rule catches it as one unit.
  const jwt =
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const r = redact(`token=${jwt}`, ON);
  // Exactly one JWT category, never doubled.
  const jwtHits = r.categories.filter((c) => c === 'jwt').length;
  assert.equal(jwtHits, 1);
  assert.ok(!r.text.includes(jwt));
});

test('adversarial — Stripe live keys redacted by named rule (entropy catches pk_test_ too)', () => {
  // The named stripe-key rule catches sk_live_; pk_test_ is dev-only and not
  // matched by the live rule, BUT the high-entropy catch-all (enabled here)
  // still flags it because the 24-char trailing token clears the entropy
  // floor. Both are masked out of the text; only the named hit has the
  // stripe-key category tag.
  // Synthetic shape-only fixtures (matches the rule regex; nothing real). We
  // ASSEMBLE the values at runtime — both our own rule and external scanners
  // (GitHub push-protection, gitleaks) work on source-file regex, so a
  // concatenation breaks the static match while leaving the runtime test
  // value identical. The two halves have mixed character classes so the
  // high-entropy detector's char-class floor is still cleared.
  const LIVE_PREFIX = 'sk_' + 'live_';
  const TEST_PREFIX = 'pk_' + 'test_';
  const BODY = 'FAKEa1B2c3D4e5F6g7H8i9J0k1L2'; // 28 alnum
  const live = LIVE_PREFIX + BODY;
  const testKey = TEST_PREFIX + BODY;
  const r = redact(`live=${live} test=${testKey}`, ON);
  assert.ok(!r.text.includes(live), 'sk_live_ must be redacted');
  assert.ok(r.categories.includes('stripe-key'));
  assert.ok(
    !r.text.includes(testKey),
    'pk_test_ should also be masked by the entropy catch-all when enabled',
  );
});

test('adversarial — 32-char lowercase hex git SHA is NOT flagged', () => {
  // Real git SHAs (md5/sha1/sha256 truncated) are 2-class (lower+digit).
  // The entropy detector requires ≥3 character classes — so it must be spared.
  const sha = 'd41d8cd98f00b204e9800998ecf8427e';
  assert.equal(sha.length, 32);
  const r = redact(`commit ${sha}`, ON);
  assert.ok(r.text.includes(sha), 'lowercase hex git SHA must not be redacted');
});

// ── v1.15.0: password-style second pass (bench-real canary class) ─────────

test('password-style secret with shell specials IS redacted (v1.15 second pass)', () => {
  // The base entropy alphabet splits at $ ! @ # % ^ & * — this exact shape
  // leaked through v1.13/v1.14 and was caught by the bench-real canary scan.
  const secret = 'zX9$kQ2!mP7@vR4#nT8%wY3^bL6&cJ1*fH5';
  const r = redact(`old value ${secret} must be scrubbed`, ON);
  assert.ok(!r.text.includes(secret), 'password-style secret must be redacted');
  assert.ok(r.categories.includes('high-entropy'));
});

test('password-style pass requires all four character classes', () => {
  // lower+special only (no upper, no digit) — must NOT match the strict pass.
  const notSecret = 'my-password!is@just#words$here';
  const r = redact(`note: ${notSecret}`, ON);
  assert.ok(r.text.includes(notSecret), '2-class password-ish text must be spared');
});

test('code expressions with dots/parens do NOT trip the password-style pass', () => {
  // Dots, brackets, parens are excluded from the alphabet, so code fragments
  // break apart before reaching the length gate.
  const code = 'const y = Math.pow(2,-x)/norm_Y3 + arr[i]*scale_Q7;';
  const r = redact(code, ON);
  assert.ok(r.text.includes('Math.pow(2,-x)/norm_Y3'), 'code must survive intact');
});
