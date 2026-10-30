import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PhoneLineTransport, VirtualCallLine } from '../src/phone/virtual-call-line.js';

class FakePhysicalLine extends EventEmitter {
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  isConnected() { return true; }
  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, params });
    return {} as T;
  }
}

afterEach(() => vi.useRealTimers());

describe('VirtualCallLine', () => {
  it('runs a text caller through ringing, answer, utterance, reply, and hangup events', async () => {
    const line = new VirtualCallLine({ callerNumber: '+61491570156' });
    const events: Array<Record<string, unknown>> = [];
    line.on('event', (event) => events.push(event));
    line.start();

    await line.request('call.answer', { callId: line.callId });
    line.submitUtterance('Please read {Ctrl+C} as caller text.');
    await line.request('call.say', { callId: line.callId, text: 'I can help with that.' });
    await line.request('call.hangup', { callId: line.callId });

    expect(events.map((event) => event.type)).toEqual([
      'call.ringing', 'call.state', 'call.utterance', 'call.state',
    ]);
    expect(events.every((event) => event.test === true)).toBe(true);
    expect(line.transcript()).toEqual([
      { speaker: 'caller', text: 'Please read {Ctrl+C} as caller text.' },
      { speaker: 'agent', text: 'I can help with that.' },
    ]);
  });

  it('replays buffered events to one SSE subscriber and rejects a second stream', () => {
    const line = new VirtualCallLine({ callerNumber: '+61491570156' });
    line.start();
    const first: Array<Record<string, unknown>> = [];
    const close = line.openStream((event) => first.push(event));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'state', state: 'ringing' });
    expect(() => line.openStream(() => {})).toThrow(/one stream/i);
    close();
  });

  it('ends an idle test call within the ten-minute cap', () => {
    vi.useFakeTimers();
    const line = new VirtualCallLine({ callerNumber: '+61491570156', idleTimeoutMs: 10 * 60_000 + 1 });
    const states: string[] = [];
    line.on('stream', (event) => { if (event.type === 'state') states.push(event.state); });
    line.start();
    expect(line.idleTimeoutMs).toBeLessThanOrEqual(10 * 60_000);
    vi.advanceTimersByTime(10 * 60_000);
    expect(states).toEqual(['ringing', 'ended']);
  });
});

describe('PhoneLineTransport test-call sandbox', () => {
  it('does not reject or forward a physical incoming call during a virtual call', () => {
    const physical = new FakePhysicalLine();
    const transport = new PhoneLineTransport(physical);
    const virtual = new VirtualCallLine({ callerNumber: '+61491570156' });
    const forwarded: Array<Record<string, unknown>> = [];
    transport.on('event', (event) => forwarded.push(event));
    transport.attachTestCall(virtual);

    physical.emit('event', {
      seq: 1, ts: '2026-10-30T00:00:00.000Z', type: 'call.ringing',
      callId: 'physical-incoming', number: '+61491570187',
    });

    expect(physical.requests).toEqual([]);
    expect(forwarded).toEqual([]);
    transport.dispose();
  });

  it('routes virtual call requests and blocks hardware dial, SMS, and conference requests', async () => {
    const physical = new FakePhysicalLine();
    const transport = new PhoneLineTransport(physical);
    const virtual = new VirtualCallLine({ callerNumber: '+61491570156' });
    transport.attachTestCall(virtual);
    virtual.start();

    await transport.request('call.answer', { callId: virtual.callId });
    await expect(transport.request('call.dial', { number: '+61491570187' })).rejects.toThrow(/test call/i);
    await expect(transport.request('sms.send', { number: '+61491570187', text: 'blocked' })).rejects.toThrow(/test call/i);
    await expect(transport.request('conference.create', { number: '+61491570187' })).rejects.toThrow(/test call/i);

    expect(physical.requests).toEqual([]);
    transport.detachTestCall(virtual.callId);
    await transport.request('sms.send', { number: '+61491570187', text: 'normal call' });
    expect(physical.requests).toHaveLength(1);
  });
});
