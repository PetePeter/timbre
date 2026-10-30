import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeBackup, encodeBackup } from '../src/backup/archive.js';
import { createBackup, prepareBackupRestore } from '../src/backup/backup-service.js';
import { beginRestoreTransaction, recoverRestoreTransaction } from '../src/config/restore-transaction.js';
import { ConfigStore, defaultConfig, serializeConfigYaml } from '../src/config/timbre-config.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'timbre-backup-'));
  dirs.push(dir);
  return dir;
}

function configured() {
  const config = defaultConfig();
  const phone = config.phones[0];
  config.llms[0].kind === 'api' && (config.llms[0].apiKey = 'api-secret');
  config.web = { ...config.web, lan: true, token: 'web-secret' };
  phone.line.token = 'phap-secret';
  phone.line.contactRules.push({ contactId: 'contact-1', role: 'trusted', pattern: '', pin: '456789' } as never);
  phone.mcpServers = [{ name: 'calendar', url: 'https://mcp.example.test', headers: { Authorization: 'mcp-secret' }, allowedTools: ['list'] }];
  ((phone.line as unknown as Record<string, unknown>).voice as Record<string, unknown>).customPath = 'C:/custom/voice.wav';
  return config;
}

describe('backup archive', () => {
  it('keeps the whole config document while omitting secrets by default', () => {
    const config = configured();
    const bytes = encodeBackup({ config, contacts: {}, contactPins: {} });
    const text = bytes.toString('utf8');
    const restored = decodeBackup(bytes);

    expect(text).not.toContain('api-secret');
    expect(text).not.toContain('web-secret');
    expect(text).not.toContain('phap-secret');
    expect(text).not.toContain('mcp-secret');
    expect((restored.config.phones[0].line.voice as unknown as Record<string, unknown>).customPath).toBe('C:/custom/voice.wav');
    expect(restored.config.llms[0]).toMatchObject({ apiKey: '' });
    expect(restored.config.web.token).toBe('');
    expect(restored.config.phones[0].line.token).toBe('');
    expect(restored.config.phones[0].mcpServers[0].headers).toEqual({ Authorization: '' });
    expect(restored.config.phones[0].line.contactRules[0].pin).toBe('');
    expect(restored.contactPins).toEqual({});
  });

  it('round-trips secrets only inside authenticated encryption', () => {
    const config = configured();
    const contactPins = { [config.phones[0].id]: JSON.stringify({ 'contact-1': { salt: 'a'.repeat(32), hash: 'b'.repeat(128) } }) };
    const bytes = encodeBackup({ config, contacts: {}, contactPins, includeSecrets: true, passphrase: 'correct horse battery staple' });

    expect(bytes.toString('utf8')).not.toContain('api-secret');
    expect(bytes.toString('utf8')).not.toContain('456789');
    const restored = decodeBackup(bytes, 'correct horse battery staple');
    expect((restored.config.phones[0].line.voice as unknown as Record<string, unknown>).customPath).toBe('C:/custom/voice.wav');
    expect(restored.config.llms[0]).toMatchObject({ apiKey: 'api-secret' });
    expect(restored.config.web.token).toBe('web-secret');
    expect(restored.config.phones[0].line.token).toBe('phap-secret');
    expect(restored.config.phones[0].mcpServers[0].headers).toEqual({ Authorization: 'mcp-secret' });
    expect(restored.config.phones[0].line.contactRules[0].pin).toBe('456789');
    expect(restored.contactPins).toEqual(contactPins);
  });

  it('scrubs secret strings nested in arrays in both export modes', () => {
    const config = configured();
    const extension = config as unknown as Record<string, unknown>;
    extension.credentials = ['array-secret', { nested: ['nested-array-secret'] }];

    const plain = encodeBackup({ config, contacts: {}, contactPins: {} });
    const plainCredentials = (decodeBackup(plain).config as unknown as Record<string, unknown>).credentials;
    expect(plain.toString('utf8')).not.toContain('array-secret');
    expect(plain.toString('utf8')).not.toContain('nested-array-secret');
    expect(plainCredentials).toEqual(['', { nested: [''] }]);

    const encrypted = encodeBackup({
      config, contacts: {}, contactPins: {}, includeSecrets: true, passphrase: 'array-secret-passphrase',
    });
    const archive = JSON.parse(encrypted.toString('utf8')) as { config: Record<string, unknown> };
    expect(encrypted.toString('utf8')).not.toContain('array-secret');
    expect(encrypted.toString('utf8')).not.toContain('nested-array-secret');
    expect(archive.config.credentials).toEqual(['', { nested: [''] }]);
    const restored = decodeBackup(encrypted, 'array-secret-passphrase');
    expect((restored.config as unknown as Record<string, unknown>).credentials)
      .toEqual(['array-secret', { nested: ['nested-array-secret'] }]);
  });

  it('rejects bad passphrases, malformed archives, and future versions', () => {
    const bytes = encodeBackup({ config: configured(), contacts: {}, contactPins: {}, includeSecrets: true, passphrase: 'secret-passphrase' });
    expect(() => decodeBackup(bytes, 'wrong-passphrase')).toThrow(/passphrase/i);
    expect(() => decodeBackup(Buffer.from('{broken'))).toThrow(/archive/i);
    const future = JSON.parse(encodeBackup({ config: defaultConfig(), contacts: {}, contactPins: {} }).toString('utf8'));
    future.version = 99;
    expect(() => decodeBackup(Buffer.from(JSON.stringify(future)))).toThrow(/version/i);
  });
});

