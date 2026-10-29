/** The web UI's only door to the server. Types come straight from the server code. */
import type { TimbreConfig } from '../src/config/timbre-config.js';
import type { PhoneStatus } from '../src/hub.js';

export type { TimbreConfig, PhoneStatus };
export type { LlmConfig, PhoneEntry } from '../src/config/timbre-config.js';
export type { PhoneContact } from '../src/phone/phone-config.js';

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
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
};
