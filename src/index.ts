/**
 * otp-catch - a one-time-passcode input that fills itself in.
 *
 * Three things, in one small package with no dependencies:
 *
 * 1. `listen()` wraps the WebOTP API (`navigator.credentials.get({ otp: ... })`)
 *    with the AbortController, visibility retry and error mapping it needs to
 *    actually work on Android Chrome.
 * 2. `mount()` renders a segmented OTP input with correct paste, backspace,
 *    caret and autofill behaviour everywhere else.
 * 3. `serverHint()` builds the SMS body your backend must send. WebOTP silently
 *    does nothing unless the last line of the message is `@yourdomain #123456`,
 *    and that is the step almost everyone gets wrong.
 *
 * Every entry point is safe to import in Node: nothing touches `window` at
 * module scope, and `serverHint()` / `validateSmsBody()` / `sanitizeInput()`
 * are pure string functions that work server-side.
 */

/* ------------------------------------------------------------------------- *
 * Errors
 * ------------------------------------------------------------------------- */

/**
 * The set of failure reasons this package reports. Every error surfaced through
 * `onError` or thrown by `mount()` is an {@link OtpError} carrying one of these.
 *
 * - `unsupported` - no WebOTP in this browser (or no DOM at all).
 * - `insecure-context` - the page is not HTTPS/localhost, so WebOTP is disabled.
 * - `aborted` - the request was cancelled by you, by `destroy()`, or by unload.
 * - `already-pending` - another WebOTP request was still outstanding.
 * - `not-visible` - the document was hidden, so the browser refused to arm.
 * - `failed` - anything else, with the original error kept as `cause`.
 */
export type OtpErrorCode =
  | 'unsupported'
  | 'insecure-context'
  | 'aborted'
  | 'already-pending'
  | 'not-visible'
  | 'failed';

/** A normalised, typed error. The browser's original error is kept on `cause`. */
export class OtpError extends Error {
  /** Machine-readable reason. See {@link OtpErrorCode}. */
  readonly code: OtpErrorCode;
  /** The underlying `DOMException` (or whatever was thrown), untouched. */
  readonly cause?: unknown;

  constructor(code: OtpErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'OtpError';
    this.code = code;
    this.cause = cause;
    // Keeps `instanceof` working if the bundle is ever down-levelled to ES5.
    Object.setPrototypeOf(this, OtpError.prototype);
  }
}

/**
 * Normalise anything thrown by `navigator.credentials.get()` into an
 * {@link OtpError}. Exported because the mapping is genuinely useful to test
 * and to reuse if you call WebOTP yourself.
 *
 * @param err - the raw rejection value.
 */
export function toOtpError(err: unknown): OtpError {
  if (err instanceof OtpError) return err;

  const source = (err ?? {}) as { name?: unknown; message?: unknown };
  const name = typeof source.name === 'string' ? source.name : '';
  const message = typeof source.message === 'string' ? source.message : '';
  const lower = message.toLowerCase();

  switch (name) {
    case 'AbortError':
      return new OtpError('aborted', 'The WebOTP request was aborted.', err);

    case 'SecurityError':
      return new OtpError(
        'insecure-context',
        'WebOTP requires a secure context. Serve the page over HTTPS (localhost counts).',
        err,
      );

    case 'NotSupportedError':
      return new OtpError('unsupported', 'This browser does not support WebOTP.', err);

    case 'NotAllowedError':
      return new OtpError(
        'failed',
        'The browser refused the WebOTP request. Inside a cross-origin iframe this usually means the parent page is missing allow="otp-credentials".',
        err,
      );

    case 'InvalidStateError':
      if (lower.includes('hidden') || lower.includes('visib')) {
        return new OtpError('not-visible', 'The document was hidden, so WebOTP refused to arm.', err);
      }
      if (lower.includes('outstanding') || lower.includes('pending') || lower.includes('one otp')) {
        return new OtpError(
          'already-pending',
          'Another WebOTP request is still outstanding. Only one may be pending per page; abort the first one.',
          err,
        );
      }
      return new OtpError('failed', message || 'The WebOTP request was made in an invalid state.', err);

    default:
      if (lower.includes('hidden')) {
        return new OtpError('not-visible', 'The document was hidden, so WebOTP refused to arm.', err);
      }
      return new OtpError('failed', message || 'The WebOTP request failed.', err);
  }
}

