/**
 * The tools a phone's LLM uses to act on its line. One definition serves both
 * kinds: an API LLM gets them as function tools, a CLI LLM over MCP.
 * Tool names match what PhoneBridge prompts ask for ("Reply with chat_send").
 */
import type { ToolSpec } from '../session/api/api-agent-loop.js';
import type { ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { CallAgentRequest, ContactTransferResult } from '../phone/phone-bridge.js';
import type { SmsActionAuthorizationResult, SmsReplyAuthorizationResult } from '../phone/sms-pin-auth.js';
import type { SmsConversationContext } from './phone-agent.js';
import type { AgentCallOutcome } from '../records/event-types.js';
import { randomUUID } from 'node:crypto';

/** The slice of PhoneLineService the tools drive. */
export interface PhoneLine {
  sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult>;
  hangup(sessionId: string): Promise<string>;
  inbox(): Promise<unknown>;
  hasContact?(name: string, sessionId?: string): boolean;
  sendSmsToContact?(sessionId: string, name: string, text: string, authorization?: SmsActionAuthorizationResult): Promise<ChatSendResult>;
  startCallAgent(sessionId: string, req: CallAgentRequest, smsInteractionId?: string): Promise<unknown>;
  transfer(fromSessionId: string, toSessionId: string, line: string): boolean | Promise<boolean>;
  transferToContact?(sessionId: string, name?: string): Promise<ContactTransferResult>;
  enterMessageMode(sessionId: string): Promise<boolean> | boolean;
  reportCallOutcome(sessionId: string, interactionId: string, outcome: AgentCallOutcome): Promise<boolean> | boolean;
  verifyCaller(sessionId: string): Promise<string>;
  isCallerVerified(sessionId: string): boolean;
  authorizeSmsAction?(sessionId: string, interactionId: string, consumeMcpAction?: boolean): SmsActionAuthorizationResult;
  authorizeSmsReply?(sessionId: string, sourceInteractionId: string, replyInteractionId: string, consumeMcpAction?: boolean): SmsReplyAuthorizationResult;
  refuseSmsAction?(sessionId: string, interactionId: string, refusal?: string): Promise<void>;
  recordAgentToolCall?(interactionId: string, toolName: string, outcome: 'started' | 'completed' | 'failed'): void;
}

export const PHONE_TOOLS: ToolSpec[] = [
  {
    name: 'verify_caller',
    description: 'Manually open a keypad or spoken-digit PIN challenge only if Timbre has not already verified this inbound caller. Never ask them to send their PIN in a message.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_contact',
    description: 'After caller verification, answer only yes or no: does a contact with this name exist? Never reveal a phone number or other contact details.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Contact name' } }, required: ['name'] },
  },
  {
    name: 'chat_send',
    description: 'Say this into the live call or reply by SMS. For SMS, omit interactionId to reply to the current sender; sending to another sender requires that SMS contact PIN.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        interactionId: { type: 'string', description: 'Optional SMS interaction ID. Omit to reply to the current sender; another sender requires the current SMS PIN.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'phone_hangup',
    description: 'End the call you are holding. The first use asks the caller whether there is anything else; use it again only after they clearly confirm they are done.',
    parameters: { type: 'object', properties: { smsInteractionId: { type: 'string', description: 'SMS interaction ID from the [PHONE SMS] prompt' } } },
  },
  {
    name: 'report_call_outcome',
    description: 'Report one outcome for this call. For left_message, confirm the message and report it before goodbye or hangup.',
    parameters: {
      type: 'object',
      properties: {
        interactionId: { type: 'string', description: 'Interaction ID from the [PHONE] call briefing or call-end notification' },
        smsInteractionId: { type: 'string', description: 'SMS interaction ID from the [PHONE SMS] prompt' },
        outcome: { type: 'string', enum: ['left_message', 'confused', 'thought_human', 'spam', 'handed_over'] },
      },
      required: ['interactionId', 'outcome'],
    },
  },
  {
    name: 'phone_inbox',
    description: 'Read recent SMS the phone received (subject to the read policy).',
    parameters: { type: 'object', properties: { smsInteractionId: { type: 'string', description: 'SMS interaction ID from the [PHONE SMS] prompt' } } },
  },
  {
    name: 'phone_call_agent',
    description: 'After caller verification, dial a named contact and let a call agent carry out a task; you get its report. Use a contact name, never a phone number.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Contact name as listed in the phone book' }, task: { type: 'string' },
        smsInteractionId: { type: 'string', description: 'SMS interaction ID from the [PHONE SMS] prompt' },
        maxWaitMin: { type: 'number', description: 'Hang up after this many minutes without recognized speech; defaults to 2.' },
      },
      required: ['to', 'task'],
    },
  },
  {
    name: 'phone_send_sms',
    description: 'After caller verification, send an SMS to a named contact. For an SMS conversation, the same-message contact PIN is required. Never use or reveal phone numbers.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact name as listed in the phone book' },
        text: { type: 'string', description: 'Message text' },
        smsInteractionId: { type: 'string', description: 'SMS interaction ID from the [PHONE SMS] prompt' },
      },
      required: ['name', 'text'],
    },
  },
  {
    name: 'call_transfer',
    description: 'Hand the current call to another configured phone session, with this short spoken introduction.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Configured phone session ID to receive the call' },
        line: { type: 'string', description: 'Short introduction spoken as the call transfers' },
        smsInteractionId: { type: 'string', description: 'SMS interaction ID from the [PHONE SMS] prompt' },
      },
      required: ['sessionId', 'line'],
    },
  },
  {
    name: 'transfer_to_contact',
    description: 'Transfer the current caller to a marked phone-book transfer target. Omit name for the default catch-all. If they do not answer, the caller returns to you: apologize, take and confirm a message, report left_message, then hang up.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact name of a marked phone-book transfer target; omit for the default.' } },
    },
  },
];

