import {
  getSubscriptionsErrorMessage,
  type SubscriptionsError,
} from '../generated/index.js';

/** Base error class for the Subscriptions SDK, carrying a machine-readable `code`. */
export class SubscriptionsSDKError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SubscriptionsSDKError';
    this.code = code;
  }
}

/** Wraps an on-chain program error code, resolving it to a human-readable message. */
export class ProgramError extends SubscriptionsSDKError {
  readonly errorCode: number;

  constructor(errorCode: number) {
    const message = getSubscriptionsErrorMessage(
      errorCode as SubscriptionsError,
    );
    super(message || `Program error: ${errorCode}`, 'PROGRAM_ERROR');
    this.name = 'ProgramError';
    this.errorCode = errorCode;
  }
}

/** Client-side validation failure (e.g. max destinations exceeded). */
export class ValidationError extends SubscriptionsSDKError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}
