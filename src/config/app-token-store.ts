import { createHash, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const APP_ACTIONS = ['sms.list', 'sms.send', 'calls.list', 'calls.make', 'calls.receive', 'calls.conference', 'contacts.list'] as const;
export type AppAction = typeof APP_ACTIONS[number];

export interface AppTokenInput { name: string; phoneIds: string[]; actions: AppAction[] }
export interface AppTokenMetadata { id: string; name: string; createdAt: string; phoneIds: string[]; actions: AppAction[] }
export interface AppTokenAccess extends AppTokenMetadata {}
interface StoredAppToken extends AppTokenMetadata { hash: string }
export interface CreatedAppToken { token: string; app: AppTokenMetadata }

/** A token request the owner can fix; its message is safe to show. */
export class AppTokenInputError extends Error {}

function validateScope(phoneIds: unknown, actions: unknown): void {
  if (!Array.isArray(phoneIds) || phoneIds.length !== 1
    || (phoneIds[0] !== '*' && (typeof phoneIds[0] !== 'string' || !/^[\w-]+$/.test(phoneIds[0])))) {
    throw new AppTokenInputError('Choose one phone or all phones.');
  }
  if (!Array.isArray(actions) || !actions.length
    || actions.some((action) => typeof action !== 'string' || !APP_ACTIONS.includes(action as AppAction))
    || new Set(actions).size !== actions.length) {
    throw new AppTokenInputError('Choose at least one valid action.');
  }
  if (actions.includes('calls.conference') && !actions.includes('calls.make')) {
    throw new AppTokenInputError('Conference calls need Make calls.');
  }
}

/** Persists token hashes only. Raw secrets exist only in the create response. */
export class AppTokenStore {
  constructor(readonly filePath: string) {}

  list(): AppTokenMetadata[] { return this.read().map(({ hash: _hash, ...metadata }) => metadata); }

  create(input: AppTokenInput): CreatedAppToken {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new AppTokenInputError('Token name must be 1 to 80 characters.');
    validateScope(input.phoneIds, input.actions);
    const token = `tm_${randomBytes(32).toString('base64url')}`;
    const app: AppTokenMetadata = {
      id: randomUUID(), name, createdAt: new Date().toISOString(),
      phoneIds: [...input.phoneIds], actions: [...input.actions],
    };
    this.write([...this.read(), { ...app, hash: this.hash(token) }]);
    return { token, app };
  }

  authenticate(token: string): AppTokenAccess | null {
    if (!token) return null;
    const given = Buffer.from(this.hash(token), 'hex');
    for (const { hash, ...metadata } of this.read()) {
      const saved = Buffer.from(hash, 'hex');
      if (saved.length === given.length && timingSafeEqual(saved, given)) return metadata;
    }
    return null;
  }

  update(id: string, input: Pick<AppTokenInput, 'phoneIds' | 'actions'>): AppTokenMetadata | null {
    validateScope(input.phoneIds, input.actions);
    const current = this.read();
    const index = current.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const updated = { ...current[index], phoneIds: [...input.phoneIds], actions: [...input.actions] };
    current[index] = updated;
    this.write(current);
    const { hash: _hash, ...metadata } = updated;
    return metadata;
  }

  revoke(id: string): boolean {
    const current = this.read();
    const next = current.filter((item) => item.id !== id);
    if (next.length === current.length) return false;
    this.write(next);
    return true;
  }

  private hash(token: string): string { return createHash('sha256').update(token).digest('hex'); }

  private read(): StoredAppToken[] {
    if (!existsSync(this.filePath)) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('App token store is invalid.');
    // Tokens granted before the permission rework are dropped: their apps must be set up again.
    return parsed.filter((value) => !Array.isArray((value as Partial<StoredAppToken> | null)?.actions)
      || (value as StoredAppToken).actions.every((action) => APP_ACTIONS.includes(action))).map((value) => {
      if (!value || typeof value !== 'object') throw new Error('App token store is invalid.');
      const item = value as Partial<StoredAppToken>;
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.createdAt !== 'string'
        || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)
        || !item.name.trim() || !Number.isFinite(Date.parse(item.createdAt))
        || !Array.isArray(item.phoneIds) || item.phoneIds.length !== 1
        || (item.phoneIds[0] !== '*' && (typeof item.phoneIds[0] !== 'string' || !/^[\w-]{1,128}$/.test(item.phoneIds[0])))
        || !Array.isArray(item.actions) || !item.actions.length
        || item.actions.some((action) => !APP_ACTIONS.includes(action as AppAction))
        || new Set(item.actions).size !== item.actions.length) {
        throw new Error('App token store is invalid.');
      }
      const { id, name, createdAt, hash, phoneIds, actions } = item;
      return { id: id!, name: name!, createdAt: createdAt!, hash: hash!, phoneIds: phoneIds!, actions: actions! };
    });
  }

  private write(tokens: StoredAppToken[]): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(tokens, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.filePath);
    } finally {
      if (existsSync(temp)) rmSync(temp, { force: true });
    }
  }
}
