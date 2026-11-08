import { spawn } from 'node:child_process';
import type { ChatClient, ChatMessage } from '../session/api/api-agent-loop.js';

export interface CliChatClientOptions {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** A one-shot headless CLI (e.g. `claude -p`) as a tool-less chat client: conversation on stdin, reply on stdout. */
export function createCliChatClient(opts: CliChatClientOptions): ChatClient {
  return {
    complete(messages) {
      return new Promise((resolve, reject) => {
        const proc = spawn(opts.command, opts.args, { cwd: opts.cwd || undefined, windowsHide: true });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`${opts.command} timed out`));
        }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        proc.stdout.on('data', (chunk) => { stdout += chunk; });
        proc.stderr.on('data', (chunk) => { stderr += chunk; });
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve({ message: { content: stdout.trim() } });
          else reject(new Error(`${opts.command} exited ${code}: ${stderr.trim().slice(0, 200)}`));
        });
        proc.stdin.on('error', () => undefined);
        proc.stdin.end(promptText(messages));
      });
    },
  };
}

function promptText(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}:\n${message.content ?? ''}`).join('\n\n');
}
