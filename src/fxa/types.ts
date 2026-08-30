/** Wire types for the Firefox Accounts auth server (v1). */

export interface FxAErrorBody {
  code?: number;
  errno?: number;
  error?: string;
  message?: string;
  retryAfter?: number;
  verificationMethod?: string;
  verificationReason?: string;
}

/** Auth-server errno values FireSync reacts to specifically. */
export const FXA_ERRNO = {
  ACCOUNT_UNKNOWN: 102,
  INCORRECT_PASSWORD: 103,
  UNVERIFIED_ACCOUNT: 104,
  INVALID_VERIFICATION_CODE: 105,
  INVALID_TOKEN: 110,
  INVALID_TIMESTAMP: 111,
  TOO_MANY_REQUESTS: 114,
  REQUEST_BLOCKED: 125,
  INVALID_UNBLOCK_CODE: 127,
  UNVERIFIED_SESSION: 138,
  TOTP_REQUIRED: 139,
  INSUFFICIENT_ACR: 170,
} as const;

export interface SignInResponse {
  uid: string;
  sessionToken: string;
  keyFetchToken?: string;
  verified: boolean;
  authAt?: number;
  verificationMethod?: 'email' | 'email-otp' | 'email-2fa' | 'email-captcha' | 'totp-2fa';
  verificationReason?: 'login' | 'signup';
}

export interface AccountKeysResponse {
  bundle: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: 'bearer';
  scope: string;
  auth_at?: number;
  keys_jwe?: string;
}

export interface ScopedKeyDataEntry {
  identifier: string;
  keyRotationSecret: string;
  keyRotationTimestamp: number;
}

export type ScopedKeyDataResponse = Record<string, ScopedKeyDataEntry>;

export interface DeviceResponse {
  id: string;
  name: string;
  type: string;
  pushEndpointExpired?: boolean;
}

export interface RecoveryEmailStatus {
  email: string;
  verified: boolean;
  sessionVerified: boolean;
  emailVerified: boolean;
}
