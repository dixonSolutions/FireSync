/**
 * Extension-side client for the optional native messaging bridge.
 *
 * Every method fails soft: if the host is not installed — the normal case —
 * callers get `BridgeUnavailableError` and are expected to carry on without it.
 * Nothing in FireSync's core sync or autofill path calls into here.
 */

import {
  BRIDGE_HOST_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BridgeError,
  BridgeUnavailableError,
} from './protocol.ts';
import type {
  BridgeInfo,
  BridgeRequest,
  BridgeResponse,
  BridgeResultMap,
  FirefoxProfile,
  ImportedLogin,
} from './protocol.ts';

type Connector = (name: string) => chrome.runtime.Port;

export interface BridgeClientOptions {
  hostName?: string;
  connect?: Connector;
  /** How long any single call may take before it is abandoned. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to `chrome.runtime.lastError`. */
  lastError?: () => string | undefined;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient {
  private readonly hostName: string;
  private readonly connect: Connector;
  private readonly timeoutMs: number;
  private readonly lastError: () => string | undefined;

  private port: chrome.runtime.Port | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(options: BridgeClientOptions = {}) {
    this.hostName = options.hostName ?? BRIDGE_HOST_NAME;
    this.connect = options.connect ?? ((name: string) => chrome.runtime.connectNative(name));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.lastError = options.lastError ?? (() => chrome.runtime.lastError?.message);
  }

  /** Whether a host is present. Never throws. */
  async isAvailable(): Promise<boolean> {
    try {
      await this.info();
      return true;
    } catch {
      return false;
    }
  }

  async info(): Promise<BridgeInfo> {
    const info = await this.call('info', {});
    if (info.protocol !== BRIDGE_PROTOCOL_VERSION) {
      throw new BridgeError(
        `bridge speaks protocol ${info.protocol}; this build speaks ${BRIDGE_PROTOCOL_VERSION}`,
      );
    }
    return info;
  }

  /** Firefox profiles found on this machine. */
  async listProfiles(): Promise<FirefoxProfile[]> {
    return this.call('profile.list', {});
  }

  /**
   * Decrypt a Firefox profile's saved logins locally.
   *
   * No Mozilla account, no network, no OAuth — the one import path that depends
   * on nothing outside the user's own machine.
   */
  async importProfile(
    path: string,
    primaryPassword?: string,
  ): Promise<{ logins: ImportedLogin[]; skipped: number }> {
    return this.call('profile.import', {
      path,
      ...(primaryPassword !== undefined ? { primaryPassword } : {}),
    });
  }

  async keychainGet(account: string): Promise<string | null> {
    return (await this.call('keychain.get', { account })).secret;
  }

  async keychainSet(account: string, secret: string): Promise<void> {
    await this.call('keychain.set', { account, secret });
  }

  async keychainDelete(account: string): Promise<void> {
    await this.call('keychain.delete', { account });
  }

  /** RFC 8252 loopback OAuth. Requires a client id with a loopback redirect. */
  async loopbackOAuth(
    authorizationUrl: string,
    options: { redirectPath?: string; timeoutMs?: number } = {},
  ): Promise<{ code: string; state: string }> {
    return this.call('oauth.loopback', { authorizationUrl, ...options });
  }

  disconnect(): void {
    this.port?.disconnect();
    this.port = null;
    this.teardown(new BridgeError('bridge disconnected'));
  }

  // ------------------------------------------------------------------ internal

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;

    let port: chrome.runtime.Port;
    try {
      port = this.connect(this.hostName);
    } catch (cause) {
      throw new BridgeUnavailableError(`could not start the bridge: ${String(cause)}`);
    }

    port.onMessage.addListener((message: unknown) =>
      this.onMessage(message as BridgeResponse),
    );
    port.onDisconnect.addListener(() => {
      const reason = this.lastError() ?? 'bridge disconnected';
      this.port = null;
      this.teardown(
        /not found|not installed|Specified native messaging host|no such/i.test(reason)
          ? new BridgeUnavailableError(reason)
          : new BridgeError(reason),
      );
    });

    this.port = port;
    return port;
  }

  private onMessage(message: BridgeResponse): void {
    const entry = this.pending.get(message?.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new BridgeError(message.error, message.code));
  }

  private teardown(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private call<M extends keyof BridgeResultMap>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<BridgeResultMap[M]> {
    let port: chrome.runtime.Port;
    try {
      port = this.ensurePort();
    } catch (error) {
      return Promise.reject(error as Error);
    }

    const id = this.nextId++;
    const request = { id, method, ...params } as BridgeRequest;

    return new Promise<BridgeResultMap[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`bridge call ${method} timed out`, 'timeout'));
      }, this.timeoutMs);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      try {
        port.postMessage(request);
      } catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeUnavailableError(`could not reach the bridge: ${String(cause)}`));
      }
    });
  }
}
