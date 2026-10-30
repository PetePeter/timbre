import { execFile } from 'node:child_process';
import { platform } from 'node:os';

export type DongleDriver = 'WinUSB' | 'libusbK' | 'libusb0' | 'BTHUSB' | 'other' | 'unknown' | 'not-applicable';

export interface UsbDongle {
  id: string;
  name: string;
  driver: DongleDriver;
  driverService?: string;
  probeAvailable: boolean;
  inUseBy?: string;
}

interface PnpDevice {
  id: string;
  name: string;
  class: string;
  service: string;
}

interface ProbeDevice { id: string; name: string; isBluetooth?: boolean }

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runCommand: CommandRunner = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      Object.assign(error, { stdout, stderr });
      reject(error);
    } else resolve(stdout);
  });
});

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replace(/^\uFEFF/, '');
}

function canonicalId(vid: string, pid: string): string {
  return `${vid.toUpperCase()}:${pid.toUpperCase()}`;
}

function idFromText(text: string): string | null {
  const pnp = /VID_([0-9a-f]{4})&PID_([0-9a-f]{4})/i.exec(text);
  if (pnp) return canonicalId(pnp[1], pnp[2]);
  const pair = /(?:0x)?([0-9a-f]{4})\s*:\s*(?:0x)?([0-9a-f]{4})/i.exec(text);
  if (pair) return canonicalId(pair[1], pair[2]);
  const named = /(?:VID|vendor(?:_id)?)\s*[=:]\s*(?:0x)?([0-9a-f]{4})[\s,;]+(?:PID|product(?:_id)?)\s*[=:]\s*(?:0x)?([0-9a-f]{4})/i.exec(text);
  return named ? canonicalId(named[1], named[2]) : null;
}

export function parseProbeOutput(output: string): ProbeDevice[] {
  const found = new Map<string, ProbeDevice>();
  let current: ProbeDevice | undefined;
  const saveCurrent = () => {
    if (current) found.set(current.id, current);
    current = undefined;
  };

  for (const line of stripAnsi(output).split(/\r?\n/)) {
    if (/^\s*ID\s+/i.test(line)) {
      saveCurrent();
      const id = idFromText(line);
      if (id) current = { id, name: 'USB Bluetooth dongle' };
      continue;
    }
    if (current) {
      const product = /^\s*Product\s*:\s*(.*?)\s*$/i.exec(line)?.[1];
      if (product) current.name = product;
      if (/\bBluetooth\b/i.test(line)) current.isBluetooth = true;
      continue;
    }
    const id = idFromText(line);
    if (!id) continue;
    const name = line.replace(/\b(?:0x)?[0-9a-f]{4}\s*:\s*(?:0x)?[0-9a-f]{4}\b/i, '')
      .replace(/\bVID_[0-9a-f]{4}&PID_[0-9a-f]{4}\b/i, '').replace(/[\s:;,()\[\]-]+/g, ' ').trim();
    found.set(id, { id, name: name || 'USB Bluetooth dongle', ...(/\bBluetooth\b/i.test(line) ? { isBluetooth: true } : {}) });
  }
  saveCurrent();
  return [...found.values()];
}

export function parsePnpOutput(output: string): PnpDevice[] {
  let raw: unknown;
  try { raw = JSON.parse(output || '[]'); } catch { return []; }
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const devices: PnpDevice[] = [];
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const pnpDeviceId = String(row.PNPDeviceID ?? row.InstanceId ?? row.DeviceID ?? '');
    const id = idFromText(pnpDeviceId);
    if (!id) continue;
    devices.push({
      id,
      name: String(row.Name ?? row.FriendlyName ?? row.DeviceName ?? '').trim(),
      class: String(row.PNPClass ?? row.Class ?? row.ClassName ?? '').trim(),
      service: String(row.Service ?? '').trim(),
    });
  }
  return devices;
}

function isBluetoothPnpDevice(device: PnpDevice): boolean {
  return /bluetooth/i.test(`${device.class} ${device.name}`) || /^(?:BTHUSB|BTHMINI|BTHPORT)$/i.test(device.service);
}

export function combineDongleInventory(
  probeOutput: string,
  pnpOutput = '',
  osPlatform = platform(),
): UsbDongle[] {
  const probe = new Map(parseProbeOutput(probeOutput).map((device) => [device.id, device]));
  const pnpRows = parsePnpOutput(pnpOutput);
  const pnp = new Map<string, PnpDevice[]>();
  for (const device of pnpRows) pnp.set(device.id, [...(pnp.get(device.id) ?? []), device]);
  const ids = new Set([
    ...[...probe.values()].filter((device) => device.isBluetooth).map((device) => device.id),
    ...pnpRows.filter(isBluetoothPnpDevice).map((device) => device.id),
  ]);

  return [...ids].sort().map((id) => {
    const found = probe.get(id);
    const rows = pnp.get(id) ?? [];
    const device = rows.find(isBluetoothPnpDevice) ?? rows.find((row) => row.service) ?? rows[0];
    const service = device?.service ?? '';
    const driver = osPlatform !== 'win32'
      ? 'not-applicable'
      : !device || !service ? 'unknown'
        : /^winusb$/i.test(service) ? 'WinUSB'
          : /^libusbk$/i.test(service) ? 'libusbK'
            : /^libusb0$/i.test(service) ? 'libusb0'
              : /^bthusb$/i.test(service) ? 'BTHUSB' : 'other';
    return {
      id,
      name: device?.name || found?.name || 'USB Bluetooth dongle',
      driver,
      ...(service ? { driverService: service } : {}),
      probeAvailable: !!found,
      ...(driver === 'BTHUSB' ? { inUseBy: 'Windows' } : {}),
    };
  });
}

const PNP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$rows = Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\VID_%'" |
  Select-Object PNPDeviceID, Name, PNPClass, Service
$rows | ConvertTo-Json -Compress
`;

export interface DongleInventoryResult { dongles: UsbDongle[]; probeError?: string; pnpError?: string }

function commandErrorMessage(err: unknown): string {
  const error = err as { message?: unknown; stderr?: unknown };
  const detail = String(error.stderr ?? '').trim() || String(error.message ?? err);
  return stripAnsi(detail).trim();
}

export async function listUsbDongles(
  probeExecutable = 'bumble-usb-probe',
  osPlatform = platform(),
  run: CommandRunner = runCommand,
): Promise<DongleInventoryResult> {
  let probeOutput = '';
  let probeError: string | undefined;
  try { probeOutput = await run(probeExecutable, [], 8000); }
  catch (err) {
    const failure = err as { stdout?: unknown };
    probeOutput = String(failure.stdout ?? '');
    probeError = commandErrorMessage(err);
  }

  let pnpOutput = '';
  let pnpError: string | undefined;
  if (osPlatform === 'win32') {
    try { pnpOutput = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PNP_SCRIPT], 15000); }
    catch (err) {
      pnpOutput = String((err as { stdout?: unknown }).stdout ?? '');
      pnpError = commandErrorMessage(err);
    }
  }

  return {
    dongles: combineDongleInventory(probeOutput, pnpOutput, osPlatform),
    ...(probeError ? { probeError } : {}),
    ...(pnpError ? { pnpError } : {}),
  };
}