describe('backup service and restore transaction', () => {
  it('enforces the archive size limit while reading and encoding export data', () => {
    const source = tempDir();
    const config = defaultConfig();
    const phoneId = config.phones[0].id;
    const events = path.join(source, 'phones', phoneId, 'events');
    mkdirSync(events, { recursive: true });
    writeFileSync(path.join(events, '2026-10-30.jsonl'), JSON.stringify({
      eventId: 'event-1', interactionId: 'call-1', kind: 'call', type: 'call.started',
      occurredAt: '2026-10-30T00:00:00.000Z', details: { payload: 'x'.repeat(2048) },
    }) + '\n');

    expect(() => createBackup(source, config, { includeRecords: true, maxArchiveBytes: 1024 }))
      .toThrow(/size limit/i);
    expect(() => createBackup(tempDir(), defaultConfig(), { maxArchiveBytes: 1 }))
      .toThrow(/size limit/i);
  });

  it('round-trips the full config, contacts, and only daily event JSONL into a fresh data directory', () => {
    const source = tempDir();
    const target = tempDir();
    const config = configured();
    const phoneId = config.phones[0].id;
    const phoneDir = path.join(source, 'phones', phoneId);
    mkdirSync(path.join(phoneDir, 'events'), { recursive: true });
    mkdirSync(path.join(phoneDir, 'recordings'), { recursive: true });
    writeFileSync(path.join(phoneDir, 'contacts.json'), JSON.stringify([
      { id: 'contact-1', name: 'Jordan', numbers: ['+61412345678'], group: 'Family', trusted: true, isUser: false },
    ]));
    writeFileSync(path.join(phoneDir, 'events', '2026-10-30.jsonl'), JSON.stringify({
      eventId: 'event-1', interactionId: 'call-1', kind: 'call', type: 'call.started',
      occurredAt: '2026-10-30T00:00:00.000Z', details: {},
    }) + '\n');
    writeFileSync(path.join(phoneDir, 'recordings', 'call-1.json'), 'excluded transcript');

    const bytes = createBackup(source, config, { includeRecords: true });
    const prepared = prepareBackupRestore(target, bytes);
    const transaction = beginRestoreTransaction(target, prepared.files);
    transaction.commit();
    transaction.finalize();

    expect((prepared.config.phones[0].line.voice as unknown as Record<string, unknown>).customPath).toBe('C:/custom/voice.wav');
    expect(JSON.parse(readFileSync(path.join(target, 'phones', phoneId, 'contacts.json'), 'utf8'))[0].name).toBe('Jordan');
    expect(readFileSync(path.join(target, 'phones', phoneId, 'events', '2026-10-30.jsonl'), 'utf8')).toContain('event-1');
    expect(existsSync(path.join(target, 'phones', phoneId, 'recordings'))).toBe(false);
    expect(readFileSync(path.join(target, 'timbre.yaml'), 'utf8')).toContain('customPath');
  });

  it('restores encrypted API, phone, MCP, and contact PIN credentials', () => {
    const source = tempDir();
    const target = tempDir();
    const config = configured();
    const phoneId = config.phones[0].id;
    const phoneDirectory = path.join(source, 'phones', phoneId);
    mkdirSync(phoneDirectory, { recursive: true });
    const pinFile = JSON.stringify({ 'contact-1': { salt: 'a'.repeat(32), hash: 'b'.repeat(128) } });
    writeFileSync(path.join(phoneDirectory, 'contact-pins.json'), pinFile);
    const bytes = createBackup(source, config, { includeSecrets: true, passphrase: 'the owner passphrase' });
    expect(bytes.toString('utf8')).not.toContain('b'.repeat(128));
    const prepared = prepareBackupRestore(target, bytes, 'the owner passphrase');
    const transaction = beginRestoreTransaction(target, prepared.files);
    transaction.commit();
    transaction.finalize();

    expect(prepared.config.llms[0]).toMatchObject({ apiKey: 'api-secret' });
    expect(prepared.config.web.token).toBe('web-secret');
    expect(prepared.config.phones[0].line.token).toBe('phap-secret');
    expect(prepared.config.phones[0].mcpServers[0].headers).toEqual({ Authorization: 'mcp-secret' });
    expect(readFileSync(path.join(target, 'phones', phoneId, 'contact-pins.json'), 'utf8')).toBe(pinFile);
  });

  it('rejects an invalid archive before creating or replacing managed files', () => {
    const target = tempDir();
    const existing = path.join(target, 'timbre.yaml');
    writeFileSync(existing, 'previous config');
    expect(() => prepareBackupRestore(target, Buffer.from('{invalid'))).toThrow();
    expect(readFileSync(existing, 'utf8')).toBe('previous config');
  });

  it('leaves destination event history alone when the archive has no records section', () => {
    const source = tempDir();
    const target = tempDir();
    const config = defaultConfig();
    const phoneId = config.phones[0].id;
    const events = path.join(target, 'phones', phoneId, 'events');
    mkdirSync(events, { recursive: true });
    writeFileSync(path.join(events, '2026-10-01.jsonl'), 'destination history\n');
    const bytes = createBackup(source, config);
    const prepared = prepareBackupRestore(target, bytes);
    const transaction = beginRestoreTransaction(target, prepared.files);
    transaction.commit();
    transaction.finalize();
    expect(readFileSync(path.join(events, '2026-10-01.jsonl'), 'utf8')).toBe('destination history\n');
  });

  it('rolls back an earlier file replacement when a later destination fails during commit', () => {
    const dir = tempDir();
    const phoneDirectory = path.join(dir, 'phones', 'home');
    mkdirSync(phoneDirectory, { recursive: true });
    const contacts = path.join(phoneDirectory, 'contacts.json');
    writeFileSync(contacts, 'old contacts');
    const transaction = beginRestoreTransaction(dir, [
      { path: 'phones/home/contacts.json', content: Buffer.from('new contacts') },
      { path: 'phones/home/events/2026-10-30.jsonl', content: Buffer.from('new events') },
    ]);
    writeFileSync(path.join(phoneDirectory, 'events'), 'block the event directory');
    expect(() => transaction.commit()).toThrow();
    transaction.rollback();
    expect(readFileSync(contacts, 'utf8')).toBe('old contacts');
  });

  it('recovers an interrupted transaction and retains finalized transactions', () => {
    const dir = tempDir();
    const file = path.join(dir, 'phones', 'home', 'contacts.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'old contacts');

    mkdirSync(path.join(dir, '.backup-restore'));
    writeFileSync(path.join(dir, '.backup-restore', '0.old'), 'old contacts');
    writeFileSync(path.join(dir, '.backup-restore', 'manifest.json'), JSON.stringify({
      version: 1, committed: false,
      entries: [{ path: 'phones/home/contacts.json', hadOriginal: true, originalMode: 0o600, delete: false, staged: '0.new', backup: '0.old' }],
    }));
    writeFileSync(file, 'new contacts');
    expect(readFileSync(file, 'utf8')).toBe('new contacts');
    recoverRestoreTransaction(dir);
    expect(readFileSync(file, 'utf8')).toBe('old contacts');

    const complete = beginRestoreTransaction(dir, [{ path: 'phones/home/contacts.json', content: Buffer.from('final contacts') }]);
    complete.commit();
    complete.finalize();
    recoverRestoreTransaction(dir);
    expect(readFileSync(file, 'utf8')).toBe('final contacts');
  });

  it('recovers a pending journal before ConfigStore reads the restored config', () => {
    const dir = tempDir();
    const config = defaultConfig();
    config.phones[0].name = 'Original';
    const configPath = path.join(dir, 'timbre.yaml');
    writeFileSync(configPath, serializeConfigYaml(config));
    mkdirSync(path.join(dir, '.backup-restore'));
    writeFileSync(path.join(dir, '.backup-restore', '0.old'), serializeConfigYaml(config));
    const changed = structuredClone(config);
    changed.phones[0].name = 'Interrupted';
    writeFileSync(configPath, serializeConfigYaml(changed));
    writeFileSync(path.join(dir, '.backup-restore', 'manifest.json'), JSON.stringify({
      version: 1, committed: false,
      entries: [{ path: 'timbre.yaml', hadOriginal: true, originalMode: 0o600, delete: false, staged: '0.new', backup: '0.old' }],
    }));

    const store = new ConfigStore(configPath);
    expect(store.get().phones[0].name).toBe('Original');
  });

  it('validates every destination before changing any live file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'timbre.yaml');
    writeFileSync(file, 'old config');
    expect(() => beginRestoreTransaction(dir, [
      { path: 'timbre.yaml', content: Buffer.from('new config') },
      { path: '../outside.txt', content: Buffer.from('unsafe') },
    ])).toThrow(/path/i);
    expect(readFileSync(file, 'utf8')).toBe('old config');
  });
});
