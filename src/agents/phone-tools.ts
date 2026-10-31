/**
 * The tools a phone's LLM uses to act on its line. One definition serves both
 * kinds: an API LLM gets them as function tools, a CLI LLM over MCP.
 * Tool names match what PhoneBridge prompts ask for ("Reply with chat_send").
 */
import type { ToolSpec } from '../session/api/api-agent-loop.js';
import type { ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { CallAgentRequest } from '../phone/phone-bridge.js';
import type { AgentCallOutcome } from '../records/event-types.js';
import { randomUUID } from 'node:crypto';

/** The slice of PhoneLineService the tools drive. */
export interface PhoneLine {
  sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult>;
  hangup(sessionId: string): Promise<unknown>;
  inbox(): Promise<unknown>;
  startCallAgent(sessionId: string, req: CallAgentRequest): Promise<unknown>;
  transfer(fromSessionId: string, toSessionId: string, line: string): boolean | Promise<boolean>;
  enterMessageMode(sessionId: string): Promise<boolean> | boolean;
  reportCallOutcome(sessionId: string, interactionId: string, outcome: AgentCallOutcome): Promise<boolean> | boolean;
  verifyCaller(sessionId: string): Promise<string>;
  isCallerVerified(sessionId: string): boolean;
  recordAgentToolCall?(interactionId: string, toolName: string, outcome: 'started' | 'completed' | 'failed'): void;
}

export const PHONE_TOOLS: ToolSpec[] = [
  {
    name: 'verify_caller',
    description: 'Verify the current inbound caller with their contact PIN. This opens a keypad or spoken-digit challenge; never ask them to send their PIN in a message.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'chat_send',
    description: 'Say this into the live call, or text it back to the SMS named by interactionId from its [PHONE SMS] prompt.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        interactionId: { type: 'string', description: 'The SMS interaction ID from the [PHONE SMS] prompt being answered' },
      },
      required: ['text'],
    },
  },
  {
    name: 'phone_hangup',
    description: 'End the call you are holding.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'report_call_outcome',
    description: 'Report one outcome after the call has ended, using the interaction ID from the call-end notification.',
    parameters: {
      type: 'object',
      properties: {
        interactionId: { type: 'string', description: 'Interaction ID from the [PHONE] call-end notification' },
        outcome: { type: 'string', enum: ['left_message', 'confused', 'thought_human', 'spam', 'handed_over'] },
      },
      required: ['interactionId', 'outcome'],
    },
  },
  {
    name: 'phone_inbox',
    description: 'Read recent SMS the phone received (subject to the read policy).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'phone_call_agent',
    description: 'Dial a contact and let a call agent carry out a task on the call; you get its report.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Contact label or number' }, task: { type: 'string' },
        maxWaitMin: { type: 'number', description: 'Hang up after this many minutes without recognized speech; defaults to 3.' },
      },
      required: ['to', 'task'],
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
      },
      required: ['sessionId', 'line'],
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
export function phoneToolExecutor(line: PhoneLine, sessionId: string, handoverSessions?: ReadonlySet<string>) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => trackAgentToolCall(line, name, async () => {
    try {
      switch (name) {
        case 'chat_send': {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) return 'Error: text is required';
          const interactionId = typeof args.interactionId === 'string' ? args.interactionId : '';
          const r = await line.sendToSession({ sessionId, text, ...(interactionId.trim() ? { interactionId } : {}) });
          return r.sent ? 'sent' : `Error: not sent (${r.reason ?? 'unknown'})`;
        }
        case 'verify_caller': return await line.verifyCaller(sessionId);
        case 'phone_hangup': await line.hangup(sessionId); return 'hung up';
        case 'report_call_outcome': {
          const interactionId = typeof args.interactionId === 'string' ? args.interactionId.trim() : '';
          const outcome = args.outcome;
          if (!interactionId) return 'Error: interactionId is required';
          if (typeof outcome !== 'string' || !['left_message', 'confused', 'thought_human', 'spam', 'handed_over'].includes(outcome)) {
            return 'Error: invalid outcome';
          }
          return await line.reportCallOutcome(sessionId, interactionId, outcome as AgentCallOutcome)
            ? 'outcome reported'
            : 'Error: call outcome was not accepted';
        }
        case 'phone_inbox':
          if (!line.isCallerVerified(sessionId)) return 'Error: caller verification required';
          return JSON.stringify(await line.inbox());
        case 'phone_call_agent': {
          if (!line.isCallerVerified(sessionId)) return 'Error: caller verification required';
          const req: CallAgentRequest = { to: String(args.to ?? ''), task: String(args.task ?? '') };
          if (typeof args.maxWaitMin === 'number') req.maxWaitMin = args.maxWaitMin;
          return JSON.stringify(await line.startCallAgent(sessionId, req));
        }
        case 'call_transfer': {
          const target = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
          const intro = typeof args.line === 'string' ? args.line.trim() : '';
          if (!target || !intro) return 'Error: sessionId and line are required';
          if (handoverSessions && !handoverSessions.has(target)) return 'Error: sessionId is not an available handover target';
          return await line.transfer(sessionId, target, intro) ? 'transferred' : 'Error: call could not be transferred';
        }
        default: return `Error: unknown tool ${name}`;
      }
    } catch (err) {
      return `Error: ${(err as Error).message}`;
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
