/**
 * One phone's inbound-call desk for apps holding calls.receive: the live event
 * feed (SSE listeners plus a polled buffer), subscription leases, and the
 * short window in which an app may claim a ringing call before the AI does.
 */
import type { LiveCallEvent } from './phone-bridge.js';

/** How long a ringing call waits for an app to claim it, when an app is listening. */
export const APP_ANSWER_WINDOW_MS = 5000;
/** A call_events poll keeps an app subscribed for this long. */
export const APP_POLL_LEASE_MS = 30_000;
const BUFFER_LIMIT = 200;

export type AppCallEvent =
  | { type: 'ringing'; callId: string; from: string; contact?: string }
  | LiveCallEvent
  | { type: 'ended'; callId: string };
export interface BufferedAppCallEvent { seq: number; event: AppCallEvent }
/** A placed call's event: only its creating app sees it, findable by the interactionId create_call returned. */
interface Item extends BufferedAppCallEvent { appId?: string; interactionId?: string }
export interface AppClaimant { id: string; name: string }
export type ClaimResult = 'claimed' | 'taken' | 'unknown';

interface Offer { resolve: (claimant: AppClaimant | null) => void; timer: NodeJS.Timeout }

export class AppCallDesk {
  private readonly listeners = new Map<(event: BufferedAppCallEvent) => void, string | undefined>();
  private readonly leases = new Map<string, number>();
  private readonly buffer: Item[] = [];
  private readonly announced = new Set<string>();
  private readonly offers = new Map<string, Offer>();
  private readonly claims = new Map<string, AppClaimant>();
  private seq = 0;

  constructor(private readonly opts: { windowMs?: number; now?: () => number; log?: (msg: string) => void } = {}) {}

  /** An open SSE stream for one app token; it counts as a subscriber until closed. */
  subscribe(listener: (event: BufferedAppCallEvent) => void, tokenId?: string): () => void {
    this.listeners.set(listener, tokenId);
    return () => { this.listeners.delete(listener); };
  }

  /** Buffered events after `after`, optionally for one call; renews the app's poll lease. */
  poll(tokenId: string, callId?: string, after = 0): BufferedAppCallEvent[] {
    this.leases.set(tokenId, this.now() + APP_POLL_LEASE_MS);
    return this.buffer
      .filter((item) => item.seq > after && visibleTo(item, tokenId) && (!callId || item.event.callId === callId || item.interactionId === callId))
      .map(({ seq, event }) => ({ seq, event }));
  }

  hasSubscribers(): boolean {
    if (this.listeners.size) return true;
    const now = this.now();
    for (const [id, expiresAt] of this.leases) {
      if (expiresAt > now) return true;
      this.leases.delete(id);
    }
    return false;
  }

  /** Only calls announced with `ringing` reach apps; later events for other calls are dropped. */
  publish(event: AppCallEvent): void {
    if (event.type === 'ringing') this.announced.add(event.callId);
    else if (!this.announced.has(event.callId)) return;
    if (event.type === 'ended') {
      this.announced.delete(event.callId);
      this.claims.delete(event.callId);
      this.settle(event.callId, null);
    }
    this.push({ seq: ++this.seq, event });
  }

  /** An event of a call one app placed: no ringing announcement, and nobody else sees it. */
  publishTo(appId: string, interactionId: string, event: AppCallEvent): void {
    this.push({ seq: ++this.seq, event, appId, interactionId });
  }

  private push(item: Item): void {
    this.buffer.push(item);
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
    for (const [listener, tokenId] of this.listeners) {
      if (!visibleTo(item, tokenId)) continue;
      try { listener({ seq: item.seq, event: item.event }); }
      catch (err) { this.opts.log?.(`app call listener failed: ${(err as Error).message}`); }
    }
  }

  /** Wait for an app to claim a ringing call; null when nobody listens or the window closes. */
  offer(callId: string): Promise<AppClaimant | null> {
    if (!this.hasSubscribers()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(callId, null), this.opts.windowMs ?? APP_ANSWER_WINDOW_MS);
      this.offers.set(callId, { resolve, timer });
    });
  }

  /** The first claim inside the window wins. */
  claim(callId: string, claimant: AppClaimant): ClaimResult {
    if (this.claims.has(callId)) return 'taken';
    if (!this.offers.has(callId)) return 'unknown';
    this.claims.set(callId, claimant);
    this.settle(callId, claimant);
    return 'claimed';
  }

  claimant(callId: string): AppClaimant | undefined { return this.claims.get(callId); }

  private settle(callId: string, claimant: AppClaimant | null): void {
    const offer = this.offers.get(callId);
    if (!offer) return;
    clearTimeout(offer.timer);
    this.offers.delete(callId);
    offer.resolve(claimant);
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }
}

function visibleTo(item: Item, tokenId: string | undefined): boolean {
  return item.appId === undefined || item.appId === tokenId;
}
