// Zero-dependency smoke tests. These run in plain Node with no DOM, which is
// itself half the point: importing otp-catch on a server must be harmless, and
// serverHint()/validateSmsBody() must work there because that is where the SMS
// body is actually built.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import OtpCatch, {
  OtpError,
  isSupported,
  listen,
  mount,
  sanitizeInput,
  serverHint,
  toOtpError,
  validateSmsBody,
} from '../dist/index.js';

/* ------------------------------------------------------------------ *
 * SSR safety
 * ------------------------------------------------------------------ */

test('importing with no window does not throw and there is no global leakage', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
});

test('isSupported() is false with no DOM', () => {
  assert.equal(isSupported(), false);
});

test('mount() throws a clear, typed error with no DOM', () => {
  assert.throws(
    () => mount('#otp'),
    (err) => {
      assert.ok(err instanceof OtpError);
      assert.equal(err.code, 'unsupported');
      assert.match(err.message, /needs a DOM/);
      return true;
    },
  );
});

test('listen() reports unsupported through onError instead of throwing', () => {
  const errors = [];
  const listener = listen({ onCode: () => {}, onError: (err) => errors.push(err) });
  assert.equal(listener.pending, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'unsupported');
  listener.abort();
  listener.abort(); // idempotent
});

test('serverHint() works server-side, which is the whole point', () => {
  assert.equal(typeof serverHint('example.com'), 'string');
});

/* ------------------------------------------------------------------ *
 * API surface
 * ------------------------------------------------------------------ */

test('every documented export exists with the right type', () => {
  assert.equal(typeof isSupported, 'function');
  assert.equal(typeof listen, 'function');
  assert.equal(typeof mount, 'function');
  assert.equal(typeof serverHint, 'function');
  assert.equal(typeof validateSmsBody, 'function');
  assert.equal(typeof sanitizeInput, 'function');
  assert.equal(typeof toOtpError, 'function');
  assert.equal(typeof OtpError, 'function');
});

test('the default export mirrors the named exports', () => {
  assert.equal(OtpCatch.isSupported, isSupported);
  assert.equal(OtpCatch.listen, listen);
  assert.equal(OtpCatch.mount, mount);
  assert.equal(OtpCatch.serverHint, serverHint);
  assert.equal(OtpCatch.validateSmsBody, validateSmsBody);
  assert.equal(OtpCatch.sanitizeInput, sanitizeInput);
  assert.equal(OtpCatch.toOtpError, toOtpError);
  assert.equal(OtpCatch.OtpError, OtpError);
});

/* ------------------------------------------------------------------ *
 * serverHint
 * ------------------------------------------------------------------ */

test('serverHint() default body ends with the binding line', () => {
  assert.equal(serverHint('example.com'), 'Your verification code is 123456\n\n@example.com #123456');
});

test('serverHint() substitutes {code} in a custom message', () => {
  assert.equal(
    serverHint('example.com', { message: 'Acme: {code}. Never share it.' }),
    'Acme: 123456. Never share it.\n\n@example.com #123456',
  );
});

test('serverHint() uses a custom code in both places', () => {
  assert.equal(
    serverHint('app.example.com', { code: '778899' }),
    'Your verification code is 778899\n\n@app.example.com #778899',
  );
});

test('serverHint() keeps the subdomain, because WebOTP compares the full host', () => {
  const body = serverHint('login.app.example.com');
  assert.ok(body.endsWith('@login.app.example.com #123456'));
});

test('serverHint() accepts a full URL and reduces it to the host', () => {
  assert.equal(serverHint('https://app.example.com/login?next=/'), 'Your verification code is 123456\n\n@app.example.com #123456');
});

test('serverHint() rejects a non-https origin', () => {
  assert.throws(
    () => serverHint('http://app.example.com'),
    (err) => {
      assert.equal(err.code, 'insecure-context');
      return true;
    },
  );
});

