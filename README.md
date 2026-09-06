# otp-catch

*A one-time-passcode input that fills itself in — and tells you the exact SMS your backend has to send.*

[![npm version](https://img.shields.io/npm/v/otp-catch.svg)](https://www.npmjs.com/package/otp-catch)
[![minzipped size](https://img.shields.io/bundlephobia/minzip/otp-catch)](https://bundlephobia.com/package/otp-catch)
[![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](./dist/index.d.ts)

```js
// Before: the API exists, you call it, and nothing ever happens.
const ac = new AbortController();                       // forget this and the next call throws
const cred = await navigator.credentials.get({ otp: { transport: ['sms'] }, signal: ac.signal });
verify(cred.code);                                      // ...if the SMS was formatted exactly right

// After:
OtpCatch.mount('#otp', { onComplete: verify });
console.log(OtpCatch.serverHint());  // the SMS body that makes the line above fire
```

No dependencies. ~6 kB min+gzip for the whole thing, styles included. Works in Node, so your backend can import `serverHint` too.

## Why this exists

WebOTP is a small API with a lot of undocumented ways to do nothing at all. Each of these is a bug
people ship:

- **The SMS format is the whole game.** The message's *last line* must be `@yourdomain.com #123456`.
  Miss the `#`, use the apex domain when the page is on a subdomain, or put a signature line after
  it, and the browser stays silent — no error, no warning, no event. `serverHint()` generates the
  line for you, and `validateSmsBody()` tells you what is wrong with the one you already send.
- **You must pass an `AbortController` signal.** Without one the request stays outstanding forever,
  and the *next* `navigator.credentials.get({ otp })` rejects with `InvalidStateError: Only one OTP
  request may be outstanding at a time`. `listen()` always passes a signal, and a second `listen()`
  replaces the first instead of throwing.
- **A hidden document refuses to arm.** Call it while the tab is backgrounded and it rejects.
  `listen()` waits for the next `visibilitychange` and re-arms itself, then removes that listener.
- **The promise resolves with an `OTPCredential`, not a string.** You want `credential.code`.
- **`AbortError` is not a failure.** Normal teardown rejects the promise; reporting that to your
  error tracker is noise. Aborts are never sent to `onError`.
- **Desktop Chrome has the API and can never use it.** There is no SMS to read, so the promise just
  hangs. `isSupported()` returns `false` there rather than pretending.
- **iOS has no programmatic API at all** — but `autocomplete="one-time-code"` makes QuickType offer
  the code above the keyboard. It only works if the attribute is on a real, focusable `<input>`.
- **Autofill dumps the whole code into one field.** Six separate `<input>` boxes get you the code in
  box one and five empty boxes. `mount()` renders *one* real input over presentational boxes.
- **People paste `123 456` and `12-34-56`.** Whitespace, hyphens and out-of-charset characters are
  stripped before the value is set.
- **Cross-origin iframes need `allow="otp-credentials"`** or the call rejects with
  `NotAllowedError`. The error message says so.

## Install

```bash
npm install otp-catch
```

Or from a CDN, which defines the global `OtpCatch`:

```html
<script src="https://unpkg.com/otp-catch"></script>
```

## Quick start

```html
<form id="verify">
  <div id="otp"></div>
  <button type="submit">Verify</button>
</form>

<script type="module">
  import { mount } from 'https://unpkg.com/otp-catch/dist/index.js';

  const otp = mount('#otp', {
    length: 6,
    onComplete: async (code) => {
      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) otp.clear();
    },
    onError: (err) => console.warn(err.code, err.message),
  });

  // When the screen goes away:
  // otp.destroy();
</script>
```

That is the whole client side. On Android Chrome the code fills itself in when the SMS arrives; on
iOS the keyboard offers it; everywhere else people type or paste. Same code path, no branching.

## The part everyone gets wrong

WebOTP does not read *your* SMS. It reads an SMS whose **last line binds it to your origin**. If the
message is not shaped exactly like this, the browser ignores it and gives you nothing to debug:

```text
Your verification code is 123456

@example.com #123456
```

Two hard rules, and both are silent when broken:

1. The last line must start with `@` followed by the **full host of the page** that calls the API.
2. The code must follow a `#`, and **nothing** may come after it — not a signature, not a blank line.

`serverHint()` builds that body for you:

```js
import { serverHint } from 'otp-catch';

serverHint('example.com');
// 'Your verification code is 123456\n\n@example.com #123456'

serverHint('app.example.com', { code: '778899', message: 'Acme code: {code}. Never share it.' });
// 'Acme code: 778899. Never share it.\n\n@app.example.com #778899'
```

### Common mistakes

| The SMS you sent | Why nothing happens |
| --- | --- |
| `Your code is 123456` | No binding line at all. WebOTP never fires. |
| `Your code is 123456\n\n@example.com 123456` | Missing the `#`. Looks right; does nothing. |
| `...\n\n@example.com #123456\n— Acme Ltd` | The binding line must be **last**. A signature kills it. |
| `...\n\n@example.com #123456\n` | Same problem, invisibly: a trailing newline. |
| Page on `app.example.com`, SMS says `@example.com` | Full host must match. Subdomains are not folded in. |
| Page on `example.com`, SMS says `@www.example.com` | Same rule, the other way round. |
| `...\n\n@https://example.com #123456` | No scheme. Just the host. |
| Page served over `http://` | WebOTP is secure-context only. HTTPS, or localhost for dev. |

### Check the SMS you already send

Paste a real message body in and get specific complaints back:

```js
import { validateSmsBody } from 'otp-catch';

validateSmsBody('Your code is 123456\n\n@example.com 123456', { domain: 'example.com' });
// {
//   valid: false,
//   problems: [
//     'The binding line is missing "#" before the code. Without the "#" the browser will never
//      fire, even though the message looks right.'
//   ]
// }
```

Worth wiring into a test in your backend so a copy edit to the SMS template cannot break login.

### On your server

`otp-catch` has no browser code at module scope, so this is a legitimate Node import:

```js
// server/send-code.js
import { serverHint } from 'otp-catch';

const OTP_HOST = process.env.PUBLIC_HOST; // e.g. 'app.example.com' - the host of the LOGIN page

export async function sendCode(phone, code) {
  await sms.send({
    to: phone,
    body: serverHint(OTP_HOST, {
      code,
      message: 'Your Acme verification code is {code}. It expires in 10 minutes.',
    }),
  });
}
```

That closes the loop: the same package that arms the browser writes the message the browser is
listening for, so the two can never drift apart.

## React

```tsx
import { useOtpInput, useWebOtp } from 'otp-catch/react';

export function CodeField({ onSubmit }: { onSubmit: (code: string) => void }) {
  const { value, boxes, inputProps, clear, complete } = useOtpInput({
    length: 6,
    onComplete: onSubmit,
  });

  // Android Chrome only; a no-op everywhere else.
  const { supported, pending } = useWebOtp({ onCode: onSubmit });

  return (
    <label className="otp">
      <span className="otp-boxes" aria-hidden>
        {boxes.map((box, i) => (
          <span key={i} className={box.active ? 'otp-box is-active' : 'otp-box'}>
            {box.char}
          </span>
        ))}
      </span>
      <input {...inputProps} aria-label="One-time passcode" className="otp-field" />
      {supported && pending && <span className="otp-hint">Waiting for your SMS…</span>}
    </label>
  );
}
```

`inputProps` already carries `autoComplete: 'one-time-code'`, `inputMode`, `pattern`, `maxLength`,
`onChange` and `onPaste`. The `.otp-field` should be positioned over `.otp-boxes` with transparent
text and a hidden caret — see [the reasoning below](#why-one-input-and-not-six).

Both hooks are SSR-safe: `supported` starts as `false` and is resolved in an effect, so hydration
never mismatches. `useWebOtp` aborts its request on unmount and whenever `enabled` flips to `false`.

## API

### `mount(target, options?) => OtpInstance`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `length` | `number` | `6` | Number of characters. |
| `charset` | `'numeric' \| 'alphanumeric'` | `'numeric'` | Allowed characters. Alphanumeric is uppercased. |
| `autoSubmit` | `boolean` | `true` | Fire `onComplete` as soon as the last character lands. |
| `webOtp` | `boolean` | `true` | Arm the WebOTP listener too. |
| `onComplete` | `(code: string) => void` | — | Once per completed code. |
| `onChange` | `(value: string) => void` | — | On every change. |
| `onError` | `(err: OtpError) => void` | — | Typed errors, mostly from WebOTP. |
| `autoFocus` | `boolean` | `true` | Focus the field on mount. |
| `disabled` | `boolean` | `false` | Render disabled. |
| `placeholder` | `string` | `''` | One char repeated, or a string exactly `length` long. |
| `accent` | `string` | `'#2563eb'` | Active-box border and caret colour. |
| `radius` | `string` | `'12px'` | Box corner radius. |
| `gap` | `string` | `'8px'` | Space between boxes. |
| `size` | `string` | `'3rem'` | Box width and height. |
| `theme` | `'light' \| 'dark' \| 'auto'` | `'auto'` | `'auto'` follows `prefers-color-scheme`. |
| `name` | `string` | `'otp'` | Form field name. |
| `ariaLabel` | `string` | `'One-time passcode'` | Accessible name for the field. |

`OtpInstance`:

| Member | Type | Description |
| --- | --- | --- |
| `value` | `string` | Get or set the code. Setting sanitises first. |
| `complete` | `boolean` (readonly) | Every box filled. |
| `focus()` | `() => void` | Focus, caret after the last character. |
| `clear()` | `() => void` | Empty the field. |
| `setValue(v)` | `(v: string) => void` | Replace the value. |
| `destroy()` | `() => void` | Remove element, listeners and any pending WebOTP request. Idempotent. |

### `listen(options) => OtpListener`

Pure WebOTP, no UI, for when you already have an input.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `onCode` | `(code: string) => void` | — | Required. Called once; the request self-aborts first. |
| `onError` | `(err: OtpError) => void` | — | Typed errors. Aborts are never reported. |
| `signal` | `AbortSignal` | — | Abort the request when this aborts. |
| `retryOnVisible` | `boolean` | `true` | Re-arm on the next `visibilitychange` if the page was hidden. |

`OtpListener` is `{ abort(): void; readonly pending: boolean }`. The request also aborts on success,
on `pagehide`, and when a later `listen()` starts.

### `serverHint(domain?, options?) => string`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `message` | `string` | `'Your verification code is {code}'` | `{code}` is substituted. |
| `code` | `string` | `'123456'` | The code to embed — a sample by default. |
| `scheme` | `'https'` | — | Assert the origin's scheme. Anything else throws. |

`domain` defaults to `location.hostname` in a browser and is **required** in Node. A full URL
(`https://app.example.com/login`) is accepted and reduced to its host; a non-`https` URL throws
`insecure-context`.

### `validateSmsBody(body, options?) => { valid, problems }`

`options.domain` defaults to `location.hostname`; if there is none, the domain check is skipped.
`problems` is a list of specific, human sentences — safe to show in a developer-facing settings page.

### `sanitizeInput(raw, options?) => string`

The paste/autofill normaliser, exported because it is useful on its own.
`sanitizeInput('12-34-56', { length: 6 })` is `'123456'`.

### `isSupported() => boolean`

`true` only when there is a DOM, `OTPCredential` exists, the context is secure, **and** the user
agent is mobile. See [Browser support](#browser-support).

### `toOtpError(err) => OtpError`

Normalises a raw `DOMException` into a typed error. `OtpError` has `code`, `message` and `cause`.

| `code` | Means |
| --- | --- |
| `unsupported` | No WebOTP here (or no DOM at all). |
| `insecure-context` | Not HTTPS/localhost. |
| `aborted` | Cancelled by you, by `destroy()`, or by unload. Never sent to `onError`. |
| `already-pending` | Another WebOTP request was outstanding. |
| `not-visible` | The document was hidden and `retryOnVisible` was off. |
| `failed` | Everything else; the original is on `cause`. |

## Browser support

| Environment | What happens |
| --- | --- |
| Chrome / Edge / Samsung Internet on **Android** | Full WebOTP. A permission prompt the first time, then the code fills itself in. |
| **iOS** Safari, Chrome, Firefox | No programmatic API. `autocomplete="one-time-code"` makes QuickType offer the code above the keyboard — one tap. |
| Desktop Chrome / Edge | `OTPCredential` exists but there is no SMS, so the request would hang forever. `isSupported()` is `false` and `mount()` does not arm it. Typing and paste work. |
| Firefox, Safari on macOS | No WebOTP. Typing and paste work. |
| Node / SSR | Import is safe. `isSupported()` is `false`, `mount()` throws a typed `unsupported` error, `serverHint()` and `validateSmsBody()` work normally. |

This is progressive enhancement, not a polyfill. **The input always works.** Auto-fill is the bonus
on top, and there is no code path that only exists on Android.

## Recipes

### Resend, without leaking a request

```js
import { listen } from 'otp-catch';

let listener = null;

async function requestCode(phone) {
  listener?.abort();                       // optional: listen() would replace it anyway
  await fetch('/api/send-code', { method: 'POST', body: JSON.stringify({ phone }) });
  listener = listen({
    onCode: (code) => verify(code),
    onError: (err) => { if (err.code !== 'aborted') report(err); },
  });
}
```

### Tie the request to a router transition

```js
const controller = new AbortController();
listen({ onCode: verify, signal: controller.signal });
router.afterEach(() => controller.abort());
```

### Use it inside a form

The real input lives in a shadow root, so it cannot be submitted directly. `mount()` also writes a
light-DOM `<input type="hidden" name={name}>`, which means `new FormData(form)` picks the code up
under the `name` you passed:

```js
mount('#otp', { name: 'code' });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = new FormData(form).get('code'); // '123456'
});
```

### An alphanumeric, 8-character code

```js
mount('#otp', {
  length: 8,
  charset: 'alphanumeric',   // [0-9a-zA-Z], uppercased for display
  placeholder: '•',
  size: '2.75rem',
  accent: '#7c3aed',
});
```

## Gotchas

### Why one input and not six

Six inputs is the obvious design and it is the wrong one. Autofill — both iOS QuickType and Android
WebOTP — delivers the entire code to a single field in a single event. With six inputs you get
`123456` in box one, five empty boxes, and a `maxlength="1"` that silently truncates it to `1`. You
then have to reimplement caret movement, backspace-across-boxes, select-all and paste distribution
by hand, and screen readers announce six unlabelled fields.

`mount()` renders one real `<input>` stretched over the boxes with `color: transparent` and
`caret-color: transparent`. Typing, Backspace, ArrowLeft/Right, Home/End, Ctrl/Cmd+A, undo and
autofill are all the browser's native behaviour. The boxes are `aria-hidden` decoration driven by
`input.value` and `input.selectionStart`, and a screen reader sees exactly one labelled field.

### The rest

- **HTTPS only.** WebOTP is secure-context gated. `localhost` counts, so local dev is fine.
- **One outstanding request per page.** A second `navigator.credentials.get({ otp })` rejects with
  `InvalidStateError`. `listen()` aborts the previous request instead — so if you call it twice, the
  *newest* call is the live one. Two components listening at once will fight; hoist it.
- **Cross-origin iframes** need `allow="otp-credentials"` on the `<iframe>`, and the SMS must be
  bound to the *iframe's* origin. Without the policy you get `NotAllowedError`.
- **The user still confirms.** WebOTP shows a browser prompt the first time; it is not silent
  auto-fill, and the user can decline.
- **The SMS must come from the origin you claim.** Anyone can send an SMS ending in
  `@yourdomain.com #123456` — the binding stops *your* codes leaking to other sites, it does not
  authenticate the sender. Rate-limit and expire codes server-side as usual.
- **The mounted styles live in a shadow root** on purpose, so your global CSS cannot reach them. Use
  the `accent` / `radius` / `gap` / `size` / `theme` options, or set the `--otp-*` custom properties
  on the host element, rather than trying to override with a selector.
- **`autoSubmit: false` means `onComplete` never fires automatically.** Read `instance.complete` in
  your own submit handler instead.
- **Desktop testing.** Because `isSupported()` is `false` on desktop, `mount()` will not arm WebOTP
  there — that is deliberate. To exercise the fill path, use `instance.setValue()` or a real phone.

## Contributing

```bash
git clone https://github.com/vishalmeena2211/otp-catch.git
cd otp-catch
npm install
npm run dev        # tsup --watch
npm test           # builds, then runs node:test against dist/
npm run typecheck
```

The demo in `demo/index.html` loads `dist/index.global.js` — build once, then serve the folder
(`npx serve .`) and open it. Serve it over HTTPS or `localhost` if you want to test the WebOTP path.

## License

MIT © Vishal Meena