/* ------------------------------------------------------------------------- *
 * Environment helpers
 * ------------------------------------------------------------------------- */

function hasDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * WebOTP is a phone feature: it reads an SMS the device just received. Desktop
 * Chrome exposes `OTPCredential` but there is no SMS to read, so the promise
 * simply never resolves. Reporting `true` there would be a lie, so we check the
 * user agent as well.
 */
function isMobileAgent(): boolean {
  if (typeof navigator === 'undefined') return false;

  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData && typeof uaData.mobile === 'boolean') return uaData.mobile;

  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua);
}

/**
 * Is the programmatic WebOTP API usable right now?
 *
 * True only when all of these hold: there is a DOM, `OTPCredential` exists, the
 * page is a secure context, and the user agent is a mobile one. In practice
 * that means Chrome (and Chromium browsers) on Android.
 *
 * This returning `false` is not a problem - it just means no automatic fill.
 * The mounted input still works by hand, by paste, and via iOS QuickType.
 */
export function isSupported(): boolean {
  if (!hasDom()) return false;
  if (!('OTPCredential' in window)) return false;
  if (!window.isSecureContext) return false;
  if (typeof navigator === 'undefined' || !navigator.credentials) return false;
  return isMobileAgent();
}

/* ------------------------------------------------------------------------- *
 * Pure string helpers (safe to use on a server)
 * ------------------------------------------------------------------------- */

/** Which characters an OTP may contain. */
export type OtpCharset = 'numeric' | 'alphanumeric';

const CHARSET_PATTERN: Record<OtpCharset, RegExp> = {
  numeric: /[^0-9]/g,
  alphanumeric: /[^0-9a-zA-Z]/g,
};

/** Options for {@link sanitizeInput}. */
export interface SanitizeOptions {
  /** Allowed characters. Default `'numeric'`. */
  charset?: OtpCharset;
  /** Truncate to this many characters. Omit to keep everything that survives. */
  length?: number;
}

/**
 * Normalise a pasted, autofilled or typed string into a bare code.
 *
 * Strips whitespace, hyphens and every other character outside the charset,
 * uppercases alphanumeric codes, then truncates to `length`. This is what makes
 * pasting `"123 456"` or `"12-34-56"` from a notification work.
 *
 * @example
 * sanitizeInput('123 456', { length: 6 })                        // '123456'
 * sanitizeInput('ab-12', { charset: 'alphanumeric', length: 4 }) // 'AB12'
 */
export function sanitizeInput(raw: string, options: SanitizeOptions = {}): string {
  if (typeof raw !== 'string' || raw === '') return '';
  const charset: OtpCharset = options.charset === 'alphanumeric' ? 'alphanumeric' : 'numeric';

  let out = raw.replace(CHARSET_PATTERN[charset], '');
  if (charset === 'alphanumeric') out = out.toUpperCase();

  const length = options.length;
  if (typeof length === 'number' && length >= 0 && out.length > length) out = out.slice(0, length);
  return out;
}

/**
 * Take a hostname, an origin or a full URL and return the bare host WebOTP
 * compares against. Ports are kept (Chrome includes them for non-default
 * ports), the scheme and path are dropped, and the result is lowercased.
 */
function normalizeDomain(input: string): string {
  let value = String(input).trim();
  if (value === '') return '';

  value = value.replace(/^@/, '');

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? '').toLowerCase();
    const rest = value.slice(schemeMatch[0].length);
    const host = rest.split('/')[0] ?? '';
    if (scheme !== 'https' && !/^localhost(:|$)/i.test(host) && !/^127\.0\.0\.1(:|$)/.test(host)) {
      throw new OtpError(
        'insecure-context',
        `otp-catch: WebOTP only works on https origins, and "${value}" is ${scheme}. Use an https domain (localhost is the one exception, for development).`,
      );
    }
    value = host;
  }

  value = (value.split('/')[0] ?? '').replace(/\.$/, '');
  return value.toLowerCase();
}

/** Options for {@link serverHint}. */
export interface HintOptions {
  /**
   * The human-readable part of the SMS. A `{code}` placeholder is replaced with
   * `code`. Default `'Your verification code is {code}'`.
   */
  message?: string;
  /** The code to embed. Default `'123456'`, i.e. a sample you can eyeball. */
  code?: string;
  /**
   * The scheme of the origin the code is bound to. WebOTP only accepts `https`
   * (localhost aside, for development), so this exists to state that explicitly
   * and to reject anything else early rather than in production.
   */
  scheme?: 'https';
}

