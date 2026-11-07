import type { PhoneAgent } from '../agents/phone-agent.js';
import type { PhoneLine } from '../agents/phone-tools.js';

export interface AgentLine extends PhoneLine {
  isCallHolder(sessionId: string): boolean;
}

export interface AgentLineSlot {
  line: AgentLine;
  agent: PhoneAgent | null;
}

/** Routes one agent's tools across its owning line and the line holding a transferred call. */
export class AgentLineRouter {
  constructor(
    private readonly slots: ReadonlyMap<string, AgentLineSlot>,
    private readonly isConfigured: (phoneId: string) => boolean,
  ) {}

  forPhone(phoneId: string): PhoneLine {
    const own = () => this.slots.get(phoneId)?.line;
    const active = (sessionId: string) => {
      for (const slot of this.slots.values()) if (slot.line.isCallHolder(sessionId)) return slot.line;
      return undefined;
    };
    return {
      sendToSession: (message) => (active(message.sessionId) ?? own())?.sendToSession(message)
        ?? Promise.resolve({ sent: false, reason: 'phone line unavailable' }),
      hangup: (sessionId) => (active(sessionId) ?? own())?.hangup(sessionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      inbox: () => own()?.inbox() ?? Promise.resolve([]),
      hasContact: (name, sessionId) => (sessionId ? active(sessionId) : undefined)?.hasContact?.(name) ?? own()?.hasContact?.(name) ?? false,
      sendSmsToContact: (sessionId, name, text, authorization) => (active(sessionId) ?? own())?.sendSmsToContact?.(sessionId, name, text, authorization)
        ?? Promise.resolve({ sent: false, reason: 'phone line unavailable' }),
      startCallAgent: (sessionId, request, smsInteractionId) => (smsInteractionId ? own() : active(sessionId) ?? own())?.startCallAgent(sessionId, request, smsInteractionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      authorizeSmsAction: (sessionId, interactionId, consumeMcpAction) => own()?.authorizeSmsAction?.(sessionId, interactionId, consumeMcpAction)
        ?? { required: true, allowed: false, refusal: 'SMS action authorization is unavailable.' },
      authorizeSmsReply: (sessionId, sourceInteractionId, replyInteractionId, consumeMcpAction) => own()?.authorizeSmsReply?.(sessionId, sourceInteractionId, replyInteractionId, consumeMcpAction)
        ?? { required: true, allowed: false, refusal: 'SMS reply authorization is unavailable.' },
      refuseSmsAction: (sessionId, interactionId, refusal) => own()?.refuseSmsAction?.(sessionId, interactionId, refusal)
        ?? Promise.resolve(),
      verifyCaller: (sessionId) => (active(sessionId) ?? own())?.verifyCaller(sessionId)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      isCallerVerified: (sessionId) => (active(sessionId) ?? own())?.isCallerVerified(sessionId) ?? false,
      transfer: async (from, to, line) => {
        const target = this.slots.get(to);
        if (to === from || !target?.agent || !this.isConfigured(to)) return false;
        const source = active(from);
        if (!source) return false;
        return await source.transfer(from, to, line);
      },
      transferToContact: (sessionId, name) => (active(sessionId) ?? own())?.transferToContact?.(sessionId, name)
        ?? Promise.reject(new Error('Phone line unavailable.')),
      enterMessageMode: (sessionId) => active(sessionId)?.enterMessageMode(sessionId) ?? false,
      reportCallOutcome: async (sessionId, interactionId, outcome) => {
        for (const slot of this.slots.values()) {
          if (await slot.line.reportCallOutcome(sessionId, interactionId, outcome)) return true;
        }
        return false;
      },
      recordAgentToolCall: (interactionId, toolName, outcome) => {
        this.slots.get(phoneId)?.line.recordAgentToolCall?.(interactionId, toolName, outcome);
      },
    };
  }
}
