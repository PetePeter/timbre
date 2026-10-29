export type PairingState =
  | 'idle'
  | 'discoverable'
  | 'awaiting-confirmation'
  | 'pairing'
  | 'paired'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'failed';

export interface PairedPhone { address: string; name?: string }

export interface PairingStatus {
  pairingId?: string;
  state: PairingState;
  deviceName?: string;
  phone?: PairedPhone;
  numericCode?: string;
  expiresAt?: string;
  error?: { code: string; message: string };
}

export interface PairingStart {
  pairingId: string;
  state: 'discoverable';
  deviceName: string;
  expiresAt: string;
}

export interface PairingConfirmation {
  pairingId: string;
  address: string;
  numericCode: string;
  accept: boolean;
}

export interface PairingConfirmationResult {
  pairingId: string;
  state: 'pairing' | 'paired' | 'rejected';
  phone?: PairedPhone;
}

export interface TelefonySetupApi {
  startPairing(timeoutSeconds?: number): Promise<PairingStart>;
  pairingStatus(): Promise<PairingStatus>;
  confirmPairing(input: PairingConfirmation): Promise<PairingConfirmationResult>;
  cancelPairing(pairingId: string): Promise<PairingStatus>;
}

export class TelefonyAdminError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Server-side client for telefony-app's loopback-only setup API. */
export class TelefonyAdminClient implements TelefonySetupApi {
  private readonly baseUrl: string;

  constructor(port: number, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  startPairing(timeoutSeconds = 120): Promise<PairingStart> {
    return this.request('/api/setup/pairing', 'POST', { timeoutSeconds });
  }

  pairingStatus(): Promise<PairingStatus> {
    return this.request('/api/setup/pairing', 'GET');
  }

  confirmPairing(input: PairingConfirmation): Promise<PairingConfirmationResult> {
    return this.request('/api/setup/pairing/confirm', 'POST', input);
  }

  cancelPairing(pairingId: string): Promise<PairingStatus> {
    return this.request('/api/setup/pairing/cancel', 'POST', { pairingId });
  }

  private async request<T>(route: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(method === 'POST' ? { 'content-type': 'application/json', 'x-telefony': '1' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new TelefonyAdminError(503, `telefony setup API unavailable: ${(err as Error).message}`);
    }
    const payload = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) {
      const message = typeof payload.error === 'string' ? payload.error : response.statusText || 'telefony setup request failed';
      throw new TelefonyAdminError(response.status, message);
    }
    return payload as T;
  }
}