/**
 * Build the exact SMS body WebOTP requires.
 *
 * The rule the API never tells you about: the **last line** of the message must
 * be `@<domain> #<code>`. Both the `@` and the `#` are mandatory, the domain
 * must be the full host of the page requesting the code (including subdomain),
 * and nothing may follow that line.
 *
 * @param domain - the host of the page that will call `listen()`. Defaults to
 *   `location.hostname` in a browser; **required** in Node.
 * @param options - see {@link HintOptions}.
 * @returns the complete SMS body, ready to hand to your SMS provider.
 *
 * @example
 * serverHint('example.com');
 * // Your verification code is 123456
 * //
 * // @example.com #123456
 *
 * @example
 * // In your Node backend:
 * serverHint('app.example.com', { code, message: 'Acme code: {code}' });
 */
export function serverHint(domain?: string, options: HintOptions = {}): string {
  const raw = domain ?? (hasDom() ? window.location?.hostname : undefined);

  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new OtpError(
      'failed',
      'otp-catch: serverHint() requires a domain when there is no browser to read location.hostname from. Pass the exact host your login page is served on, e.g. serverHint("app.example.com").',
    );
  }

  if (options.scheme !== undefined && options.scheme !== 'https') {
    throw new OtpError(
      'insecure-context',
      `otp-catch: serverHint({ scheme }) only accepts "https" - WebOTP ignores codes bound to any other scheme.`,
    );
  }

  const host = normalizeDomain(raw);
  if (host === '') {
    throw new OtpError('failed', `otp-catch: "${raw}" is not a usable domain.`);
  }

  const code = options.code === undefined ? '123456' : String(options.code);
  if (code.trim() === '') {
    throw new OtpError('failed', 'otp-catch: serverHint({ code }) cannot be an empty string.');
  }

  const template = options.message === undefined ? 'Your verification code is {code}' : options.message;
  const body = template.split('{code}').join(code).trim();

  return `${body}\n\n@${host} #${code}`;
}

/** Options for {@link validateSmsBody}. */
export interface ValidateSmsOptions {
  /**
   * The host the page is served on. Defaults to `location.hostname` in a
   * browser. If neither is available the domain check is skipped.
   */
  domain?: string;
}

/** Result of {@link validateSmsBody}. */
export interface SmsValidationResult {
  /** `true` when `problems` is empty. */
  valid: boolean;
  /** One specific, actionable sentence per problem found. */
  problems: string[];
}

/**
 * Check a real SMS body - paste one your provider actually sent - against the
 * WebOTP rules and explain exactly what is wrong with it.
 *
 * @param body - the full message text as the phone receives it.
 * @param options - see {@link ValidateSmsOptions}.
 */
export function validateSmsBody(body: string, options: ValidateSmsOptions = {}): SmsValidationResult {
  const problems: string[] = [];

  if (typeof body !== 'string' || body.trim() === '') {
    return { valid: false, problems: ['The SMS body is empty.'] };
  }

  const lines = body.split(/\r?\n/);
  const rawLast = lines[lines.length - 1] ?? '';

  if (rawLast.trim() === '' || rawLast !== rawLast.trim()) {
    problems.push(
      'The message does not end with the binding line. WebOTP only reads the very last line, so "@domain #code" must be last, with no trailing newline, spaces or extra text after it.',
    );
  }

  let lastLine = '';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = (lines[i] ?? '').trim();
    if (candidate !== '') {
      lastLine = candidate;
      break;
    }
  }

  if (!lastLine.startsWith('@')) {
    problems.push(
      `The binding line must start with "@" followed by the domain. Found: "${lastLine}".`,
    );
  }

  const hashIndex = lastLine.indexOf('#');
  if (hashIndex === -1) {
    problems.push(
      'The binding line is missing "#" before the code. Without the "#" the browser will never fire, even though the message looks right.',
    );
  } else {
    const code = lastLine.slice(hashIndex + 1).trim();
    if (code === '') {
      problems.push('There is no code after the "#".');
    } else if (/\s/.test(code)) {
      problems.push(`The code "${code}" contains whitespace; nothing may follow the code on the binding line.`);
    }
  }

  const expectedRaw = options.domain ?? (hasDom() ? window.location?.hostname : undefined);
  // Only worth comparing once the line is shaped like a binding line at all;
  // otherwise a missing "#" would produce a second, confusing "mismatch" problem.
  if (typeof expectedRaw === 'string' && expectedRaw.trim() !== '' && lastLine.startsWith('@') && hashIndex !== -1) {
    const found = lastLine.slice(1, hashIndex).trim().toLowerCase();
    const expected = normalizeDomain(expectedRaw);
    if (found !== expected) {
      problems.push(
        `Domain mismatch: the SMS is bound to "${found}" but the page is served from "${expected}". WebOTP compares the full host, so a subdomain difference is a mismatch.`,
      );
    }
  }

  return { valid: problems.length === 0, problems };
}

