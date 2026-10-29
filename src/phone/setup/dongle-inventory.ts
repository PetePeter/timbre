import { execFile } from 'node:child_process';
import { platform } from 'node:os';

export type DongleDriver = 'libusbK' | 'other' | 'unknown' | 'not-applicable';

export interface UsbDongle {
  id: string;
  name: string;
  driver: DongleDriver;
  probeAvailable: boolean;
  inUseBy?: string;
}

interface PnpDevice {
  id: string;
  name: string;
  class: string;
  service: string;
  provider: string;
  infName: string;
}

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runCommand: CommandRunner = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) {
      Object.assign(error, { stdout });
      reject(error);
    } else resolve(stdout);
  });
});

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

export function parseProbeOutput(output: string): Array<{ id: string; name: string }> {
  const found = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const id = idFromText(line);
    if (!id) continue;
    const name = line.replace(/\b(?:0x)?[0-9a-f]{4}\s*:\s*(?:0x)?[0-9a-f]{4}\b/i, '')
      .replace(/\bVID_[0-9a-f]{4}&PID_[0-9a-f]{4}\b/i, '').replace(/[\s:;,()\[\]-]+/g, ' ').trim();
    found.set(id, name || 'USB Bluetooth dongle');
  }
  return [...found].map(([id, name]) => ({ id, name }));
}

export function parsePnpOutput(output: string): PnpDevice[] {
  let raw: unknown;
  try { raw = JSON.parse(output || '[]'); } catch { return []; }
  const values = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const byId = new Map<string, PnpDevice>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const instanceId = String(row.InstanceId ?? row.DeviceID ?? '');
    const id = idFromText(instanceId);
    if (!id) continue;
    byId.set(id, {
      id,
      name: String(row.FriendlyName ?? row.DeviceName ?? '').trim(),
      class: String(row.Class ?? row.ClassName ?? '').trim(),
      service: String(row.Service ?? '').trim(),
      provider: String(row.DriverProviderName ?? row.Provider ?? '').trim(),
      infName: String(row.InfName ?? '').trim(),
    });
  }
  return [...byId.values()];
}

export function combineDongleInventory(
  probeOutput: string,
  pnpOutput = '',
  osPlatform = platform(),
): UsbDongle[] {
  const probe = new Map(parseProbeOutput(probeOutput).map((device) => [device.id, device]));
  const pnp = new Map(parsePnpOutput(pnpOutput).map((device) => [device.id, device]));
  const ids = new Set([...probe.keys(), ...[...pnp.values()]
    .filter((device) => /bluetooth/i.test(`${device.class} ${device.name}`) || /libusbk/i.test(`${device.service} ${device.provider} ${device.infName}`))
    .map((device) => device.id)]);

  return [...ids].sort().map((id) => {
    const found = probe.get(id);
    const device = pnp.get(id);
    const binding = `${device?.service} ${device?.provider} ${device?.infName}`;
    const driver = osPlatform !== 'win32'
      ? 'not-applicable'
      : !device ? 'unknown'
        : /libusbk/i.test(binding) ? 'libusbK' : 'other';
    return {
      id,
      name: device?.name || found?.name || 'USB Bluetooth dongle',
      driver,
      probeAvailable: !!found,
    };
  });
}

const PNP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$drivers = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue
$rows = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}' } | ForEach-Object {
  $instanceId = $_.InstanceId
  $service = ''
  try { $service = (Get-PnpDeviceProperty -InstanceId $instanceId -KeyName 'DEVPKEY_Device_Service' -ErrorAction Stop).Data } catch {}
  $driver = $drivers | Where-Object { $_.DeviceID -eq $instanceId } | Select-Object -First 1
  [pscustomobject]@{ InstanceId = $instanceId; FriendlyName = $_.FriendlyName; Class = $_.Class; Service = $service; DriverProviderName = $driver.DriverProviderName; InfName = $driver.InfName }
}
$rows | ConvertTo-Json -Compress
`;

export interface DongleInventoryResult { dongles: UsbDongle[]; probeError?: string }

export async function listUsbDongles(
  probeExecutable = 'bumble-usb-probe',
  osPlatform = platform(),
  run: CommandRunner = runCommand,
): Promise<DongleInventoryResult> {
  let probeOutput = '';
  let probeError: string | undefined;
  try { probeOutput = await run(probeExecutable, [], 8000); }
  catch (err) {
    const stdout = String((err as { stdout?: unknown }).stdout ?? '');
    probeOutput = stdout;
    probeError = (err as Error).message;
  }

  let pnpOutput = '';
  if (osPlatform === 'win32') {
    try { pnpOutput = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PNP_SCRIPT], 8000); }
    catch { /* Windows driver status is unknown if PnP inspection is unavailable. */ }
  }

  return { dongles: combineDongleInventory(probeOutput, pnpOutput, osPlatform), ...(probeError ? { probeError } : {}) };
}
