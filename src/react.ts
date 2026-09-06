/**
 * React adapter for otp-catch.
 *
 * Hooks only - no JSX in this file, so the package needs no JSX runtime and
 * React stays an optional peer dependency.
 *
 * ```tsx
 * import { useOtpInput, useWebOtp } from 'otp-catch/react';
 *
 * function CodeField({ onSubmit }) {
 *   const { value, inputProps, boxes, complete } = useOtpInput({ onComplete: onSubmit });
 *   useWebOtp({ onCode: (code) => onSubmit(code) });
 *   return (
 *     <label style={{ position: 'relative', display: 'inline-flex' }}>
 *       <span style={{ display: 'flex', gap: 8 }}>
 *         {boxes.map((box, i) => (
 *           <span key={i} data-active={box.active} className="otp-box">{box.char}</span>
 *         ))}
 *       </span>
 *       <input {...inputProps} aria-label="One-time passcode" className="otp-field" />
 *     </label>
 *   );
 * }
 * ```
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';

import { isSupported, listen, sanitizeInput } from './index';
import type { OtpCharset, OtpError, OtpListener } from './index';

/** Options for {@link useWebOtp}. */
export interface UseWebOtpOptions {
  /** Called with the code when a matching SMS arrives. */
  onCode(code: string): void;
  /** Arm the listener. Set to `false` to hold off (e.g. before the code is sent). Default `true`. */
  enabled?: boolean;
  /** Called with a typed error. Aborts are never reported. */
  onError?(err: OtpError): void;
}

/** What {@link useWebOtp} returns. */
export interface UseWebOtpResult {
  /** Whether this browser can auto-fill from SMS at all. `false` during SSR and on the first render. */
  supported: boolean;
  /** `true` while the browser is waiting for a matching SMS. */
  pending: boolean;
}

/**
 * Arm the WebOTP API for the lifetime of a component.
 *
 * Aborts on unmount and whenever `enabled` flips to `false`, so navigating away
 * mid-request never leaves a dangling outstanding request behind.
 */
export function useWebOtp(options: UseWebOtpOptions): UseWebOtpResult {
  const { enabled = true } = options;
  const [supported, setSupported] = useState(false);
  const [pending, setPending] = useState(false);

  const onCodeRef = useRef(options.onCode);
  const onErrorRef = useRef(options.onError);
  onCodeRef.current = options.onCode;
  onErrorRef.current = options.onError;

  // Never during render: on the server `isSupported()` is false, and a mismatch
  // between that and the client would break hydration.
  useEffect(() => {
    setSupported(isSupported());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!isSupported()) return;

    let listener: OtpListener | null = null;
    setPending(true);
    listener = listen({
      onCode: (code) => {
        setPending(false);
        onCodeRef.current(code);
      },
      onError: (err) => {
        setPending(false);
        const handler = onErrorRef.current;
        if (handler) handler(err);
      },
    });

    return () => {
      setPending(false);
      if (listener) listener.abort();
    };
  }, [enabled]);

  return { supported, pending };
}

/** Options for {@link useOtpInput}. */
export interface UseOtpInputOptions {
  /** Number of characters. Default `6`. */
  length?: number;
  /** Allowed characters. Default `'numeric'`. */
  charset?: OtpCharset;
  /** Fired once per completed code. */
  onComplete?(code: string): void;
}

/** Props to spread onto a real `<input>`. */
export interface OtpInputProps {
  value: string;
  type: 'text';
  /** The attribute that makes iOS QuickType offer the SMS code. Do not drop it. */
  autoComplete: 'one-time-code';
  inputMode: 'numeric' | 'text';
  pattern: string;
  maxLength: number;
  autoCapitalize: 'off' | 'characters';
  autoCorrect: 'off';
  spellCheck: false;
  onChange(event: ChangeEvent<HTMLInputElement>): void;
  onPaste(event: ClipboardEvent<HTMLInputElement>): void;
}

/** One rendered box. */
export interface OtpBox {
  /** The character in this box, or `''`. */
  char: string;
  /** `true` for the box the next character will land in. */
  active: boolean;
}

/** What {@link useOtpInput} returns. */
export interface UseOtpInputResult {
  /** The current code. */
  value: string;
  /** Replace the value; the string is sanitised and truncated first. */
  setValue(next: string): void;
  /** Empty the field. */
  clear(): void;
  /** `true` when every box is filled. */
  complete: boolean;
  /** Spread onto your `<input>`. */
  inputProps: OtpInputProps;
  /** Render these as your boxes. */
  boxes: OtpBox[];
}

/**
 * Controlled OTP input state: sanitising, paste handling, box derivation and a
 * once-per-code `onComplete`. Bring your own markup and styling.
 */
export function useOtpInput(options: UseOtpInputOptions = {}): UseOtpInputResult {
  const length = Number.isFinite(options.length) ? Math.max(1, Math.floor(options.length as number)) : 6;
  const charset: OtpCharset = options.charset === 'alphanumeric' ? 'alphanumeric' : 'numeric';

  const [value, setRawValue] = useState('');
  const completedRef = useRef<string | null>(null);
  const onCompleteRef = useRef(options.onComplete);
  onCompleteRef.current = options.onComplete;

  const setValue = useCallback(
    (next: string) => {
      setRawValue(sanitizeInput(next, { charset, length }));
    },
    [charset, length],
  );

  const clear = useCallback(() => setRawValue(''), []);

  useEffect(() => {
    if (value.length < length) {
      completedRef.current = null;
      return;
    }
    if (completedRef.current === value) return;
    completedRef.current = value;
    const handler = onCompleteRef.current;
    if (handler) handler(value);
  }, [value, length]);

  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setRawValue(sanitizeInput(event.target.value, { charset, length }));
    },
    [charset, length],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      setRawValue(sanitizeInput(event.clipboardData.getData('text'), { charset, length }));
    },
    [charset, length],
  );

  const inputProps = useMemo<OtpInputProps>(
    () => ({
      value,
      type: 'text',
      autoComplete: 'one-time-code',
      inputMode: charset === 'numeric' ? 'numeric' : 'text',
      pattern: charset === 'numeric' ? '[0-9]*' : '[0-9a-zA-Z]*',
      maxLength: length,
      autoCapitalize: charset === 'numeric' ? 'off' : 'characters',
      autoCorrect: 'off',
      spellCheck: false,
      onChange,
      onPaste,
    }),
    [value, charset, length, onChange, onPaste],
  );

  const boxes = useMemo<OtpBox[]>(() => {
    const activeIndex = Math.min(value.length, length - 1);
    const out: OtpBox[] = [];
    for (let i = 0; i < length; i += 1) {
      out.push({ char: value[i] ?? '', active: i === activeIndex });
    }
    return out;
  }, [value, length]);

  return { value, setValue, clear, complete: value.length === length, inputProps, boxes };
}

export type { OtpCharset, OtpError, OtpListener } from './index';