/* ------------------------------------------------------------------------- *
 * WebOTP listener
 * ------------------------------------------------------------------------- */

/** A live WebOTP request. */
export interface OtpListener {
  /** Cancel the request and remove every listener it registered. Idempotent. */
  abort(): void;
  /** `true` while the browser is waiting for a matching SMS. */
  readonly pending: boolean;
}

/** Options for {@link listen}. */
export interface ListenOptions {
  /** Called once with the code when an SMS matches. The request self-aborts first. */
  onCode(code: string): void;
  /** Called with a typed {@link OtpError}. Aborts are never reported here. */
  onError?(err: OtpError): void;
  /** Abort the request when this signal aborts. */
  signal?: AbortSignal;
  /**
   * The browser rejects the request while the document is hidden. With this on,
   * the listener waits for the next `visibilitychange` and re-arms instead of
   * failing. Default `true`.
   */
  retryOnVisible?: boolean;
}

interface OtpCredentialLike {
  code?: string;
}

/**
 * Only one WebOTP request may be outstanding per page - a second one rejects
 * with `InvalidStateError`. We track the live one so a second `listen()` can
 * quietly replace it instead of blowing up.
 */
let activeRequest: { abort(): void } | null = null;

/**
 * Arm the WebOTP API and call `onCode` when an SMS bound to this origin arrives.
 * No UI - use this when you already have your own input.
 *
 * Handles, so you do not have to:
 * - always passing an `AbortController` (without one the request leaks and the
 *   next call throws `InvalidStateError`);
 * - aborting on success, on unload, and when a second `listen()` starts;
 * - re-arming when the page becomes visible again;
 * - reading `.code` off the returned credential;
 * - telling a normal abort apart from a real failure.
 *
 * @returns an {@link OtpListener}. Always call `abort()` when your screen goes away.
 */
