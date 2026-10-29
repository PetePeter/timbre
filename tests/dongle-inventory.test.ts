import { describe, expect, it, vi } from 'vitest';
import { combineDongleInventory, listUsbDongles, parsePnpOutput, parseProbeOutput } from '../src/phone/setup/dongle-inventory.js';

describe('USB dongle inventory', () => {
  it('parses supported IDs from bumble-usb-probe output', () => {
    expect(parseProbeOutput('Found device 0x10d7:0xb012\nUSB Bluetooth radio VID_0A12&PID_0001')).toEqual([
      { id: '10D7:B012', name: 'Found device' },
      { id: '0A12:0001', name: 'USB Bluetooth radio' },
    ]);
  });

  it('combines probe and Windows driver evidence', () => {
    const pnp = JSON.stringify([
      { InstanceId: 'USB\\VID_10D7&PID_B012\\1', FriendlyName: 'USB Bluetooth Radio', Class: 'Bluetooth', Service: 'libusbK' },
      { InstanceId: 'USB\\VID_1234&PID_ABCD\\2', FriendlyName: 'Bluetooth Adapter', Class: 'Bluetooth', Service: 'BTHUSB' },
    ]);
    const inventory = combineDongleInventory('Found 10D7:B012', pnp, 'win32');
    expect(inventory).toEqual([
      { id: '10D7:B012', name: 'USB Bluetooth Radio', driver: 'libusbK', probeAvailable: true },
      { id: '1234:ABCD', name: 'Bluetooth Adapter', driver: 'other', probeAvailable: false },
    ]);
  });

  it('reports driver verification as not applicable off Windows', () => {
    expect(combineDongleInventory('Found 10D7:B012', '', 'linux')[0]).toMatchObject({
      id: '10D7:B012', driver: 'not-applicable', probeAvailable: true,
    });
  });

  it('runs the probe and PnP query through an injectable command edge', async () => {
    const run = vi.fn(async (file: string) => file === 'probe.exe' ? 'Found 10D7:B012' : '[]');
    const result = await listUsbDongles('probe.exe', 'win32', run);
    expect(run).toHaveBeenNthCalledWith(1, 'probe.exe', [], 8000);
    expect(run).toHaveBeenNthCalledWith(2, 'powershell.exe', expect.any(Array), 8000);
    expect(result.dongles[0]).toMatchObject({ id: '10D7:B012', probeAvailable: true, driver: 'unknown' });
  });

  it('keeps PnP results and reports a missing probe executable', async () => {
    const run = vi.fn(async (file: string) => {
      if (file === 'probe.exe') throw Object.assign(new Error('not found'), { stdout: '' });
      return JSON.stringify([{ InstanceId: 'USB\\VID_10D7&PID_B012\\1', FriendlyName: 'Bluetooth Radio', Class: 'Bluetooth', Service: 'BTHUSB' }]);
    });
    const result = await listUsbDongles('probe.exe', 'win32', run);
    expect(result.probeError).toContain('not found');
    expect(result.dongles[0]).toMatchObject({ id: '10D7:B012', probeAvailable: false, driver: 'other' });
  });

  it('parses PnP arrays and single rows', () => {
    expect(parsePnpOutput('{"InstanceId":"USB\\\\VID_10D7&PID_B012\\\\1","FriendlyName":"Radio"}')).toHaveLength(1);
  });
});
