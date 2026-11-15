import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpsError,
  type CallableFunction,
  type CallableRequest,
} from 'firebase-functions/https';
import {
  createMockFirestore,
  installFirestoreMock,
  type MockFirestore,
} from './test-mocks';
import { hashOtpCode } from '../../src/functions/crypto';

vi.mock('firebase-admin/firestore', () => {
  const g = globalThis as unknown as { __mockFirestore: MockFirestore };
  return {
    getFirestore: () => g.__mockFirestore.db,
    FieldValue: { serverTimestamp: () => '__server_timestamp__' },
  };
});

import { createRequestEmailOtp } from '../../src/functions/requestEmailOtp';
import {
  OTP_ERROR_CODES,
  type OtpEmailContext,
  type RequestOtpOptions,
  type RequestOtpPayload,
  type RequestOtpResponse,
} from '../../src/shared';

const NOW = Date.now();

type Handler = CallableFunction<RequestOtpPayload, Promise<RequestOtpResponse>>;

const invoke = (fn: Handler, data: unknown) =>
  fn.run({ data } as unknown as CallableRequest<RequestOtpPayload>);

/** Runs the handler, resolving to the thrown HttpsError instead of rejecting. */
const call = async (
  fn: Handler,
  data: unknown,
): Promise<RequestOtpResponse | HttpsError> =>
  invoke(fn, data).catch((e: unknown) => e as HttpsError);

const TEST_SECRET = 'test-otp-secret';

