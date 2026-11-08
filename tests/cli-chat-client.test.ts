import { describe, expect, it } from 'vitest';
import { createCliChatClient } from '../src/agents/cli-chat-client.js';

const node = (script: string, timeoutMs?: number) =>
  createCliChatClient({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), timeoutMs });

describe('createCliChatClient', () => {
  it('sends the conversation on stdin and returns stdout as the reply', async () => {
    const client = node("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('  got: '+s.length+(s.includes('SYS')&&s.includes('USER')?' both':'')+'  '))");
    const { message } = await client.complete([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ], []);
    expect(message.content).toMatch(/^got: \d+ both$/);
  });

  it('rejects when the CLI exits non-zero', async () => {
    const client = node("process.stderr.write('boom');process.exit(3)");
    await expect(client.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/exited 3.*boom/);
  });

  it('rejects and kills the CLI when it runs past the timeout', async () => {
    const client = node('setTimeout(() => {}, 60000)', 200);
    await expect(client.complete([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/timed out/);
  });
});
