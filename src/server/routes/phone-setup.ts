import type { IncomingMessage, ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { PhoneEntry } from '../../config/timbre-config.js';
import { listUsbDongles, type DongleInventoryResult, type UsbDongle } from '../../phone/setup/dongle-inventory.js';
import { readTelefonyAdminToken, telefonyAdminPort } from '../../phone/setup/telefony-admin.js';
import {
  TelefonyAdminClient, TelefonyAdminError,
  type PairingConfirmation, type TelefonySetupApi,
} from '../../phone/setup/telefony-admin-client.js';

export type PhoneSetupRoute =
  | { action: 'dongles' }
  | { action: 'pairing-start' | 'pairing-status' | 'pairing-confirm' | 'pairing-cancel'; phoneId: string };

export function matchPhoneSetupRoute(pathname: string): PhoneSetupRoute | null {
  if (pathname === '/api/phone-setup/dongles') return { action: 'dongles' };
  const match = /^\/api\/phones\/([\w-]+)\/setup\/pairing(?:\/(start|confirm|cancel))?$/.exec(pathname);
  if (!match) return null;
  const suffix = match[2];
  return {
    phoneId: match[1],
    action: suffix === 'start' ? 'pairing-start'
      : suffix === 'confirm' ? 'pairing-confirm'
        : suffix === 'cancel' ? 'pairing-cancel' : 'pairing-status',
  };
}

export interface PhoneSetupRouteOptions {
  phones: PhoneEntry[];
  telefonyExecutable: string;
  dataDir: string;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  listDongles?: (probeExecutable?: string) => Promise<DongleInventoryResult>;
  clientForPhone?: (phone: PhoneEntry) => Promise<TelefonySetupApi>;
}

const json = (res: ServerResponse, status: number, body: unknown): true => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
};

function selectedDongle(transport: string): string | null {
  const match = /^usb:([0-9a-f]{4}):([0-9a-f]{4})(?:\+sco=\d+)?$/i.exec(transport.trim());
  return match ? `${match[1].toUpperCase()}:${match[2].toUpperCase()}` : null;
}

async function isAdminPortAvailable(phone: PhoneEntry, phones: PhoneEntry[], dataDir: string): Promise<boolean> {
  const port = await telefonyAdminPort(phone.id, path.join(dataDir, 'phones'));
  return phone.line.port !== port && !phones.some((other) => other.id !== phone.id && other.line.port === port);
}

async function defaultClient(phone: PhoneEntry, dataDir: string): Promise<TelefonySetupApi> {
  const configPath = path.join(dataDir, 'phones', phone.id, 'telefony.toml');
  const token = await readTelefonyAdminToken(configPath);
  if (!token) throw new TelefonyAdminError(503, 'telefony setup API is not ready');
  return new TelefonyAdminClient(await telefonyAdminPort(phone.id, path.join(dataDir, 'phones')), token);
}

export async function handlePhoneSetupRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: PhoneSetupRoute,
  options: PhoneSetupRouteOptions,
): Promise<boolean> {
  if (route.action === 'dongles') {
    if (req.method !== 'GET' && req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    let executable = options.telefonyExecutable;
    if (req.method === 'POST') {
      const body = await options.readJson(req) as { executable?: unknown };
      const requestedExecutable = typeof body.executable === 'string' ? body.executable.trim() : body.executable;
      if (requestedExecutable !== undefined && requestedExecutable !== '') {
        if (typeof requestedExecutable !== 'string') {
          return json(res, 400, { error: 'executable must be an existing executable file' });
        }
        try {
          if (!(await stat(requestedExecutable)).isFile()) return json(res, 400, { error: 'executable must be an existing executable file' });
        } catch {
          return json(res, 400, { error: 'executable must be an existing executable file' });
        }
        executable = requestedExecutable;
      }
    }
    const probeName = process.platform === 'win32' ? 'bumble-usb-probe.exe' : 'bumble-usb-probe';
    const probeExecutable = executable ? path.join(path.dirname(executable), probeName) : probeName;
    const result = await (options.listDongles ?? listUsbDongles)(probeExecutable);
    const use = new Map<string, string>();
    for (const phone of options.phones) {
      const id = selectedDongle(phone.line.transport);
      if (id) use.set(id, phone.name || 'Another phone');
    }
    const dongles: UsbDongle[] = result.dongles.map((dongle) => ({ ...dongle, ...(use.has(dongle.id) ? { inUseBy: use.get(dongle.id) } : {}) }));
    return json(res, 200, {
      dongles,
      ...(result.probeError ? { probeError: result.probeError } : {}),
      ...(result.pnpError ? { pnpError: result.pnpError } : {}),
    });
  }

  const phone = options.phones.find((candidate) => candidate.id === route.phoneId);
  if (!phone) return json(res, 404, { error: 'phone not found' });
  if (!await isAdminPortAvailable(phone, options.phones, options.dataDir)) return json(res, 409, { error: 'telefony setup port conflicts with another phone; change the PhAP port' });

  const expectedMethod = route.action === 'pairing-status' ? 'GET' : 'POST';
  if (req.method !== expectedMethod) return json(res, 405, { error: 'method not allowed' });

  try {
    const client = await (options.clientForPhone ?? ((candidate) => defaultClient(candidate, options.dataDir)))(phone);
    if (route.action === 'pairing-status') return json(res, 200, await client.pairingStatus());

    const body = await options.readJson(req) as Record<string, unknown>;
    if (route.action === 'pairing-start') {
      const timeoutSeconds = body.timeoutSeconds ?? 120;
      if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300) {
        return json(res, 400, { error: 'timeoutSeconds must be an integer from 30 to 300' });
      }
      return json(res, 200, await client.startPairing(timeoutSeconds));
    }
    if (route.action === 'pairing-cancel') {
      if (typeof body.pairingId !== 'string' || !body.pairingId) return json(res, 400, { error: 'pairingId is required' });
      return json(res, 200, await client.cancelPairing(body.pairingId));
    }

    const confirmation: PairingConfirmation = {
      pairingId: typeof body.pairingId === 'string' ? body.pairingId : '',
      address: typeof body.address === 'string' ? body.address.toUpperCase() : '',
      numericCode: typeof body.numericCode === 'string' ? body.numericCode : '',
      accept: body.accept as boolean,
    };
    if (!confirmation.pairingId || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(confirmation.address)
      || !/^\d{6}$/.test(confirmation.numericCode) || typeof confirmation.accept !== 'boolean') {
      return json(res, 400, { error: 'pairingId, a Bluetooth address, six-digit code, and accept flag are required' });
    }
    return json(res, 200, await client.confirmPairing(confirmation));
  } catch (err) {
    if (err instanceof TelefonyAdminError) return json(res, err.status, { error: err.message });
    return json(res, 503, { error: `telefony setup API unavailable: ${(err as Error).message}` });
  }
}