export function listen(options: ListenOptions): OtpListener {
  const opts = options ?? ({} as ListenOptions);
  const { onCode, onError, signal } = opts;
  const retryOnVisible = opts.retryOnVisible !== false;

  if (typeof onCode !== 'function') {
    throw new TypeError('otp-catch: listen({ onCode }) requires an onCode callback.');
  }

  let pending = false;
  let disposed = false;
  let controller: AbortController | null = null;
  let visibilityHandler: (() => void) | null = null;
  let pageHideHandler: (() => void) | null = null;
  let signalHandler: (() => void) | null = null;

  const listener: OtpListener = {
    abort() {
      dispose();
    },
    get pending() {
      return pending;
    },
  };

  const self = { abort: () => dispose() };

  function report(err: OtpError): void {
    if (err.code === 'aborted') return;
    if (onError) {
      onError(err);
      return;
    }
    // Never fail silently: with no handler, at least make it visible in the console.
    if (typeof console !== 'undefined' && typeof console.warn === 'function') {
      console.warn(`[otp-catch] ${err.code}: ${err.message}`);
    }
  }

  function detach(): void {
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
    visibilityHandler = null;

    if (pageHideHandler && typeof window !== 'undefined') {
      window.removeEventListener('pagehide', pageHideHandler);
    }
    pageHideHandler = null;

    if (signalHandler && signal) signal.removeEventListener('abort', signalHandler);
    signalHandler = null;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    pending = false;
    detach();
    if (activeRequest === self) activeRequest = null;
    if (controller) {
      controller.abort();
      controller = null;
    }
  }

  function armVisibilityRetry(): void {
    if (disposed || visibilityHandler) return;
    const handler = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', handler);
      visibilityHandler = null;
      start();
    };
    visibilityHandler = handler;
    document.addEventListener('visibilitychange', handler);
  }

  function start(): void {
    if (disposed) return;

    if (document.visibilityState === 'hidden') {
      if (retryOnVisible) {
        armVisibilityRetry();
        return;
      }
      const err = new OtpError(
        'not-visible',
        'WebOTP will not arm while the document is hidden. Call listen() again when the page is visible, or leave retryOnVisible on.',
      );
      dispose();
      report(err);
      return;
    }

    controller = new AbortController();
    pending = true;

    let request: Promise<OtpCredentialLike | null>;
    try {
      request = navigator.credentials.get({
        otp: { transport: ['sms'] },
        signal: controller.signal,
      } as unknown as CredentialRequestOptions) as unknown as Promise<OtpCredentialLike | null>;
    } catch (err) {
      pending = false;
      const normalised = toOtpError(err);
      dispose();
      report(normalised);
      return;
    }

    request.then(
      (credential) => {
        pending = false;
        if (disposed) return;
        // The resolved value is an OTPCredential, not the string. Read `.code`.
        const code = credential && typeof credential.code === 'string' ? credential.code : '';
        if (code === '') {
          dispose();
          report(new OtpError('failed', 'The browser resolved the WebOTP request without a code.'));
          return;
        }
        dispose();
        onCode(code);
      },
      (raw) => {
        pending = false;
        if (disposed) return;
        const err = toOtpError(raw);
        if (err.code === 'aborted') {
          dispose();
          return;
        }
        if (err.code === 'not-visible' && retryOnVisible) {
          controller = null;
          armVisibilityRetry();
          return;
        }
        dispose();
        report(err);
      },
    );
  }

  if (!hasDom() || typeof navigator === 'undefined') {
    disposed = true;
    report(new OtpError('unsupported', 'otp-catch: listen() needs a browser; there is no window here.'));
    return listener;
  }
  if (!window.isSecureContext) {
    disposed = true;
    report(
      new OtpError(
        'insecure-context',
        'WebOTP is disabled outside a secure context. Serve the page over HTTPS (localhost counts).',
      ),
    );
    return listener;
  }
  if (!('OTPCredential' in window) || !navigator.credentials) {
    disposed = true;
    report(
      new OtpError(
        'unsupported',
        'This browser has no WebOTP API. The input still works by typing, pasting, and iOS QuickType.',
      ),
    );
    return listener;
  }

  if (signal) {
    if (signal.aborted) {
      disposed = true;
      return listener;
    }
    signalHandler = () => dispose();
    signal.addEventListener('abort', signalHandler);
  }

  // Replace, do not collide: a second outstanding request would reject with
  // InvalidStateError, so the newest caller wins.
  if (activeRequest) activeRequest.abort();
  activeRequest = self;

  pageHideHandler = () => dispose();
  window.addEventListener('pagehide', pageHideHandler);

  start();
  return listener;
}

/* ------------------------------------------------------------------------- *
 * The input
 * ------------------------------------------------------------------------- */

/** A mounted OTP input. */
export interface OtpInstance {
  /** The current code. Assigning to it is the same as calling `setValue()`. */
  value: string;
  /** Focus the field and put the caret after the last entered character. */
  focus(): void;
  /** Empty the field. Fires `onChange`. */
  clear(): void;
  /** Replace the value. The string is sanitised and truncated first. */
  setValue(v: string): void;
  /** Remove the element, every listener, and any outstanding WebOTP request. Idempotent. */
  destroy(): void;
  /** `true` when every box is filled. */
  readonly complete: boolean;
}

