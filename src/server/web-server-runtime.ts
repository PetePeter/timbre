import type { Server } from 'node:http';
import type { ConfigStore } from '../config/timbre-config.js';

export const WEB_SERVER_PRE_CLOSE = 'webServerPreClose';

interface WebBind {
  port: number;
  lan: boolean;
}

/** Owns the active HTTP bind and reapplies saved port/LAN settings in place. */
export class WebServerRuntime {
  private active: WebBind | null = null;
  private operations: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly server: Server,
    private readonly store: ConfigStore,
    private readonly log: (message: string) => void = () => {},
  ) {}

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error('web server runtime is stopped');
      const bind = this.configuredBind();
      if (this.server.listening) {
        this.active = bind;
        return;
      }
      await this.listen(bind);
    });
  }

  rebind(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const next = this.configuredBind();
      if (this.active && this.active.port === next.port && this.active.lan === next.lan) return;
      const previous = this.active;
      if (this.server.listening) this.stopAccepting();
      this.active = null;
      try {
        await this.listen(next);
      } catch (err) {
        if (previous) {
          try { await this.listen(previous); }
          catch (rollbackError) { this.log(`web server rollback failed: ${(rollbackError as Error).message}`); }
        }
        throw err;
      }
    });
  }

  stop(): Promise<void> {
    this.stopped = true;
    return this.enqueue(async () => {
      if (this.server.listening) await this.closeListener();
      this.active = null;
    });
  }

  private configuredBind(): WebBind {
    const { port, lan } = this.store.get().web;
    return { port, lan };
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.operations.then(action, action);
    this.operations = result.then(() => undefined, () => undefined);
    return result;
  }

  private listen(bind: WebBind): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = bind.lan ? '0.0.0.0' : '127.0.0.1';
      const onListening = () => {
        this.server.off('error', onError);
        this.active = bind;
        this.log(`web server listening on ${host}:${bind.port}`);
        resolve();
      };
      const onError = (err: Error) => {
        this.server.off('listening', onListening);
        reject(err);
      };
      this.server.once('listening', onListening);
      this.server.once('error', onError);
      try {
        this.server.listen(bind.port, host);
      } catch (err) {
        this.server.off('listening', onListening);
        this.server.off('error', onError);
        reject(err);
      }
    });
  }

  private closeListener(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.emit(WEB_SERVER_PRE_CLOSE);
      this.server.close((err) => err ? reject(err) : resolve());
      this.server.closeIdleConnections?.();
    });
  }

  private stopAccepting(): void {
    this.server.emit(WEB_SERVER_PRE_CLOSE);
    this.server.close();
    this.server.closeIdleConnections?.();
  }
}
