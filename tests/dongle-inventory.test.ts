import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { combineDongleInventory, listUsbDongles, parsePnpOutput, parseProbeOutput } from '../src/phone/setup/dongle-inventory.js';

const realProbeOutput = readFileSync(new URL('./fixtures/bumble-usb-probe-windows.txt', import.meta.url), 'utf8');

describe('USB dongle inventory', () => {
  it('parses supported IDs from bumble-usb-probe output', () => {
    expect(parseProbeOutput('Found device 0x10d7:0xb012\nUSB Bluetooth radio VID_0A12&PID_0001')).toEqual([
      { id: '10D7:B012', name: 'Found device' },
      { id: '0A12:0001', name: 'USB Bluetooth radio', isBluetooth: true },
    ]);
  });

  it('combines probe and Windows driver evidence', () => {
    const pnp = JSON.stringify([
      { InstanceId: 'USB\\VID_10D7&PID_B012\\1', FriendlyName: 'USB Bluetooth Radio', Class: 'Bluetooth', Service: 'libusbK' },
      { InstanceId: 'USB\\VID_1234&PID_ABCD\\2', FriendlyName: 'Bluetooth Adapter', Class: 'Bluetooth', Service: 'BTHUSB' },
    ]);
    const inventory = combineDongleInventory('Found 10D7:B012', pnp, 'win32');
    expect(inventory).toEqual([
      { id: '10D7:B012', name: 'USB Bluetooth Radio', driver: 'libusbK', driverService: 'libusbK', probeAvailable: true },
      { id: '1234:ABCD', name: 'Bluetooth Adapter', driver: 'BTHUSB', driverService: 'BTHUSB', probeAvailable: false, inUseBy: 'Windows' },
    ]);
  });

  it.each([
    ['WinUSB', 'WinUSB'],
    ['libusbK', 'libusbK'],
    ['libusb0', 'libusb0'],
  ])('recognizes the supported %s service for 10D7:B012', (service, driver) => {
    const pnp = JSON.stringify([{
      InstanceId: 'USB\\VID_10D7&PID_B012\\DEVICE',
      FriendlyName: 'general adapter',
      Class: 'Bluetooth',
      Service: service,
    }]);
    expect(combineDongleInventory('Found 10D7:B012', pnp, 'win32')).toEqual([{
      id: '10D7:B012', name: 'general adapter', driver, driverService: service, probeAvailable: true,
    }]);
  });

  it('reports driver verification as not applicable off Windows', () => {
    expect(combineDongleInventory('ID 10D7:B012\nClass: Wireless Controller\nSubclass/Protocol: 1/1 [Bluetooth]', '', 'linux')[0]).toMatchObject({
      id: '10D7:B012', driver: 'not-applicable', probeAvailable: true,
    });
  });

  it('runs the probe and PnP query through an injectable command edge', async () => {
    const run = vi.fn(async (file: string, _args: readonly string[], _timeoutMs: number) => file === 'probe.exe'
      ? 'ID 10D7:B012\nClass: Wireless Controller\nSubclass/Protocol: 1/1 [Bluetooth]'
      : JSON.stringify([{ PNPDeviceID: 'USB\\VID_10D7&PID_B012\\DEVICE', Name: 'general adapter', PNPClass: 'libusbk devices', Service: 'libusbK' }]));
    const result = await listUsbDongles('probe.exe', 'win32', run);
    expect(run).toHaveBeenNthCalledWith(1, 'probe.exe', [], 8000);
    expect(run).toHaveBeenNthCalledWith(2, 'powershell.exe', expect.any(Array), 15000);
    expect(run.mock.calls[1][1]?.at(-1)).toContain('Win32_PnPEntity');
    expect(result.dongles[0]).toMatchObject({ id: '10D7:B012', name: 'general adapter', probeAvailable: true, driver: 'libusbK' });
  });

  it('keeps PnP results and reports a missing probe executable', async () => {
    const run = vi.fn(async (file: string) => {
      if (file === 'probe.exe') throw Object.assign(new Error('not found'), { stdout: '' });
      return JSON.stringify([{ PNPDeviceID: 'USB\\VID_10D7&PID_B012\\1', Name: 'Bluetooth Radio', PNPClass: 'Bluetooth', Service: 'BTHUSB' }]);
    });
    const result = await listUsbDongles('probe.exe', 'win32', run);
    expect(result.probeError).toContain('not found');
    expect(result.dongles[0]).toMatchObject({ id: '10D7:B012', probeAvailable: false, driver: 'BTHUSB', inUseBy: 'Windows' });
  });

  it('returns the PnP query failure instead of silently marking the driver unknown', async () => {
    const run = vi.fn(async (file: string) => {
      if (file === 'probe.exe') return 'ID 10D7:B012\nSubclass/Protocol: 1/1 [Bluetooth]';
      throw Object.assign(new Error('PowerShell command failed'), { stdout: '', stderr: 'WMI access denied' });
    });
    const result = await listUsbDongles('probe.exe', 'win32', run);
    expect(result.pnpError).toBe('WMI access denied');
    expect(result.dongles[0]).toMatchObject({ id: '10D7:B012', probeAvailable: true, driver: 'unknown' });
  });

  it('parses PnP arrays and single rows', () => {
    expect(parsePnpOutput('{"PNPDeviceID":"USB\\\\VID_10D7&PID_B012\\\\1","Name":"Radio","PNPClass":"Bluetooth","Service":"BTHUSB"}')).toHaveLength(1);
  });

  it('parses the real ANSI Bumble listing and filters to the two Bluetooth controllers', () => {
    const probe = parseProbeOutput(realProbeOutput);
    expect(probe.find((device) => device.id === '10D7:B012')).toMatchObject({
      id: '10D7:B012', name: 'general adapter', isBluetooth: true,
    });
    expect(probe.filter((device) => device.isBluetooth).map((device) => device.id)).toEqual(['8087:0029', '10D7:B012']);

    const pnp = JSON.stringify([
      { PNPDeviceID: 'USB\\VID_10D7&PID_B012\\<serial>', Name: 'general adapter', PNPClass: 'libusbk devices', Service: 'libusbK' },
      { PNPDeviceID: 'USB\\VID_8087&PID_0029\\<serial>', Name: 'Intel(R) Wireless Bluetooth(R)', PNPClass: 'Bluetooth', Service: 'BTHUSB' },
      { PNPDeviceID: 'USB\\VID_05AC&PID_12A8\\<serial>', Name: 'Apple iPhone', PNPClass: 'WPD', Service: 'WUDFWpdMtp' },
      { PNPDeviceID: 'USB\\VID_05E3&PID_0754\\<serial>', Name: 'USB Mass Storage Device', PNPClass: 'USB', Service: 'USBSTOR' },
      { PNPDeviceID: 'USB\\VID_1022&PID_15B9\\<serial>', Name: 'USB Hub', PNPClass: 'USB', Service: 'USBHUB3' },
    ]);
    expect(combineDongleInventory(realProbeOutput, pnp, 'win32')).toEqual([
      { id: '10D7:B012', name: 'general adapter', driver: 'libusbK', driverService: 'libusbK', probeAvailable: true },
      { id: '8087:0029', name: 'Intel(R) Wireless Bluetooth(R)', driver: 'BTHUSB', driverService: 'BTHUSB', probeAvailable: true, inUseBy: 'Windows' },
    ]);
  });
});