/** Options for {@link mount}. */
export interface MountOptions {
  /** Number of characters. Default `6`. */
  length?: number;
  /** Allowed characters. Default `'numeric'`. */
  charset?: OtpCharset;
  /** Call `onComplete` as soon as the last character lands. Default `true`. */
  autoSubmit?: boolean;
  /** Arm the WebOTP listener as well. Default `true`. */
  webOtp?: boolean;
  /** Fired once per completed code (only when `autoSubmit` is on). */
  onComplete?(code: string): void;
  /** Fired on every value change. */
  onChange?(value: string): void;
  /** Fired with a typed {@link OtpError}, mostly from the WebOTP side. */
  onError?(err: OtpError): void;
  /** Focus the field on mount. Default `true`. */
  autoFocus?: boolean;
  /** Render disabled. Default `false`. */
  disabled?: boolean;
  /**
   * Placeholder shown in empty boxes. One character is repeated in every box; a
   * string exactly `length` long is used per box. Default `''`.
   */
  placeholder?: string;
  /** Accent colour for the active box and caret. Default `'#2563eb'`. */
  accent?: string;
  /** Border radius of each box, any CSS length. Default `'12px'`. */
  radius?: string;
  /** Gap between boxes, any CSS length. Default `'8px'`. */
  gap?: string;
  /** Width and height of each box, any CSS length. Default `'3rem'`. */
  size?: string;
  /** Colour scheme. `'auto'` follows `prefers-color-scheme`. Default `'auto'`. */
  theme?: 'light' | 'dark' | 'auto';
  /** Form field name for the real input. Default `'otp'`. */
  name?: string;
  /** Accessible name for the field. Default `'One-time passcode'`. */
  ariaLabel?: string;
}

const STYLE = `
:host {
  display: inline-block;
  --otp-accent: #2563eb;
  --otp-ring: rgba(37, 99, 235, 0.25);
  --otp-radius: 12px;
  --otp-gap: 8px;
  --otp-size: 3rem;
  --otp-fg: #0f172a;
  --otp-bg: #ffffff;
  --otp-border: #cbd5e1;
  --otp-placeholder: #94a3b8;
  --otp-selection: rgba(37, 99, 235, 0.12);
}
:host([data-otp-theme='dark']) {
  --otp-fg: #f8fafc;
  --otp-bg: #0f172a;
  --otp-border: #334155;
  --otp-placeholder: #64748b;
}
@media (prefers-color-scheme: dark) {
  :host([data-otp-theme='auto']) {
    --otp-fg: #f8fafc;
    --otp-bg: #0f172a;
    --otp-border: #334155;
    --otp-placeholder: #64748b;
  }
}
.root {
  position: relative;
  display: inline-flex;
}
.boxes {
  display: flex;
  gap: var(--otp-gap);
  pointer-events: none;
}
.box {
  box-sizing: border-box;
  width: var(--otp-size);
  height: var(--otp-size);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--otp-border);
  border-radius: var(--otp-radius);
  background: var(--otp-bg);
  color: var(--otp-fg);
  font: 600 1.25rem/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}
.box.filled { border-color: var(--otp-accent); }
.box.selected { background: var(--otp-selection); }
.box.active {
  border-color: var(--otp-accent);
  box-shadow: 0 0 0 3px var(--otp-ring);
}
.ph { color: var(--otp-placeholder); font-weight: 400; }
.caret {
  display: none;
  width: 2px;
  height: 45%;
  border-radius: 1px;
  background: var(--otp-accent);
  animation: otp-blink 1.1s steps(1) infinite;
}
.box.active.empty .caret { display: block; }
@keyframes otp-blink { 50% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .box { transition: none; }
  .caret { animation: none; }
}
.field {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: transparent;
  caret-color: transparent;
  text-align: center;
  /* 16px keeps iOS Safari from zooming the page when the field is focused. */
  font-size: 16px;
  letter-spacing: 0;
  -webkit-appearance: none;
  appearance: none;
  -webkit-tap-highlight-color: transparent;
}
.field::selection { background: transparent; }
.field:disabled { cursor: not-allowed; }
.root.disabled .box { opacity: 0.55; }
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
`;

