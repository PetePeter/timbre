import type { HubLine } from '../../src/hub.js';

/** A disabled phone line for tests that exercise the server or hub, not the phone. */
export function idleLine(): HubLine {
  return {
    async apply() {}, async stop() {}, async restart() {}, async testSms() { return { sent: true }; },
    async sendSms() { return { sent: false, reason: 'unused' }; },
    getStatus: () => ({ enabled: false, process: { state: 'stopped' }, pendingRestart: false, line: null, configPath: '' }),
    async sendToSession() { return { sent: true }; }, async hangup() { return 'hung up'; }, async inbox() { return []; },
    async startCallAgent() { return {}; },
    async startOwnerCallAgent() { throw new Error('unused'); },
    async verifyCaller() { return ''; }, isCallerVerified() { return false; }, isCallHolder() { return false; },
    transfer() { return false; }, enterMessageMode() { return false; }, reportCallOutcome() { return false; },
  };
}
