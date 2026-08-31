/**
 * The typed message protocol between content scripts, extension pages, and the
 * background service worker.
 *
 * One rule underpins the whole design: **vault contents never travel to a
 * content script unless that content script asked for a specific page's
 * matches, and even then only the fields the menu needs.** A content script
 * runs alongside hostile JavaScript; treat it as semi-trusted at best.
 */

import type { PasswordRecord } from '../sync15/engines/passwords.ts';
import type { SyncResult } from '../sync15/engine.ts';
import type { GlobalPreferences, SitePreferences } from '../prefs/types.ts';
import type { BridgeInfo, FirefoxProfile } from '../bridge/protocol.ts';
import type { UpdateState } from '../update/types.ts';
import type { AuthCheckReport } from '../sync15/authcheck.ts';
import type { SignInProgress, SignInResult } from '../background/signin.ts';

/** A credential summary safe to hand to a content script. */
export interface CredentialSummary {
  id: string;
  username: string;
  origin: string;
  /** Only ever populated in the response to an explicit fill request. */
  password?: string;
}

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  /** 'device' needs no passphrase and never locks; 'passphrase' is opt-in. */
  protection: 'device' | 'passphrase';
  connected: boolean;
  email: string | null;
  counts: { passwords: number; addresses: number; creditcards: number; pendingUploads: number } | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
}

export interface CapturedCredential {
  pageUrl: string;
  origin: string;
  username: string;
  password: string;
  formActionOrigin: string | null;
  usernameField: string;
  passwordField: string;
  /** Set when the captured password differs from a stored one. */
  existingCredentialId?: string;
}

export type Message =
  | { type: 'vault/status' }
  | { type: 'vault/unlock'; passphrase: string }
  | { type: 'vault/lock' }
  | { type: 'vault/setPassphrase'; passphrase: string | null; current?: string }
  | { type: 'vault/reset' }
  | { type: 'account/signInHosted'; email?: string }
  | { type: 'account/signInProgress' }
  | { type: 'account/diagnostics' }
  | { type: 'account/authCheck' }
  | { type: 'signin/redirect'; url: string }
  | { type: 'account/cancelSignIn' }
  | { type: 'account/connect'; email: string; password: string; unblockCode?: string }
  | { type: 'account/submitTotp'; code: string }
  | { type: 'account/submitEmailCode'; code: string }
  | { type: 'account/resendEmailCode' }
  | { type: 'account/disconnect' }
  | { type: 'sync/now' }
  | { type: 'passwords/list' }
  | { type: 'passwords/get'; id: string }
  | { type: 'passwords/delete'; id: string }
  | { type: 'passwords/update'; id: string; patch: Partial<PasswordRecord> }
  | { type: 'autofill/query'; pageUrl: string }
  | { type: 'autofill/reveal'; id: string; pageUrl: string }
  | { type: 'autofill/captured'; credential: CapturedCredential }
  | { type: 'autofill/save'; credential: CapturedCredential }
  | { type: 'autofill/updateExisting'; id: string; password: string }
  | { type: 'prefs/global' }
  | { type: 'prefs/setGlobal'; patch: Partial<GlobalPreferences> }
  | { type: 'prefs/forUrl'; pageUrl: string }
  | { type: 'prefs/setForUrl'; pageUrl: string; patch: Partial<SitePreferences> }
  | { type: 'prefs/neverSave'; pageUrl: string }
  | { type: 'updates/status' }
  | { type: 'updates/check' }
  | { type: 'updates/dismiss'; version: string }
  | { type: 'bridge/status' }
  | { type: 'bridge/import'; path: string; primaryPassword?: string }
  | { type: 'menu/resize'; height: number }
  | { type: 'menu/close' };

/** Response payload keyed by message type. */
export interface ResponseMap {
  'vault/status': VaultStatus;
  'vault/unlock': VaultStatus;
  'vault/lock': VaultStatus;
  'vault/setPassphrase': VaultStatus;
  'vault/reset': VaultStatus;
  'account/signInHosted': { step: string };
  'account/signInProgress': SignInProgress;
  'account/diagnostics': SignInResult | null;
  'account/authCheck': AuthCheckReport;
  'signin/redirect': null;
  'account/cancelSignIn': SignInProgress;
  'account/connect': { step: string; email?: string };
  'account/submitTotp': { step: string };
  'account/submitEmailCode': { step: string };
  'account/resendEmailCode': null;
  'account/disconnect': VaultStatus;
  'sync/now': SyncResult;
  'passwords/list': CredentialSummary[];
  'passwords/get': PasswordRecord | null;
  'passwords/delete': null;
  'passwords/update': PasswordRecord;
  'autofill/query': {
    matches: CredentialSummary[];
    unlocked: boolean;
    inlineMenu: string;
    autoFill: boolean;
  };
  'autofill/reveal': CredentialSummary | null;
  'autofill/captured': { shouldPrompt: boolean; existingCredentialId?: string };
  'autofill/save': { id: string };
  'autofill/updateExisting': { id: string };
  'prefs/global': GlobalPreferences;
  'prefs/setGlobal': GlobalPreferences;
  'prefs/forUrl': SitePreferences | null;
  'prefs/setForUrl': SitePreferences;
  'prefs/neverSave': SitePreferences;
  'updates/status': UpdateReport;
  'updates/check': UpdateReport;
  'updates/dismiss': UpdateReport;
  'bridge/status': BridgeStatus;
  'bridge/import': ImportSummary;
  'menu/resize': null;
  'menu/close': null;
}

/** Everything the UI needs to render the update panel. */
export interface UpdateReport {
  currentVersion: string;
  state: UpdateState;
  /** Whether the user should be nudged right now. */
  notify: boolean;
  /** True when Chrome manages updates for us (policy-installed builds). */
  managedByBrowser: boolean;
}

/** What the optional native bridge can do on this machine, if it is installed. */
export interface BridgeStatus {
  available: boolean;
  info: BridgeInfo | null;
  profiles: FirefoxProfile[];
  /** Why it is unavailable, when it is. Shown verbatim in settings. */
  reason: string | null;
}

export interface ImportSummary {
  imported: number;
  /** Already present with the same origin and username. */
  duplicates: number;
  /** Records the bridge could not decrypt. */
  skipped: number;
}

export type Success<T> = { ok: true; data: T };
export type Failure = { ok: false; error: string; code?: string };
export type Reply<T> = Success<T> | Failure;

/** Messages pushed from the background out to content scripts and pages. */
export type Broadcast =
  | { type: 'state/locked' }
  | { type: 'state/unlocked' }
  | { type: 'state/synced'; result: SyncResult }
  | { type: 'state/signedin' }
  | { type: 'menu/fill'; credential: CredentialSummary };

export function ok<T>(data: T): Success<T> {
  return { ok: true, data };
}

export function fail(error: unknown, code?: string): Failure {
  const message = error instanceof Error ? error.message : String(error);
  return code ? { ok: false, error: message, code } : { ok: false, error: message };
}

/** Typed `chrome.runtime.sendMessage`. */
export async function sendMessage<M extends Message>(
  message: M,
): Promise<ResponseMap[M['type']]> {
  const reply = (await chrome.runtime.sendMessage(message)) as
    | Reply<ResponseMap[M['type']]>
    | undefined;
  if (!reply) throw new Error('the FireSync background worker did not respond');
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