/** Selects from the one canonical registry; handover mode cannot see full-mode tools. */
export function phoneToolsForMode(mode: 'handover' | 'full'): ToolSpec[] {
  if (mode === 'full') return PHONE_TOOLS;
  const allowed = new Set(['verify_caller', 'chat_send', 'phone_hangup', 'call_transfer', 'report_call_outcome']);
  return PHONE_TOOLS.filter((tool) => allowed.has(tool.name));
}

/** Runs a tool for one phone session; failures come back as text the model can read. */
export function phoneToolExecutor(
  line: PhoneLine,
  sessionId: string,
  handoverSessions?: ReadonlySet<string>,
  smsContext?: SmsConversationContext,
  allowImplicitSmsAuthorization = true,
) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => trackAgentToolCall(line, name, async () => {
    try {
      const smsAction = name !== 'chat_send' && name !== 'verify_caller';
      let smsAuthorization: SmsActionAuthorizationResult | undefined;
      if (smsAction) {
        const smsInteractionId = smsContext?.interactionId
          ?? (typeof args.smsInteractionId === 'string' ? args.smsInteractionId.trim() : '');
        if (smsContext?.kind === 'sms') {
          const decision = smsContext.actionAuthorization;
          const expired = smsContext.actionAuthorizationExpiresAt !== undefined
            && smsContext.actionAuthorizationExpiresAt <= Date.now();
          smsAuthorization = {
            required: true,
            allowed: !expired && decision?.allowed === true,
            refusal: expired
              ? 'This SMS action authorization expired. Resend the request with the contact PIN in the same SMS.'
              : decision?.refusal ?? 'Include the contact PIN in the same SMS to authorize privileged actions.',
          };
        } else if (allowImplicitSmsAuthorization && line.authorizeSmsAction) {
          smsAuthorization = line.authorizeSmsAction(sessionId, smsInteractionId, true);
        }
        if (smsAuthorization?.required && !smsAuthorization.allowed) {
          await line.refuseSmsAction?.(sessionId, smsAuthorization.sourceInteractionId ?? smsInteractionId, smsAuthorization.refusal);
          return `Error: ${smsAuthorization.refusal}`;
        }
      }
      if (name === 'verify_caller' && allowImplicitSmsAuthorization && line.authorizeSmsAction) {
        const smsInteractionId = typeof args.smsInteractionId === 'string' ? args.smsInteractionId.trim() : '';
        line.authorizeSmsAction(sessionId, smsInteractionId, true);
      }
      switch (name) {
        case 'chat_send': {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) return 'Error: text is required';
          let interactionId = typeof args.interactionId === 'string'
            ? args.interactionId
            : smsContext?.kind === 'sms' ? smsContext.interactionId : '';
          if (line.authorizeSmsReply && (allowImplicitSmsAuthorization || smsContext?.kind === 'sms')) {
            const sourceInteractionId = smsContext?.kind === 'sms' ? smsContext.interactionId : '';
            const authorization = line.authorizeSmsReply(sessionId, sourceInteractionId, interactionId.trim(), allowImplicitSmsAuthorization);
            if (authorization.required && !authorization.allowed) {
              await line.refuseSmsAction?.(sessionId, authorization.sourceInteractionId ?? '', authorization.refusal);
              return `Error: ${authorization.refusal}`;
            }
            if (!interactionId.trim() && authorization.replyInteractionId) interactionId = authorization.replyInteractionId;
          } else if (interactionId.trim() && smsContext?.kind !== 'sms' && !line.isCallerVerified(sessionId)) {
            return 'Error: caller verification required';
          }
          const r = await line.sendToSession({ sessionId, text, ...(interactionId.trim() ? { interactionId } : {}) });
          if (r.sent) return 'sent';
          if (r.reason?.startsWith('Call transferred to ')) return r.reason;
          return `Error: not sent (${r.reason ?? 'unknown'})`;
        }
        case 'verify_caller': return await line.verifyCaller(sessionId);
        case 'find_contact': {
          if (!(smsAuthorization?.required && smsAuthorization.allowed) && !line.isCallerVerified(sessionId)) return 'Error: caller verification required';
          const contactName = typeof args.name === 'string' ? args.name.trim() : '';
          return line.hasContact?.(contactName, sessionId) ? 'yes' : 'no';
        }
        case 'phone_hangup': return await line.hangup(sessionId);
        case 'report_call_outcome': {
          const interactionId = typeof args.interactionId === 'string' ? args.interactionId.trim() : '';
          const outcome = args.outcome;
          if (!interactionId) return 'Error: interactionId is required';
          if (typeof outcome !== 'string' || !['left_message', 'confused', 'thought_human', 'spam', 'handed_over'].includes(outcome)) {
            return 'Error: invalid outcome';
          }
          return await line.reportCallOutcome(sessionId, interactionId, outcome as AgentCallOutcome)
            ? 'outcome reported'
            : 'Call ended; outcome not recorded. Do not retry.';
        }
        case 'phone_inbox':
          if (!(smsAuthorization?.required && smsAuthorization.allowed) && !line.isCallerVerified(sessionId)) return 'Error: caller verification required';
          return JSON.stringify(await line.inbox());
        case 'phone_call_agent': {
          if (!(smsAuthorization?.required && smsAuthorization.allowed) && !line.isCallerVerified(sessionId)) return 'Error: caller verification required';
          const to = typeof args.to === 'string' ? args.to.trim() : '';
          if (!line.hasContact?.(to, sessionId)) return 'Error: contact name not found';
          const req: CallAgentRequest = { to, task: String(args.task ?? '') };
          if (typeof args.maxWaitMin === 'number') req.maxWaitMin = args.maxWaitMin;
          const smsInteractionId = smsContext?.kind === 'sms'
            ? smsContext.interactionId
            : typeof args.smsInteractionId === 'string' ? args.smsInteractionId.trim() : undefined;
          return JSON.stringify(await line.startCallAgent(sessionId, req, smsAuthorization?.required ? smsInteractionId : undefined));
        }
        case 'phone_send_sms': {
          if (!(smsAuthorization?.required && smsAuthorization.allowed) && !line.isCallerVerified(sessionId)) return 'Error: caller verification required';
          const contactName = typeof args.name === 'string' ? args.name.trim() : '';
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!contactName || !text) return 'Error: contact name and text are required';
          if (!line.hasContact?.(contactName, sessionId)) return 'Error: contact name not found';
          if (!line.sendSmsToContact) return 'Error: contact SMS is unavailable';
          const result = await line.sendSmsToContact(sessionId, contactName, text, smsAuthorization);
          return result.sent ? 'sent' : 'Error: SMS was not sent';
        }
        case 'call_transfer': {
          const target = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
          const intro = typeof args.line === 'string' ? args.line.trim() : '';
          if (!target || !intro) return 'Error: sessionId and line are required';
          if (handoverSessions && !handoverSessions.has(target)) return 'Error: sessionId is not an available handover target';
          return await line.transfer(sessionId, target, intro) ? 'transferred' : 'Error: call could not be transferred';
        }
        case 'transfer_to_contact': {
          const name = typeof args.name === 'string' ? args.name.trim() : undefined;
          if (args.name !== undefined && (typeof args.name !== 'string' || !name)) return 'Error: name must be a contact name';
          if (!line.transferToContact) return 'Error: phone-book transfers are unavailable';
          const result = await line.transferToContact(sessionId, name);
          return result.transferred
            ? `Call transferred to ${result.contactName}; you are off the call. Do not act further.`
            : `${result.contactName} did not answer. The caller is back on the line; apologize, take and confirm a message, report left_message, then hang up.`;
        }
        default: return `Error: unknown tool ${name}`;
      }
    } catch (err) {
      const message = (err as Error).message;
      return message.startsWith('Call transferred to ') ? message : `Error: ${message}`;
    }
  });
}

/** Records metadata around a tool call without retaining its arguments or result text. */
export async function trackAgentToolCall(line: PhoneLine, name: string, run: () => Promise<string>): Promise<string> {
  const interactionId = randomUUID();
  try { line.recordAgentToolCall?.(interactionId, name, 'started'); } catch { /* Activity logging must not block phone actions. */ }
  let outcome: 'completed' | 'failed' = 'completed';
  try {
    const result = await run();
    if (result.startsWith('Error:')) outcome = 'failed';
    return result;
  } catch (err) {
    outcome = 'failed';
    return `Error: ${(err as Error).message}`;
  } finally {
    try { line.recordAgentToolCall?.(interactionId, name, outcome); } catch { /* Activity logging is best effort. */ }
  }
}
