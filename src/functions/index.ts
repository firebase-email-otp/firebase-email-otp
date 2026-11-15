// Firebase Cloud Functions entry.
// Import from 'firebase-email-otp/functions' in your project's
// functions/src/index.ts and register the returned handlers as exports.

export { createRequestEmailOtp } from './requestEmailOtp';
export { createVerifyEmailOtp } from './verifyEmailOtp';
export { createCleanupExpiredOtps } from './cleanupExpiredOtps';
export { generateOtpCode, hashOtpCode, isOtpHashMatch } from './crypto';
export { buildOtpEmail } from '../shared';