/** Derive a translucent focus-ring colour from a hex accent, if we can parse it. */
function ringFrom(accent: string): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(accent.trim());
  if (!hex) return null;
  let body = hex[1] as string;
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, 0.25)`;
}

/**
 * Render a segmented one-time-passcode input into `target` and wire up WebOTP.
 *
 * The markup is deliberately **one real `<input>` stretched over presentational
 * boxes**, not N separate inputs. iOS QuickType and Android autofill hand the
 * whole code to a single field in one event; with six inputs you get the code
 * in box one and five empty boxes, plus a caret-management problem on every
 * keystroke. One input means native selection, backspace, Ctrl+A, undo and
 * screen-reader behaviour all keep working, and the boxes are pure decoration
 * driven by `input.value`.
 *
 * @param target - a CSS selector or an element to render into.
 * @param options - see {@link MountOptions}.
 * @throws {OtpError} when there is no DOM, or the target cannot be found.
 */
export function mount(target: string | HTMLElement, options: MountOptions = {}): OtpInstance {
  if (!hasDom()) {
    throw new OtpError(
      'unsupported',
      'otp-catch: mount() needs a DOM. Call it from the browser (e.g. in useEffect), not during server rendering.',
    );
  }

  const host = typeof target === 'string' ? document.querySelector(target) : target;
  if (!host || typeof (host as HTMLElement).appendChild !== 'function') {
    throw new OtpError(
      'failed',
      `otp-catch: mount() could not find a target element for ${typeof target === 'string' ? `"${target}"` : String(target)}.`,
    );
  }

  const length = Number.isFinite(options.length) ? Math.max(1, Math.floor(options.length as number)) : 6;
  const charset: OtpCharset = options.charset === 'alphanumeric' ? 'alphanumeric' : 'numeric';
  const autoSubmit = options.autoSubmit !== false;
  const useWebOtp = options.webOtp !== false;
  const autoFocus = options.autoFocus !== false;
  const disabled = options.disabled === true;
  const placeholder = typeof options.placeholder === 'string' ? options.placeholder : '';
  const accent = options.accent ?? '#2563eb';
  const radius = options.radius ?? '12px';
  const gap = options.gap ?? '8px';
  const size = options.size ?? '3rem';
  const theme = options.theme ?? 'auto';
  const name = options.name ?? 'otp';
  const ariaLabel = options.ariaLabel ?? 'One-time passcode';
  const { onComplete, onChange, onError } = options;

  const el = document.createElement('div');
  el.setAttribute('data-otp-theme', theme);
  el.style.setProperty('--otp-accent', accent);
  el.style.setProperty('--otp-radius', radius);
  el.style.setProperty('--otp-gap', gap);
  el.style.setProperty('--otp-size', size);
  const ring = ringFrom(accent);
  if (ring) el.style.setProperty('--otp-ring', ring);

  // A shadow root so nothing in the host page's CSS can reach in and break it.
  const shadow = el.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);

  const root = document.createElement('div');
  root.className = disabled ? 'root disabled' : 'root';

  const boxesEl = document.createElement('div');
  boxesEl.className = 'boxes';
  boxesEl.setAttribute('aria-hidden', 'true');

  const boxes: HTMLElement[] = [];
  const chars: HTMLElement[] = [];
  for (let i = 0; i < length; i += 1) {
    const box = document.createElement('div');
    box.className = 'box empty';
    const char = document.createElement('span');
    const caret = document.createElement('span');
    caret.className = 'caret';
    box.appendChild(char);
    box.appendChild(caret);
    boxesEl.appendChild(box);
    boxes.push(box);
    chars.push(char);
  }

  const input = document.createElement('input');
  input.className = 'field';
  input.type = 'text';
  // The one attribute that makes iOS QuickType offer the code above the keyboard.
  input.autocomplete = 'one-time-code';
  input.setAttribute('inputmode', charset === 'numeric' ? 'numeric' : 'text');
  input.setAttribute('pattern', charset === 'numeric' ? '[0-9]*' : '[0-9a-zA-Z]*');
  input.setAttribute('autocapitalize', charset === 'numeric' ? 'off' : 'characters');
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
  input.maxLength = length;
  input.name = name;
  input.setAttribute('aria-label', ariaLabel);
  input.disabled = disabled;

  const live = document.createElement('div');
  live.className = 'sr';
  live.setAttribute('aria-live', 'polite');

  root.appendChild(boxesEl);
  root.appendChild(input);
  root.appendChild(live);
  shadow.appendChild(root);

  // The real input lives in the shadow root, so it is invisible to <form>
  // submission. This light-DOM mirror keeps `new FormData(form)` working.
  const mirror = document.createElement('input');
  mirror.type = 'hidden';
  mirror.name = name;
  el.appendChild(mirror);

  (host as HTMLElement).appendChild(el);

  let lastValue = '';
  let completedValue: string | null = null;
  let destroyed = false;
  let otpListener: OtpListener | null = null;

  function render(): void {
    const value = input.value;
    const focused = shadow.activeElement === input;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? start;
    const hasRange = focused && end > start;
    const activeIndex = focused && !hasRange ? Math.min(Math.max(start, 0), length - 1) : -1;

    for (let i = 0; i < length; i += 1) {
      const box = boxes[i] as HTMLElement;
      const char = chars[i] as HTMLElement;
      const value_i = value[i] ?? '';

      if (value_i === '') {
        const ph = placeholder.length === length ? placeholder.charAt(i) : placeholder.charAt(0);
        char.textContent = ph;
        char.className = ph ? 'ph' : '';
      } else {
        char.textContent = value_i;
        char.className = '';
      }

      const classes = ['box'];
      if (value_i === '') classes.push('empty');
      else classes.push('filled');
      if (i === activeIndex) classes.push('active');
      if (hasRange && i >= start && i < end) classes.push('selected');
      box.className = classes.join(' ');
    }
  }

  function commit(): void {
    const value = input.value;
    mirror.value = value;
    render();
    if (value === lastValue) return;
    lastValue = value;

    if (value.length < length) completedValue = null;
    if (onChange) onChange(value);

    if (value.length === length) {
      live.textContent = `All ${length} characters entered.`;
      if (autoSubmit && completedValue !== value) {
        completedValue = value;
        if (onComplete) onComplete(value);
      }
    } else {
      live.textContent = '';
    }
  }

  function caretToEnd(): void {
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      /* setSelectionRange is not supported on every input type; harmless here. */
    }
  }

  const onInput = () => {
    const raw = input.value;
    const clean = sanitizeInput(raw, { charset, length });
    if (clean !== raw) {
      // Rejected characters: put the sanitised value back and keep the caret
      // where the user expects it, rather than jumping to the end.
      const pos = input.selectionStart ?? clean.length;
      const next = Math.max(0, Math.min(clean.length, pos - (raw.length - clean.length)));
      input.value = clean;
      try {
        input.setSelectionRange(next, next);
      } catch {
        /* ignore */
      }
    }
    commit();
  };

  const onPaste = (event: Event) => {
    const clipboard = (event as ClipboardEvent).clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    // "123 456" and "12-34-56" are what people actually copy out of a notification.
    input.value = sanitizeInput(clipboard.getData('text'), { charset, length });
    caretToEnd();
    commit();
  };

  const onFocusOrClick = () => {
    caretToEnd();
    render();
  };

  const onBlur = () => render();
  const onKeyUp = () => render();
  const onSelect = () => render();

  input.addEventListener('input', onInput);
  input.addEventListener('paste', onPaste);
  input.addEventListener('focus', onFocusOrClick);
  input.addEventListener('click', onFocusOrClick);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keyup', onKeyUp);
  input.addEventListener('select', onSelect);

  if (useWebOtp && isSupported()) {
    otpListener = listen({
      onCode: (code) => {
        if (destroyed) return;
        input.value = sanitizeInput(code, { charset, length });
        live.textContent = 'Code filled automatically from SMS.';
        commit();
      },
      onError: (err) => {
        if (onError) onError(err);
      },
    });
  }

  render();
  if (autoFocus && !disabled) {
    try {
      input.focus();
      caretToEnd();
      render();
    } catch {
      /* focus can throw in detached documents; not fatal. */
    }
  }

  const instance: OtpInstance = {
    get value() {
      return input.value;
    },
    set value(next: string) {
      instance.setValue(next);
    },
    get complete() {
      return input.value.length === length;
    },
    focus() {
      input.focus();
      caretToEnd();
      render();
    },
    clear() {
      instance.setValue('');
    },
    setValue(next: string) {
      input.value = sanitizeInput(next, { charset, length });
      caretToEnd();
      commit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (otpListener) {
        otpListener.abort();
        otpListener = null;
      }
      input.removeEventListener('input', onInput);
      input.removeEventListener('paste', onPaste);
      input.removeEventListener('focus', onFocusOrClick);
      input.removeEventListener('click', onFocusOrClick);
      input.removeEventListener('blur', onBlur);
      input.removeEventListener('keyup', onKeyUp);
      input.removeEventListener('select', onSelect);
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };

  return instance;
}

/* ------------------------------------------------------------------------- *
 * Default export
 * ------------------------------------------------------------------------- */

/**
 * The same members as the named exports, for the IIFE global
 * (`OtpCatch.mount(...)`) and for `import OtpCatch from 'otp-catch'`.
 */
const OtpCatch = {
  isSupported,
  listen,
  mount,
  serverHint,
  validateSmsBody,
  sanitizeInput,
  toOtpError,
  OtpError,
};

export default OtpCatch;