test('serverHint() throws a clear error when no domain is available outside a browser', () => {
  assert.throws(
    () => serverHint(),
    (err) => {
      assert.ok(err instanceof OtpError);
      assert.match(err.message, /requires a domain/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * validateSmsBody
 * ------------------------------------------------------------------ */

const MISSING_AT =
  'The binding line must start with "@" followed by the domain. Found: "example.com #123456".';
const MISSING_HASH =
  'The binding line is missing "#" before the code. Without the "#" the browser will never fire, even though the message looks right.';
const MISSING_CODE = 'There is no code after the "#".';
const NOT_LAST =
  'The message does not end with the binding line. WebOTP only reads the very last line, so "@domain #code" must be last, with no trailing newline, spaces or extra text after it.';
const MISMATCH =
  'Domain mismatch: the SMS is bound to "example.com" but the page is served from "app.example.com". WebOTP compares the full host, so a subdomain difference is a mismatch.';

test('validateSmsBody() passes what serverHint() produced', () => {
  const result = validateSmsBody(serverHint('example.com'), { domain: 'example.com' });
  assert.deepEqual(result, { valid: true, problems: [] });
});

test('validateSmsBody() flags a missing @', () => {
  const result = validateSmsBody('Your code is 123456\n\nexample.com #123456', { domain: 'example.com' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems, [MISSING_AT]);
});

test('validateSmsBody() flags a missing #', () => {
  const result = validateSmsBody('Your code is 123456\n\n@example.com 123456', { domain: 'example.com' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems, [MISSING_HASH]);
});

test('validateSmsBody() flags the wrong domain, subdomains included', () => {
  const result = validateSmsBody('Your code is 123456\n\n@example.com #123456', { domain: 'app.example.com' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems, [MISMATCH]);
});

test('validateSmsBody() flags a missing code', () => {
  const result = validateSmsBody('Your code\n\n@example.com #', { domain: 'example.com' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems, [MISSING_CODE]);
});

test('validateSmsBody() flags a binding line that is not actually last', () => {
  const result = validateSmsBody('Your code is 123456\n\n@example.com #123456\n', { domain: 'example.com' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems, [NOT_LAST]);
});

test('validateSmsBody() flags text after the code on the binding line', () => {
  const result = validateSmsBody('Your code\n\n@example.com #123456 - Acme', { domain: 'example.com' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.problems, [
    'The code "123456 - Acme" contains whitespace; nothing may follow the code on the binding line.',
  ]);
});

test('validateSmsBody() reports an empty body once', () => {
  assert.deepEqual(validateSmsBody('   '), { valid: false, problems: ['The SMS body is empty.'] });
});

test('validateSmsBody() skips the domain check when no domain is known', () => {
  const result = validateSmsBody('Your code is 123456\n\n@example.com #123456');
  assert.deepEqual(result, { valid: true, problems: [] });
});

/* ------------------------------------------------------------------ *
 * sanitizeInput
 * ------------------------------------------------------------------ */

test('sanitizeInput() strips spaces from a pasted code', () => {
  assert.equal(sanitizeInput('123 456', { charset: 'numeric', length: 6 }), '123456');
});

test('sanitizeInput() strips hyphens from a pasted code', () => {
  assert.equal(sanitizeInput('12-34-56', { charset: 'numeric', length: 6 }), '123456');
});

test('sanitizeInput() drops letters in numeric mode', () => {
  assert.equal(sanitizeInput('abc123', { charset: 'numeric', length: 6 }), '123');
});

test('sanitizeInput() truncates to length', () => {
  assert.equal(sanitizeInput('1234567890', { charset: 'numeric', length: 6 }), '123456');
});

test('sanitizeInput() uppercases alphanumeric codes', () => {
  assert.equal(sanitizeInput('ab-12cd', { charset: 'alphanumeric', length: 6 }), 'AB12CD');
});

test('sanitizeInput() keeps everything valid when no length is given', () => {
  assert.equal(sanitizeInput('1234567890'), '1234567890');
});

test('sanitizeInput() handles junk input', () => {
  assert.equal(sanitizeInput(''), '');
  assert.equal(sanitizeInput('   -- '), '');
  assert.equal(sanitizeInput(undefined), '');
});

test('sanitizeInput() handles a real SMS line people paste whole', () => {
  assert.equal(sanitizeInput('Your code is 123456', { charset: 'numeric', length: 6 }), '123456');
});

/* ------------------------------------------------------------------ *
 * Error mapping
 * ------------------------------------------------------------------ */

const fakeDomException = (name, message = '') => ({ name, message });

test('toOtpError() maps AbortError to aborted', () => {
  assert.equal(toOtpError(fakeDomException('AbortError', 'signal is aborted')).code, 'aborted');
});

test('toOtpError() maps SecurityError to insecure-context', () => {
  assert.equal(toOtpError(fakeDomException('SecurityError')).code, 'insecure-context');
});

test('toOtpError() maps NotSupportedError to unsupported', () => {
  assert.equal(toOtpError(fakeDomException('NotSupportedError')).code, 'unsupported');
});

test('toOtpError() maps a hidden-document InvalidStateError to not-visible', () => {
  const err = toOtpError(fakeDomException('InvalidStateError', 'The document is hidden, so this API is not allowed.'));
  assert.equal(err.code, 'not-visible');
});

test('toOtpError() maps a second outstanding request to already-pending', () => {
  const err = toOtpError(
    fakeDomException('InvalidStateError', 'Only one OTP request may be outstanding at a time.'),
  );
  assert.equal(err.code, 'already-pending');
});

test('toOtpError() maps NotAllowedError to failed and explains the iframe policy', () => {
  const err = toOtpError(fakeDomException('NotAllowedError'));
  assert.equal(err.code, 'failed');
  assert.match(err.message, /otp-credentials/);
});

test('toOtpError() falls back to failed and keeps the original as cause', () => {
  const original = new Error('kaboom');
  const err = toOtpError(original);
  assert.equal(err.code, 'failed');
  assert.equal(err.message, 'kaboom');
  assert.equal(err.cause, original);
});

test('toOtpError() passes an OtpError straight through', () => {
  const original = new OtpError('already-pending', 'nope');
  assert.equal(toOtpError(original), original);
});

test('OtpError is a real Error with a name and a code', () => {
  const err = new OtpError('failed', 'boom');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof OtpError);
  assert.equal(err.name, 'OtpError');
  assert.equal(err.code, 'failed');
});
