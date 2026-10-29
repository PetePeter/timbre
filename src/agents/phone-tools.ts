/**
 * The tools a phone's LLM uses to act on its line. One definition serves both
 * kinds: an API LLM gets them as function tools, a CLI LLM over MCP.
 * Tool names match what PhoneBridge prompts ask for ("Reply with chat_send").
 */
import type { ToolSpec } from '../session/api/api-agent-loop.js';
import type { ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import type { CallAgentRequest } from '../phone/phone-bridge.js';

/** The slice of PhoneLineService the tools drive. */
export interface PhoneLine {
  sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult>;
  hangup(sessionId: string): Promise<unknown>;
  inbox(): Promise<unknown>;
  startCallAgent(sessionId: string, req: CallAgentRequest): Promise<unknown>;
  transfer(fromSessionId: string, toSessionId: string, line: string): boolean | Promise<boolean>;
  enterMessageMode(sessionId: string): Promise<boolean> | boolean;
}

export const PHONE_TOOLS: ToolSpec[] = [
  {
    name: 'chat_send',
    description: 'Say this into the live call, or text it back to whoever last sent an SMS.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'phone_hangup',
    description: 'End the call you are holding.',
    parameters: { type: 'object', properties: {} },
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
      properties: { to: { type: 'string', description: 'Contact label or number' }, task: { type: 'string' }, maxWaitMin: { type: 'number' } },
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
  const allowed = new Set(['chat_send', 'phone_hangup', 'call_transfer']);
  return PHONE_TOOLS.filter((tool) => allowed.has(tool.name));
}

/** Runs a tool for one phone session; failures come back as text the model can read. */
export function phoneToolExecutor(line: PhoneLine, sessionId: string, handoverSessions?: ReadonlySet<string>) {
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    try {
      switch (name) {
        case 'chat_send': {
          const text = typeof args.text === 'string' ? args.text.trim() : '';
          if (!text) return 'Error: text is required';
          const r = await line.sendToSession({ sessionId, text });
          return r.sent ? 'sent' : `Error: not sent (${r.reason ?? 'unknown'})`;
        }
        case 'phone_hangup': await line.hangup(sessionId); return 'hung up';
        case 'phone_inbox': return JSON.stringify(await line.inbox());
        case 'phone_call_agent': {
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
  };
}
