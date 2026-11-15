// ============================================================================
// Payloads (App -> Backend)
// ============================================================================

export interface RequestOtpPayload {
  email: string;
}

export interface VerifyOtpPayload {
  email: string;
  code: string;
}

// ============================================================================
// Responses (Backend -> App)
// ============================================================================

export interface RequestOtpResponse {
  status: 'success';
  message: string;
}

export interface VerifyOtpResponse {
  status: 'success';
  /** Firebase custom auth token — exchange with signInWithCustomToken. */
  customToken: string;
}

// ============================================================================
// Backend option types
// ============================================================================

/** Core OTP payload passed to `sendEmail`. */
export interface OtpEmailContext {
  to: string;
  /** The plaintext 6-digit code — only ever passed to the sender, never persisted. */
  code: string;
  /** Code lifetime in minutes, for the email copy. Rounded to the nearest minute from `expiryMs` — e.g. a 330_000 ms lifetime reports as 6. */
  expiresMinutes: number;
}

/** Inputs for {@link buildOtpEmail}. */
export interface OtpEmailInput extends OtpEmailContext {
  /** Brand name used in the email subject and body. */
  appName: string;
}

/** A fully composed OTP email, ready to dispatch. */
export interface OtpEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Delivers the OTP email. Projects provide their own sender.
 */
export type OtpEmailSender = (otp: OtpEmailContext) => Promise<void>;

/**
 * A secret resolved per call. Accepts a plain string, a getter function
 * (`defineSecret('X').value`), or a Firebase params Secret object
 * (`defineSecret('X')`) directly.
 */
export type SecretInput =
  string | (() => string) | { name?: string; value: () => string };

/** Base options shared by the request/verify factories. */
export interface BaseOtpOptions {
  /**
   * Required server-side HMAC-SHA256 secret used to hash OTP codes before
   * storage. Must match across `createRequestEmailOtp` and
   * `createVerifyEmailOtp`. Accepts a plain string, a getter function, or
   * `defineSecret('OTP_SECRET')`.
   */
  otpSecret: SecretInput;
  /** Firestore collection holding pending OTPs. Default: `auth_otps`. */
  collection?: string;
  /** Resend cooldown in ms. Default: 60_000. */
  cooldownMs?: number;
  /** Code lifetime in ms. Default: 600_000 (10 minutes). */
  expiryMs?: number;
  /** Failed verifications before the code is invalidated. Default: 5. */
  maxAttempts?: number;
  /**
   * Enforce App Check on the callable. Default: `true`. Set to `false` only for
   * local/emulator testing or environments where App Check is not configured —
   * leaving it off in production removes a key defense against scripted abuse.
   */
  enforceAppCheck?: boolean;
  /**
   * Extra secrets (e.g. `defineSecret('SENDGRID_API_KEY')`) to bind to the
   * callable so they can be resolved per call with `.value()`. Needed for any
   * secret besides `otpSecret` — the factory only auto-binds `otpSecret`
   * itself. Each entry may be a plain string, a getter, or a
   * `defineSecret(...)` param; only `defineSecret(...)` params are actually
   * bound onto the function.
   */
  extraSecrets?: SecretInput[];
}

export interface RequestOtpOptions extends BaseOtpOptions {
  /** Required. Delivers the OTP email via your chosen provider. */
  sendEmail: OtpEmailSender;
}

/**
 * Resolves (and, if needed, creates) the auth user for an email, returning
 * the uid the custom token will be minted for. This is the one required
 * project-specific hook — it owns the app's user schema.
 */
export type OtpProvisioner = (email: string) => Promise<string>;

export interface VerifyOtpOptions extends BaseOtpOptions {
  /** Required. Creates or resolves the user and returns their uid. */
  provision: OtpProvisioner;
}

export interface CleanupOtpOptions {
  /** Cloud Scheduler cron. Default: `every 15 minutes`. */
  schedule?: string;
  /** Collection to clean. Default: `auth_otps`. */
  collection?: string;
  /** Writes per batch. Default: 400 (Firestore limit is 500). */
  batchSize?: number;
}

// ============================================================================
// Stored document shape (Firestore `auth_otps/{email}`)
// ============================================================================

export interface OtpDocumentData {
  /** HMAC-SHA256 hex of `email:code`. The plaintext code is never stored. */
  hash: string;
  /** Failed guess counter. */
  attempts: number;
  /** Expiry as epoch milliseconds. */
  expiresAt: number;
  /** Last dispatch as epoch milliseconds (drives the resend cooldown). */
  lastSentAt: number;
  createdAt?: unknown;
}

// ============================================================================
// Error codes (HttpsError status codes used by the factories)
// ============================================================================

export const OTP_ERROR_CODES = {
  InvalidArgument: 'invalid-argument',
  NotFound: 'not-found',
  DeadlineExceeded: 'deadline-exceeded',
  ResourceExhausted: 'resource-exhausted',
  Internal: 'internal',
} as const;

export type OtpErrorCode =
  (typeof OTP_ERROR_CODES)[keyof typeof OTP_ERROR_CODES];
