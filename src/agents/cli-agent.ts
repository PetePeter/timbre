/**
 * A phone answered by an LLM CLI (Claude Code, Codex, …) in a PTY. Prompts are
 * bracket-pasted then submitted; the CLI acts through Timbre's MCP endpoint,
 * which it finds via the {mcpUrl} / {mcpConfig} placeholders in its args.
 * PTY errors are logged, never thrown: the CLI may still be alive.
 */
import * as pty from 'node-pty';
import type { PhoneAgent } from './phone-agent.js';
import { nextRestart } from '../util/restart-policy.js';

const errorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

export interface CliAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Gap between the paste and Enter, so the CLI's composer has taken the paste. */
  pasteDelayMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRestarts?: number;
  /** Uptime after which the restart counter resets. */
  stableMs?: number;
  log?: (msg: string) => void;
}

export function expandArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

export class CliAgent implements PhoneAgent {
  private proc: pty.IPty | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(data: string) => void>();
  /** Recent output, for the web UI's terminal view. */
  private tail = '';
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: CliAgentOptions) {
    this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    let proc: pty.IPty;
    try {
      proc = pty.spawn(this.opts.command, this.opts.args, {
        name: 'xterm-256color', cols: 120, rows: 40, cwd: this.opts.cwd || process.cwd(),
        env: { ...process.env, ...this.opts.env } as Record<string, string>,
      });
    } catch (err) {
      const message = `cli agent spawn failed: ${errorMessage(err)}`;
      this.opts.log?.(message);
      this.scheduleRestart(message);
      return;
    }
    this.proc = proc;
    proc.onData((d) => {
      this.tail = (this.tail + d).slice(-20_000);
      for (const listener of this.listeners) {
        try { listener(d); } catch (err) { this.opts.log?.(`cli agent output listener failed: ${errorMessage(err)}`); }
      }
    });
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      if (this.proc === proc && !this.stopped) this.attempt = 0;
      this.stableTimer = null;
    }, this.opts.stableMs ?? 60_000);
    proc.onExit(({ exitCode, signal }) => this.onExit(proc, `exited (${signal ?? exitCode})`));
  }

  private onExit(proc: pty.IPty, reason: string): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.clearStableTimer();
    this.opts.log?.(`cli agent ${reason}`);
    this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string): void {
    if (this.stopped) return;
    const decision = nextRestart(this.attempt, this.opts);
    if (!decision) {
      this.opts.log?.('cli agent restart limit reached');
      return;
    }
    this.attempt = decision.attempt;
    this.opts.log?.(`cli agent restarting in ${decision.delayMs}ms (attempt ${decision.attempt}/${this.opts.maxRestarts ?? 10}): ${reason}`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.spawn();
    }, decision.delayMs);
  }

  private clearStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  onOutput(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTail(): string { return this.tail; }

  deliver(text: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      const proc = this.proc;
      if (!proc) {
        this.opts.log?.('cli agent write failed: process is not running');
        return;
      }
      try {
        proc.write(`\x1b[200~${text}\x1b[201~`);
        await new Promise((r) => setTimeout(r, this.opts.pasteDelayMs ?? 300));
        if (this.proc === proc && !this.stopped) proc.write('\r');
      } catch (err) {
        this.opts.log?.(`cli agent write failed: ${errorMessage(err)}`);
      }
    });
    return this.queue;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearStableTimer();
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try { proc.kill(); } catch (err) { this.opts.log?.(`cli agent kill failed: ${errorMessage(err)}`); }
  }
}
