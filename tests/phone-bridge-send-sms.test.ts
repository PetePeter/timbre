import { afterEach, describe, expect, it } from 'vitest';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import type { RecordEvent } from '../src/records/event-types.js';
import { createPhoneBridgeFixture } from './helpers/phone-bridge-fixture.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

describe('PhoneBridge.sendSms', () => {
  it('keeps sms.out policy enforcement and records the client name on the single sent event', async () => {
    const events: RecordEvent[] = [];
    const cfg: PhoneLineConfig = resolvePhoneLineConfig({
      enabled: true, countryCode: '+61',
      contacts: [{ label: 'Owner', pattern: '+614915701*', role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: false }],
      limits: { smsPerHour: 5 },
    });
    const fixture = await createPhoneBridgeFixture({
      clientOptions: { clientVersion: 'test', heartbeatS: 30 },
      bridge: {
        phoneId: 'sms-test', getConfig: () => cfg, getOperatorId: () => 'owner', sessionName: () => 'Owner',
        deliver: async () => {}, defaultTranscriptDir: '.', recordingsDir: '.', smsPollMs: 0,
        recordEvent: (event) => events.push(event),
      },
    });
    cleanup.push(() => fixture.close());
    const { server, bridge } = fixture;

    await expect(bridge.sendSms({ ...cfg.contacts[0], pattern: '+61491570156' }, 'hello', 'rest:1', 'Calendar')).resolves.toEqual({ sent: true });
    await server.waitFor('sms.send');
    const sent = events.filter((event) => event.type === 'sms.sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ interactionId: 'rest:1', details: { contact: 'Owner', clientName: 'Calendar', action: 'sent' } });

    const denied = { ...cfg.contacts[0], smsOut: false, pattern: '+61400000000', label: 'Denied' };
    await expect(bridge.sendSms(denied, 'no')).resolves.toMatchObject({ sent: false });
    expect(events.filter((event) => event.type === 'sms.sent')).toHaveLength(1);
  });
});
