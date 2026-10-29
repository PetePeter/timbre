/**
 * A phone answered by an LLM CLI (Claude Code, Codex, …) in a PTY. Prompts are
 * bracket-pasted then submitted; the CLI acts through Timbre's MCP endpoint,
 * which it finds via the {mcpUrl} / {mcpConfig} placeholders in its args.
 * PTY errors are logged, never thrown: the CLI may still be alive.
 */
import * as pty from 'node-pty';
import type { PhoneAgent } from './phone-agent.js';

export interface CliAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Gap between the paste and Enter, so the CLI's composer has taken the paste. */
  pasteDelayMs?: number;
  log?: (msg: string) => void;
}

export function expandArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

export class CliAgent implements PhoneAgent {
  private readonly proc: pty.IPty;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(data: string) => void>();
  /** Recent output, for the web UI's terminal view. */
  private tail = '';

  constructor(private readonly opts: CliAgentOptions) {
    this.proc = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color', cols: 120, rows: 40, cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...opts.env } as Record<string, string>,
    });
    this.proc.onData((d) => {
      this.tail = (this.tail + d).slice(-20_000);
      for (const l of this.listeners) l(d);
    });
    this.proc.onExit(({ exitCode }) => opts.log?.(`cli agent exited (${exitCode})`));
  }

  onOutput(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTail(): string { return this.tail; }

  deliver(text: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        this.proc.write(`\x1b[200~${text}\x1b[201~`);
        await new Promise((r) => setTimeout(r, this.opts.pasteDelayMs ?? 300));
        this.proc.write('\r');
      } catch (err) {
        this.opts.log?.(`cli agent write failed: ${(err as Error).message}`);
      }
    });
    return this.queue;
  }

  stop(): void {
    try { this.proc.kill(); } catch (err) { this.opts.log?.(`cli agent kill failed: ${(err as Error).message}`); }
  }
}
