import { sendSmsAction } from '../../src/actions/phone-actions.js';
import type { PhoneEntry } from '../../src/config/timbre-config.js';
import type { Hub } from '../../src/hub.js';
import type { PhoneBridge, PhoneBridgeDeps } from '../../src/phone/phone-bridge.js';
import type { PhoneLineConfig } from '../../src/phone/phone-config.js';
import type { PhoneSmsActionRequest } from '../../src/phone/sms-auto-reply.js';
import type { ChatSendResult } from '../../src/session/chat/chat-bridge.js';

/** Exercise the real action wrapper while keeping tests independent of Hub startup. */
export function phoneActionSmsSender(
  getBridge: () => PhoneBridge,
  phoneId: string,
  getConfig: () => PhoneLineConfig,
): NonNullable<PhoneBridgeDeps['sendSmsAction']> {
  const phone = { id: phoneId, line: getConfig() } as PhoneEntry;
  const hub = {
    line: () => {
      const bridge = getBridge();
      return {
        sendSms: (contact: Parameters<PhoneBridge['sendSms']>[0], text: string, interactionId?: string, clientName?: string) =>
          bridge.sendSms(contact, text, interactionId, clientName),
        sendSmsFromAction: (contact: Parameters<PhoneBridge['sendSms']>[0], text: string, interactionId: string | undefined, clientName: string | undefined, authorization: NonNullable<PhoneSmsActionRequest['autoReply']>) =>
          bridge.sendSms(contact, text, interactionId, clientName, authorization),
      };
    },
  } as unknown as Hub;
  return (request: PhoneSmsActionRequest): Promise<ChatSendResult> => {
    phone.line = getConfig();
    return sendSmsAction({ hub }, phone, request.to, request.text, request.clientName, request.autoReply, request.interactionId);
  };
}
