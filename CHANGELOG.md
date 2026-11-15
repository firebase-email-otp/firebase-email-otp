# Changelog

## [2.0.0](https://github.com/firebase-email-otp/firebase-email-otp/compare/v1.0.1...v2.0.0) (2026-11-15)


### ⚠ BREAKING CHANGES

* the sendEmail callback now receives OtpEmailContext ({ to, code, expiresMinutes }) instead of the composed OtpEmail ({ to, subject, text, html }), and the required appName option is removed from createRequestEmailOtp. To keep the previous email, compose it inside sendEmail: buildOtpEmail({ ...otp, appName: 'MyApp' }).

### Features

* host-provided email templates ([#3](https://github.com/firebase-email-otp/firebase-email-otp/issues/3)) ([d441ddc](https://github.com/firebase-email-otp/firebase-email-otp/commit/d441ddc59e9a892f7b2a0f68d590055b2784ca8c))

## [1.0.1](https://github.com/firebase-email-otp/firebase-email-otp/compare/v1.0.0...v1.0.1) (2026-11-14)

* add package metadata and keywords ([2ca8764](https://github.com/firebase-email-otp/firebase-email-otp/commit/2ca8764c58fce1612ea189e32f9c6eaec516391a))
