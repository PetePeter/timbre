import { describe, expect, it } from 'vitest';
import type { ChatClient, ChatMessage, CompletionResult } from '../src/session/api/api-agent-loop.js';
import { ApiAgent } from '../src/agents/api-agent.js';
import { CliAgent, expandArgs } from '../src/agents/cli-agent.js';
import { PHONE_TOOLS, phoneToolExecutor, type PhoneLine } from '../src/agents/phone-tools.js';

/** A phone line that records what the agent did to it. */
function fakeLine(): PhoneLine & { sent: string[]; hungUp: number } {
  const line = {
    sent: [] as string[],
    hungUp: 0,
    async sendToSession(m: { text: string }) { line.sent.push(m.text); return { sent: true }; },
    async hangup() { line.hungUp++; return undefined; },
    async inbox() { return [{ from: 'Mum', text: 'hi' }]; },
    async startCallAgent() { return { id: 'agent-1' }; },
  };
  return line as never;
}

/** Scripted model: replays canned completions and keeps what it was sent. */
function scriptedModel(replies: CompletionResult[]): ChatClient & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    async complete(messages) { seen.push(structuredClone(messages)); return replies.shift() ?? { message: { content: '' } }; },
  };
}

const toolCall = (name: string, args: object): CompletionResult => ({
  message: { content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
});

describe('phone tools', () => {
  it('chat_send speaks into the line for this phone session', async () => {
    const line = fakeLine();
    const out = await phoneToolExecutor(line, 'phone-1')('chat_send', { text: 'Hello Mum' });
    expect(line.sent).toEqual(['Hello Mum']);
    expect(out).toMatch(/sent/);
  });

  it('refuses an empty chat_send and unknown tools', async () => {
    const run = phoneToolExecutor(fakeLine(), 'p');
    expect(await run('chat_send', { text: '  ' })).toMatch(/error/i);
    expect(await run('rm_rf', {})).toMatch(/unknown tool/i);
  });

  it('a throwing line becomes an error string, not a crash', async () => {
    const line = { ...fakeLine(), async hangup() { throw new Error('not connected'); } };
    expect(await phoneToolExecutor(line, 'p')('phone_hangup', {})).toMatch(/not connected/);
  });

  it('every tool has a JSON schema', () => {
    for (const t of PHONE_TOOLS) expect(t.parameters.type).toBe('object');
  });
});

describe('ApiAgent', () => {
  it('answers a [PHONE] prompt by calling chat_send, then keeps history', async () => {
    const line = fakeLine();
    const model = scriptedModel([toolCall('chat_send', { text: 'On my way' }), { message: { content: 'done' } }, { message: { content: 'ok' } }]);
    const agent = new ApiAgent({ client: model, line, sessionId: 'p', name: 'Timbre' });
    await agent.deliver('[PHONE] Mum said: "where are you?"');
    await agent.idle();
    expect(line.sent).toEqual(['On my way']);
    await agent.deliver('second');
    await agent.idle();
    const last = model.seen.at(-1)!;
    expect(last.some((m) => m.content?.includes('where are you'))).toBe(true);
  });

  it('deliver returns before the model answers (PhoneBridge awaits it mid-call)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const model: ChatClient = { async complete() { await gate; return { message: { content: '' } }; } };
    const agent = new ApiAgent({ client: model, line: fakeLine(), sessionId: 'p', name: 'T' });
    await agent.deliver('a');
    release();
    await agent.idle();
  });

  it('runs deliveries one at a time, in order', async () => {
    const order: string[] = [];
    const model: ChatClient = {
      async complete(messages) {
        const user = messages.filter((m) => m.role === 'user').at(-1)!.content!;
        await new Promise((r) => setTimeout(r, user === 'a' ? 30 : 1));
        order.push(user);
        return { message: { content: '' } };
      },
    };
    const agent = new ApiAgent({ client: model, line: fakeLine(), sessionId: 'p', name: 'T' });
    await agent.deliver('a');
    await agent.deliver('b');
    await agent.idle();
    expect(order).toEqual(['a', 'b']);
  });

  it('a model failure is logged and the next delivery still runs', async () => {
    const logs: string[] = [];
    let n = 0;
    const model: ChatClient = { async complete() { if (n++ === 0) throw new Error('503'); return { message: { content: '' } }; } };
    const agent = new ApiAgent({ client: model, line: fakeLine(), sessionId: 'p', name: 'T', log: (m) => logs.push(m) });
    await agent.deliver('a');
    await agent.deliver('b');
    await agent.idle();
    expect(logs.join()).toMatch(/503/);
    expect(n).toBe(2);
  });
});

describe('CliAgent', () => {
  it('expands {mcpUrl} and {mcpConfig} in args', () => {
    expect(expandArgs(['--mcp-config', '{mcpConfig}', '--x={mcpUrl}'], { mcpUrl: 'http://h/mcp', mcpConfig: 'C:/m.json' }))
      .toEqual(['--mcp-config', 'C:/m.json', '--x=http://h/mcp']);
  });

  it('pastes the prompt into a real PTY and submits it', async () => {
    const isWin = process.platform === 'win32';
    // A shell that echoes one line of stdin proves the text reached the PTY and Enter submitted it.
    const agent = new CliAgent({
      command: isWin ? 'powershell.exe' : 'bash',
      args: isWin ? ['-NoProfile', '-Command', '$l = [Console]::ReadLine(); Write-Output "GOT:$l"'] : ['-c', 'read l; echo "GOT:$l"'],
      cwd: process.cwd(),
      env: {},
      pasteDelayMs: 50,
    });
    let out = '';
    agent.onOutput((d) => { out += d; });
    await new Promise((r) => setTimeout(r, isWin ? 1500 : 200));
    await agent.deliver('hello pty');
    await new Promise<void>((resolve, reject) => {
      const t = setInterval(() => { if (out.includes('GOT:hello pty')) { clearInterval(t); resolve(); } }, 50);
      setTimeout(() => { clearInterval(t); reject(new Error(`no echo: ${JSON.stringify(out.slice(-300))}`)); }, 8000);
    });
    agent.stop();
  }, 15000);
});
