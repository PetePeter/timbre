/** The web UI's only door to the server. Types come straight from the server code. */
import type { TimbreConfig } from '../src/config/timbre-config.js';
import type { PhoneStatus } from '../src/hub.js';
import type { AddressBookContact, AddressBookContactInput } from '../src/contacts/contact.js';
import type { VoiceChoice } from '../src/voice/voice-catalogue.js';
import type { RecordDateRange, RecordPage, RecordQueryOptions, RecordSummary } from '../src/records/event-types.js';
import type { CallAnalytics } from '../src/records/analytics.js';
import type { RecordSearchResponse } from '../src/records/record-search-index.js';
import type { DongleInventoryResult, UsbDongle } from '../src/phone/setup/dongle-inventory.js';
import type {
  PairingConfirmation, PairingConfirmationResult, PairingStart, PairingStatus,
} from '../src/phone/setup/telefony-admin-client.js';

export type { TimbreConfig, PhoneStatus };
export type { LlmConfig, PhoneEntry } from '../src/config/timbre-config.js';
export type { PhoneContact } from '../src/phone/phone-config.js';
export type { InboundRule } from '../src/phone/inbound-call-policy.js';
export type { AddressBookContact, AddressBookContactInput };
export type { VoiceChoice };
export type { RecordEvent, RecordPage, RecordQueryOptions, RecordSummary } from '../src/records/event-types.js';
export type { RecordSearchResponse, RecordSearchResult } from '../src/records/record-search-index.js';
export type { UsbDongle, DongleInventoryResult };
export type { PairingConfirmation, PairingConfirmationResult, PairingStart, PairingStatus };

export interface CallTranscript {
  date: string;
  contact: string;
  role: string;
  direction: 'inbound' | 'outbound';
  durationS: number;
  handledBy: string[];
  utterances: Array<{ speaker: 'local' | 'remote'; text: string; startMs: number }>;
}

export interface CallArtifacts {
  transcript: CallTranscript | null;
  audioAvailable: boolean;
}

export interface BackupExportOptions {
  includeRecords: boolean;
  includeSecrets: boolean;
  passphrase?: string;
}

export interface BackupExportTicket { ticket: string; fileName: string }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data as T;
}

async function audioCall(url: string, body: unknown): Promise<Blob> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => undefined);
    throw new Error(data?.error ?? res.statusText);
  }
  return res.blob();
}

export const api = {
  status: () => call<{ phones: PhoneStatus[] }>('GET', '/api/status'),
  config: () => call<TimbreConfig>('GET', '/api/config'),
  save: (cfg: TimbreConfig) => call<TimbreConfig>('PUT', '/api/config', cfg),
  createBackup: (options: BackupExportOptions) => call<BackupExportTicket>('POST', '/api/backup/export', options),
  backupDownloadUrl: (ticket: string) => `/api/backup/export/${encodeURIComponent(ticket)}`,
  restoreBackup: async (file: File, passphrase: string) => {
    const res = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'content-type': file.type || 'application/octet-stream', 'x-timbre-backup-passphrase': encodeURIComponent(passphrase) },
      body: file,
    });
    const data = await res.json().catch(() => undefined);
    if (!res.ok) throw new Error(data?.error ?? res.statusText);
    return data as { ok: true; config: TimbreConfig };
  },
  voices: () => call<VoiceChoice[]>('GET', '/api/voices'),
  registerPiperModel: (modelPath: string) => call<{ customPiperModels: string[] }>('POST', '/api/voices/custom', { modelPath }),
  removePiperModel: (modelPath: string) => call<{ customPiperModels: string[] }>('DELETE', '/api/voices/custom', { modelPath }),
  previewVoice: (id: string) => audioCall('/api/voices/preview', { id }),
  addPhone: (name = '') => call<TimbreConfig>('POST', '/api/phones', { name }),
  removePhone: (id: string) => call<TimbreConfig>('DELETE', `/api/phones/${id}`),
  restart:(id: string) => call('POST', `/api/phones/${id}/restart`),
  testSms: (id: string) => call<{ sent: boolean; reason?: string }>('POST', `/api/phones/${id}/test-sms`),
  terminal: (id: string) => call<{ text: string }>('GET', `/api/phones/${id}/terminal`),
  phoneDongles: (executable?: string) => executable
    ? call<DongleInventoryResult>('POST', '/api/phone-setup/dongles', { executable })
    : call<DongleInventoryResult>('GET', '/api/phone-setup/dongles'),
  startPairing: (phoneId: string, timeoutSeconds = 120) => call<PairingStart>(
    'POST', `/api/phones/${phoneId}/setup/pairing/start`, { timeoutSeconds },
  ),
  pairingStatus: (phoneId: string) => call<PairingStatus>('GET', `/api/phones/${phoneId}/setup/pairing`),
  confirmPairing: (phoneId: string, input: PairingConfirmation) => call<PairingConfirmationResult>(
    'POST', `/api/phones/${phoneId}/setup/pairing/confirm`, input,
  ),
  cancelPairing: (phoneId: string, pairingId: string) => call<PairingStatus>(
    'POST', `/api/phones/${phoneId}/setup/pairing/cancel`, { pairingId },
  ),
  contacts: (phoneId: string) => call<AddressBookContact[]>('GET', `/api/phones/${phoneId}/contacts`),
  findContacts: (phoneId: string, number: string) => call<AddressBookContact[]>(
    'GET', `/api/phones/${phoneId}/contacts/lookup?number=${encodeURIComponent(number)}`,
  ),
  addContact: (phoneId: string, contact: AddressBookContactInput) => call<AddressBookContact>(
    'POST', `/api/phones/${phoneId}/contacts`, contact,
  ),
  updateContact: (phoneId: string, id: string, contact: AddressBookContactInput) => call<AddressBookContact>(
    'PUT', `/api/phones/${phoneId}/contacts/${encodeURIComponent(id)}`, contact,
  ),
  deleteContact: (phoneId: string, id: string) => call<void>(
    'DELETE', `/api/phones/${phoneId}/contacts/${encodeURIComponent(id)}`,
  ),
  records: (phoneId: string, options: RecordQueryOptions = {}) => {
    const params = new URLSearchParams();
    for (const key of ['from', 'to', 'limit', 'cursor', 'filter'] as const) {
      const value = options[key];
      if (value !== undefined) params.set(key, String(value));
    }
    const query = params.size ? `?${params}` : '';
    return call<RecordPage>('GET', `/api/phones/${phoneId}/records${query}`);
  },
  insights: (phoneId: string, range: RecordDateRange) => {
    const params = new URLSearchParams();
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    return call<CallAnalytics>('GET', `/api/phones/${phoneId}/insights?${params}`);
  },
  searchRecords: (phoneId: string, query: string) => call<RecordSearchResponse>(
    'GET', `/api/phones/${phoneId}/search?q=${encodeURIComponent(query)}`,
  ),
  record: (phoneId: string, interactionId: string) => call<RecordSummary>(
    'GET', `/api/phones/${phoneId}/records/${encodeURIComponent(interactionId)}`,
  ),
  callArtifacts: (phoneId: string, interactionId: string) => call<CallArtifacts>(
    'GET', `/api/phones/${phoneId}/recordings/${encodeURIComponent(interactionId)}`,
  ),
  callAudioUrl: (phoneId: string, interactionId: string) =>
    `/api/phones/${phoneId}/recordings/${encodeURIComponent(interactionId)}/audio`,
};