describe('createRequestEmailOtp', () => {
  let mock: MockFirestore;
  const sentEmails: OtpEmailContext[] = [];
  const sendEmail = vi.fn(async (otp: OtpEmailContext) => {
    sentEmails.push(otp);
  });

  beforeEach(() => {
    mock = createMockFirestore();
    installFirestoreMock(mock);
    sentEmails.length = 0;
    sendEmail.mockClear();
  });

  const factory = (extra: Partial<RequestOtpOptions> = {}) =>
    createRequestEmailOtp({
      otpSecret: TEST_SECRET,
      sendEmail,
      ...extra,
    });

  it('writes a valid OTP doc and delivers the OTP payload to sendEmail', async () => {
    const res = await invoke(factory(), { email: ' User@Example.com ' });

    expect(res).toEqual({
      status: 'success',
      message: 'Verification code sent.',
    });

    // doc keyed by normalized email
    const doc = mock.store.get('auth_otps/user@example.com');
    expect(doc).toBeDefined();
    expect(doc!.attempts).toBe(0);
    const lastSentAt = doc!.lastSentAt as number;
    expect(lastSentAt).toBeGreaterThan(NOW - 5000);
    expect(doc!.expiresAt).toBe(lastSentAt + 600_000);
    expect(doc!.createdAt).toBe('__server_timestamp__');

    // sendEmail invoked with a 6-digit code, and the stored hash matches it
    expect(sentEmails).toHaveLength(1);
    const { to, code, expiresMinutes } = sentEmails[0]!;
    expect(to).toBe('user@example.com');
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresMinutes).toBe(10);
    expect(doc!.hash).toBe(hashOtpCode('user@example.com', code, TEST_SECRET));
  });

  it('rejects missing or malformed emails without side effects', async () => {
    const missing = await call(factory(), {});
    expect(missing).toBeInstanceOf(HttpsError);
    expect((missing as HttpsError).code).toBe(OTP_ERROR_CODES.InvalidArgument);

    const malformed = await call(factory(), { email: 'not-an-email' });
    expect((malformed as HttpsError).code).toBe(
      OTP_ERROR_CODES.InvalidArgument,
    );

    expect(mock.store.size).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('suppresses the send during the 60s cooldown and returns the uniform success shape (no recency oracle)', async () => {
    // simulate a doc sent 30s ago
    mock.store.set('auth_otps/a@b.com', {
      hash: 'x',
      attempts: 0,
      expiresAt: Date.now() + 600_000,
      lastSentAt: Date.now() - 30_000,
    });

    const res = await invoke(factory(), { email: 'a@b.com' });
    // Throttled requests look identical to real dispatches so callers cannot
    // tell whether a code was recently requested for this email.
    expect(res).toEqual({
      status: 'success',
      message: 'Verification code sent.',
    });
    // No new email is delivered and the existing doc is left untouched.
    expect(sendEmail).not.toHaveBeenCalled();
    expect(sentEmails).toHaveLength(0);
    expect(mock.store.get('auth_otps/a@b.com')!.hash).toBe('x');
  });

  it('allows a resend once the cooldown has elapsed', async () => {
    mock.store.set('auth_otps/a@b.com', {
      hash: 'x',
      attempts: 9,
      expiresAt: Date.now() - 1,
      lastSentAt: Date.now() - 61_000,
    });

    await invoke(factory(), { email: 'a@b.com' });
    const doc = mock.store.get('auth_otps/a@b.com');
    expect(doc!.attempts).toBe(0); // fresh doc
    expect(sentEmails).toHaveLength(1);
  });

  it('enforces the resend cooldown atomically across concurrent requests', async () => {
    const fn = factory();
    const results = await Promise.all([
      invoke(fn, { email: 'a@b.com' }),
      invoke(fn, { email: 'a@b.com' }),
      invoke(fn, { email: 'a@b.com' }),
    ]);

    // All three resolve to the success shape (one real dispatch, two throttled),
    // but exactly one email is actually delivered.
    for (const res of results) {
      expect(res).toEqual({
        status: 'success',
        message: 'Verification code sent.',
      });
    }
    expect(sentEmails).toHaveLength(1);
  });

  it('deletes the doc and throws internal when delivery fails', async () => {
    const failing = createRequestEmailOtp({
      otpSecret: TEST_SECRET,
      sendEmail: async () => {
        throw new Error('email delivery failed');
      },
    });

    const err = await call(failing, { email: 'a@b.com' });
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe(OTP_ERROR_CODES.Internal);
    expect(mock.store.has('auth_otps/a@b.com')).toBe(false);
  });

  it('does not delete a newer OTP doc when a stale delivery fails', async () => {
    const newerHash = hashOtpCode('a@b.com', '999999', TEST_SECRET);
    const staleFailure = createRequestEmailOtp({
      otpSecret: TEST_SECRET,
      sendEmail: async () => {
        // Simulate another request overwriting the OTP doc while this delivery was in flight
        mock.store.set('auth_otps/a@b.com', {
          hash: newerHash,
          attempts: 0,
          expiresAt: Date.now() + 600_000,
          lastSentAt: Date.now(),
        });
        throw new Error('delayed email delivery timeout');
      },
    });

    const err = await call(staleFailure, { email: 'a@b.com' });
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe(OTP_ERROR_CODES.Internal);

    // The newer OTP doc must remain intact
    const remainingDoc = mock.store.get('auth_otps/a@b.com');
    expect(remainingDoc).toBeDefined();
    expect(remainingDoc!.hash).toBe(newerHash);
  });

  it('fails fast at factory time when sendEmail is missing', () => {
    expect(() =>
      createRequestEmailOtp({
        otpSecret: TEST_SECRET,
      } as RequestOtpOptions),
    ).toThrow(/`sendEmail` is required/);
  });

  it('honors custom collection/cooldown/expiry options', async () => {
    await invoke(
      factory({
        collection: 'custom_otps',
        cooldownMs: 120_000,
        expiryMs: 300_000,
      }),
      { email: 'a@b.com' },
    );

    const doc = mock.store.get('custom_otps/a@b.com');
    expect(doc).toBeDefined();
    const customLastSentAt = doc!.lastSentAt as number;
    expect(doc!.expiresAt).toBe(customLastSentAt + 300_000);
    expect(sentEmails[0]!.expiresMinutes).toBe(5);
  });

  it('auto-binds Firebase SecretParam objects from otpSecret onto onCall options', () => {
    const fn = createRequestEmailOtp({
      otpSecret: { name: 'CUSTOM_OTP_HMAC', value: () => TEST_SECRET },
      sendEmail,
    }) as unknown as {
      __endpoint?: { secretEnvironmentVariables?: { key: string }[] };
    };

    expect(fn.__endpoint?.secretEnvironmentVariables).toEqual([
      { key: 'CUSTOM_OTP_HMAC' },
    ]);
  });

  it('binds extraSecrets onto the onCall options alongside otpSecret', () => {
    const fn = createRequestEmailOtp({
      otpSecret: { name: 'CUSTOM_OTP_HMAC', value: () => TEST_SECRET },
      extraSecrets: [
        { name: 'SENDGRID_API_KEY', value: () => 'sg-test' },
        // plain string / getter entries are accepted but never bound
        'not-a-param',
        () => 'getter',
      ],
      sendEmail,
    }) as unknown as {
      __endpoint?: { secretEnvironmentVariables?: { key: string }[] };
    };

    expect(fn.__endpoint?.secretEnvironmentVariables).toEqual([
      { key: 'CUSTOM_OTP_HMAC' },
      { key: 'SENDGRID_API_KEY' },
    ]);
  });

  it('de-dupes a secret passed as both otpSecret and extraSecrets', () => {
    const otpSecret = { name: 'CUSTOM_OTP_HMAC', value: () => TEST_SECRET };
    const fn = createRequestEmailOtp({
      otpSecret,
      extraSecrets: [otpSecret],
      sendEmail,
    }) as unknown as {
      __endpoint?: { secretEnvironmentVariables?: { key: string }[] };
    };

    expect(fn.__endpoint?.secretEnvironmentVariables).toEqual([
      { key: 'CUSTOM_OTP_HMAC' },
    ]);
  });
});
