/** The web UI's only door to the server. Types come straight from the server code. */
import type { TimbreConfig } from '../src/config/timbre-config.js';
import type { PhoneStatus } from '../src/hub.js';
import type { AddressBookContact, AddressBookContactInput } from '../src/contacts/contact.js';
import type { RecordPage, RecordQueryOptions, RecordSummary } from '../src/records/event-types.js';

export type { TimbreConfig, PhoneStatus };
export type { LlmConfig, PhoneEntry } from '../src/config/timbre-config.js';
export type { PhoneContact } from '../src/phone/phone-config.js';
export type { AddressBookContact, AddressBookContactInput };
export type { RecordEvent, RecordPage, RecordQueryOptions, RecordSummary } from '../src/records/event-types.js';

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

export const api = {
  status: () => call<{ phones: PhoneStatus[] }>('GET', '/api/status'),
  config: () => call<TimbreConfig>('GET', '/api/config'),
  save: (cfg: TimbreConfig) => call<TimbreConfig>('PUT', '/api/config', cfg),
  addPhone: (name = '') => call<TimbreConfig>('POST', '/api/phones', { name }),
  removePhone: (id: string) => call<TimbreConfig>('DELETE', `/api/phones/${id}`),
  restart:(id: string) => call('POST', `/api/phones/${id}/restart`),
  testSms: (id: string) => call<{ sent: boolean; reason?: string }>('POST', `/api/phones/${id}/test-sms`),
  terminal: (id: string) => call<{ text: string }>('GET', `/api/phones/${id}/terminal`),
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
  record: (phoneId: string, interactionId: string) => call<RecordSummary>(
    'GET', `/api/phones/${phoneId}/records/${encodeURIComponent(interactionId)}`,
  ),
};
