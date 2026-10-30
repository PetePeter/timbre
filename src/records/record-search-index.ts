import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  subscribeTranscriptPurged, subscribeTranscriptWritten, type CallTranscript,
} from './call-artifacts.js';
import type { RecordEvent } from './event-types.js';
import { subscribeRecordAppended } from './jsonl-event-store.js';

const PHONE_ID = /^[\w-]+$/;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const TRANSCRIPT_FILE = /^([A-Za-z0-9_-]{1,128})\.json$/;
const RESULT_LIMIT = 50;
const MAX_DOCUMENTS_PER_PHONE = 20_000;

export interface RecordSearchResult {
  id: string;
  kind: 'call' | 'sms';
  occurredAt: string;
  contact?: string;
  direction?: 'inbound' | 'outbound';
  snippet: string;
}

export interface RecordSearchResponse {
  status: 'indexing' | 'ready';
  items: RecordSearchResult[];
}

interface SearchDocument extends RecordSearchResult { text: string; tokens: string[]; terms: string[] }
interface QueryClause { tokens: string[]; phrase: boolean }
interface PhoneIndex {
  status: 'indexing' | 'ready';
  documents: Map<string, SearchDocument>;
  ageHeap: SearchDocument[];
  postings: Map<string, Set<string>>;
  pending: Map<string, SearchDocument | null>;
  warming?: Promise<void>;
}

/** In-memory per-phone full-text search, rebuilt asynchronously from retained JSONL and transcript files. */
export class RecordSearchIndex {
  private readonly dataDir: string;
  private readonly phones = new Map<string, PhoneIndex>();
  private unsubscribe: Array<() => void> = [];

  constructor(dataDir: string, private readonly log: (message: string) => void = () => {}) {
    this.dataDir = path.resolve(dataDir);
    this.start();
  }

  start(): void {
    if (this.unsubscribe.length) return;
    this.unsubscribe = [
      subscribeRecordAppended((root, phoneId, event) => this.recordAppended(root, phoneId, event)),
      subscribeTranscriptWritten((directory, id, transcript) => this.transcriptWritten(directory, id, transcript)),
      subscribeTranscriptPurged((directory, id) => this.transcriptPurged(directory, id)),
    ];
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    this.phones.clear();
  }

  warmPhone(phoneId: string): Promise<void> {
    const state = this.state(phoneId);
    if (state.status === 'ready' || state.warming) return state.warming ?? Promise.resolve();
    if (!PHONE_ID.test(phoneId)) {
      this.report(`record search warm-up failed for invalid phone id ${phoneId}`);
      return Promise.resolve();
    }

    const warming = this.buildPhone(phoneId).then((documents) => {
      state.documents.clear();
      state.ageHeap.length = 0;
      state.postings.clear();
      for (const document of documents.values()) this.upsert(state, document);
      for (const [id, document] of state.pending) {
        if (!document) this.remove(state, id);
        else {
          const existing = state.documents.get(id);
          if (!existing || dateValue(document.occurredAt) >= dateValue(existing.occurredAt)) this.upsert(state, document);
        }
      }
      state.pending.clear();
      state.status = 'ready';
    }).catch((error) => {
      this.report(`record search warm-up failed for phone ${phoneId}: ${message(error)}`);
    }).finally(() => {
      if (state.warming === warming) state.warming = undefined;
    });
    state.status = 'indexing';
    state.warming = warming;
    return warming;
  }

  search(phoneId: string, query: string): RecordSearchResponse {
    const state = this.phones.get(phoneId);
    if (!state || state.status !== 'ready') {
      void this.warmPhone(phoneId);
      return { status: 'indexing', items: [] };
    }
    const clauses = parseQuery(query);
    if (!clauses.length) return { status: 'ready', items: [] };
    const terms = [...new Set(clauses.flatMap((clause) => clause.tokens))];
    const postings = terms.map((term) => state.postings.get(term));
    if (postings.some((set) => !set)) return { status: 'ready', items: [] };
    const [first, ...remaining] = postings as Set<string>[];
    const candidates = [...first].filter((id) => remaining.every((set) => set.has(id)));
    const matches = candidates
      .map((id) => state.documents.get(id)!)
      .filter((document) => clauses.every((clause) => matchesClause(document.tokens, clause)))
      .sort((a, b) => dateValue(b.occurredAt) - dateValue(a.occurredAt) || b.id.localeCompare(a.id))
      .slice(0, RESULT_LIMIT);
    return {
      status: 'ready',
      items: matches.map((document) => ({
        id: document.id, kind: document.kind, occurredAt: document.occurredAt,
        ...(document.contact ? { contact: document.contact } : {}),
        ...(document.direction ? { direction: document.direction } : {}),
        snippet: makeSnippet(document.text, terms),
      })),
    };
  }

  private state(phoneId: string): PhoneIndex {
    let state = this.phones.get(phoneId);
    if (!state) {
      state = { status: 'indexing', documents: new Map(), ageHeap: [], postings: new Map(), pending: new Map() };
      this.phones.set(phoneId, state);
    }
    return state;
  }

  private recordAppended(root: string, phoneId: string, event: RecordEvent): void {
    if (!samePath(root, this.dataDir) || !PHONE_ID.test(phoneId)) return;
    if (event.type !== 'sms.received' && event.type !== 'sms.sent') return;
    const text = textValue(event.details.text) ?? textValue(event.details.body);
    if (text === undefined) return;
    this.update(phoneId, makeDocument({
      id: event.interactionId, kind: 'sms', occurredAt: event.occurredAt,
      contact: textValue(event.details.contact),
      direction: directionValue(event.details.direction), text,
    }));
  }

  private transcriptWritten(directory: string, id: string, transcript: CallTranscript): void {
    const phoneId = this.phoneForRecordings(directory);
    if (!phoneId) return;
    this.update(phoneId, documentFromTranscript(id, transcript));
  }

  private transcriptPurged(directory: string, id: string): void {
    const phoneId = this.phoneForRecordings(directory);
    if (!phoneId) return;
    const state = this.state(phoneId);
    if (state.status === 'ready') this.remove(state, id);
    else state.pending.set(id, null);
  }

  private phoneForRecordings(directory: string): string | null {
    const relative = path.relative(this.dataDir, path.resolve(directory));
    const parts = relative.split(path.sep);
    return parts.length === 3 && parts[0] === 'phones' && parts[2] === 'recordings' && PHONE_ID.test(parts[1])
      ? parts[1]
      : null;
  }

  private update(phoneId: string, document: SearchDocument): void {
    const state = this.state(phoneId);
    if (state.status === 'ready') this.upsert(state, document);
    else {
      state.pending.set(document.id, document);
      void this.warmPhone(phoneId);
    }
  }

  private upsert(state: PhoneIndex, document: SearchDocument): void {
    this.remove(state, document.id);
    state.documents.set(document.id, document);
    pushAge(state.ageHeap, document);
    for (const token of new Set(document.terms)) {
      let ids = state.postings.get(token);
      if (!ids) state.postings.set(token, ids = new Set());
      ids.add(document.id);
    }
    while (state.documents.size > MAX_DOCUMENTS_PER_PHONE) {
      const oldest = popAge(state.ageHeap);
      if (oldest && state.documents.get(oldest.id) === oldest) this.remove(state, oldest.id);
    }
  }

  private remove(state: PhoneIndex, id: string): void {
    const previous = state.documents.get(id);
    if (!previous) return;
    state.documents.delete(id);
    for (const token of new Set(previous.terms)) {
      const ids = state.postings.get(token);
      ids?.delete(id);
      if (!ids?.size) state.postings.delete(token);
    }
    compactAgeHeap(state.ageHeap, state.documents);
  }

  private async buildPhone(phoneId: string): Promise<Map<string, SearchDocument>> {
    const documents = new Map<string, SearchDocument>();
    const ageHeap: SearchDocument[] = [];
    const phoneDir = path.join(this.dataDir, 'phones', phoneId);
    const eventDir = path.join(phoneDir, 'events');
    const eventFiles = await readNames(eventDir);
    let processed = 0;
    for (const name of eventFiles.filter((item) => DAY_FILE.test(item)).sort()) {
      const content = await fs.readFile(path.join(eventDir, name), 'utf8');
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const event: unknown = JSON.parse(line);
          const document = documentFromEvent(event);
          if (document) keepLatest(documents, document, ageHeap);
        } catch { this.report(`record search skipped corrupt event line in ${name}`); }
        if (++processed % 500 === 0) await yieldToEventLoop();
      }
    }

    const recordingsDir = path.join(phoneDir, 'recordings');
    const transcriptFiles = await readNames(recordingsDir);
    for (const name of transcriptFiles.sort()) {
      const match = TRANSCRIPT_FILE.exec(name);
      if (!match) continue;
      try {
        const value: unknown = JSON.parse(await fs.readFile(path.join(recordingsDir, name), 'utf8'));
        if (isTranscript(value)) keepLatest(documents, documentFromTranscript(match[1], value), ageHeap);
      } catch { this.report(`record search skipped transcript ${name}`); }
      if (++processed % 100 === 0) await yieldToEventLoop();
    }
    return documents;
  }

  private report(text: string): void {
    try { this.log(text); } catch { /* logging must not affect search availability */ }
  }
}

function documentFromEvent(value: unknown): SearchDocument | null {
  if (!isRecordEvent(value) || value.kind !== 'sms' || (value.type !== 'sms.received' && value.type !== 'sms.sent')) return null;
  const text = textValue(value.details.text) ?? textValue(value.details.body);
  if (text === undefined) return null;
  return makeDocument({
    id: value.interactionId, kind: 'sms', occurredAt: value.occurredAt,
    contact: textValue(value.details.contact), direction: directionValue(value.details.direction), text,
  });
}

function documentFromTranscript(id: string, transcript: CallTranscript): SearchDocument {
  return makeDocument({
    id, kind: 'call', occurredAt: transcript.date, contact: transcript.contact,
    direction: transcript.direction, text: transcript.utterances.map((utterance) => utterance.text).join(' '),
  });
}

function makeDocument(input: Omit<SearchDocument, 'tokens' | 'terms' | 'snippet'>): SearchDocument {
  const tokens = tokenize(input.text);
  return { ...input, snippet: '', tokens, terms: indexTerms(tokens) };
}

function keepLatest(documents: Map<string, SearchDocument>, document: SearchDocument, ageHeap: SearchDocument[]): void {
  const existing = documents.get(document.id);
  if (existing && dateValue(document.occurredAt) < dateValue(existing.occurredAt)) return;
  documents.delete(document.id);
  documents.set(document.id, document);
  pushAge(ageHeap, document);
  while (documents.size > MAX_DOCUMENTS_PER_PHONE) {
    const oldest = popAge(ageHeap);
    if (oldest && documents.get(oldest.id) === oldest) documents.delete(oldest.id);
  }
  compactAgeHeap(ageHeap, documents);
}

function parseQuery(query: string): QueryClause[] {
  const clauses: QueryClause[] = [];
  for (const match of query.matchAll(/"([^"]*)"|([^"]+)/gu)) {
    if (match[1] !== undefined) {
      const tokens = tokenize(match[1]);
      if (tokens.length) clauses.push({ tokens, phrase: true });
    } else {
      for (const token of tokenize(match[2] ?? '')) clauses.push({ tokens: [token], phrase: false });
    }
  }
  return clauses;
}

function tokenize(value: string): string[] {
  const normalized = value.normalize('NFKC').toLowerCase();
  const matches = [...normalized.matchAll(/[\p{L}]+|\d+/gu)];
  const tokens: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    if (!/^\d+$/u.test(match[0])) {
      tokens.push(match[0]);
      continue;
    }
    let digits = match[0];
    let end = match.index! + match[0].length;
    while (i + 1 < matches.length && /^\d+$/u.test(matches[i + 1][0])) {
      const next = matches[i + 1];
      const separator = normalized.slice(end, next.index!);
      if (!/^[\s().,+/-]*$/u.test(separator)) break;
      digits += next[0];
      end = next.index! + next[0].length;
      i++;
    }
    tokens.push(digits);
  }
  return tokens;
}

function indexTerms(tokens: string[]): string[] {
  return tokens.flatMap((token) => {
    if (!/^\d{4,}$/u.test(token)) return [token];
    const maxPrefix = Math.min(token.length, 32);
    const prefixes = Array.from({ length: maxPrefix - 3 }, (_, index) => token.slice(0, index + 4));
    if (token.length > maxPrefix) prefixes.push(token);
    return prefixes;
  });
}

function matchesClause(document: string[], clause: QueryClause): boolean {
  const matchesToken = (documentToken: string | undefined, queryToken: string) => documentToken === queryToken
    || (/^\d+$/u.test(documentToken ?? '') && /^\d{4,}$/u.test(queryToken) && documentToken!.startsWith(queryToken));
  if (!clause.phrase) return document.some((token) => matchesToken(token, clause.tokens[0]));
  return document.some((_, index) => clause.tokens.every((part, offset) => matchesToken(document[index + offset], part)));
}

function pushAge(heap: SearchDocument[], document: SearchDocument): void {
  let index = heap.push(document) - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!isOlder(heap[index], heap[parent])) break;
    [heap[index], heap[parent]] = [heap[parent], heap[index]];
    index = parent;
  }
}

function popAge(heap: SearchDocument[]): SearchDocument | undefined {
  if (!heap.length) return undefined;
  const oldest = heap[0];
  const last = heap.pop()!;
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let first = index;
      if (left < heap.length && isOlder(heap[left], heap[first])) first = left;
      if (right < heap.length && isOlder(heap[right], heap[first])) first = right;
      if (first === index) break;
      [heap[index], heap[first]] = [heap[first], heap[index]];
      index = first;
    }
  }
  return oldest;
}

function isOlder(left: SearchDocument, right: SearchDocument): boolean {
  const difference = dateValue(left.occurredAt) - dateValue(right.occurredAt);
  return difference < 0 || (difference === 0 && left.id.localeCompare(right.id) < 0);
}

function compactAgeHeap(heap: SearchDocument[], documents: Map<string, SearchDocument>): void {
  if (heap.length <= documents.size * 2 + 1024) return;
  heap.length = 0;
  for (const document of documents.values()) pushAge(heap, document);
}

function makeSnippet(text: string, terms: string[]): string {
  const normalized = text.normalize('NFKC').toLowerCase();
  const found = terms.map((term) => {
    const direct = normalized.indexOf(term);
    if (direct >= 0) return direct;
    if (/^\d{4,}$/u.test(term)) {
      const number = [...normalized.matchAll(/\d+(?:[\s().,+/-]*\d+)*/gu)]
        .find((match) => match[0].replace(/\D/gu, '').startsWith(term));
      if (number) return number.index!;
    }
    return -1;
  }).filter((index) => index >= 0);
  const matchAt = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, matchAt - 70);
  const end = Math.min(text.length, start + 180);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function isRecordEvent(value: unknown): value is RecordEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<RecordEvent>;
  return typeof event.eventId === 'string' && typeof event.interactionId === 'string'
    && event.kind === 'sms' && (event.type === 'sms.received' || event.type === 'sms.sent')
    && typeof event.occurredAt === 'string' && Number.isFinite(Date.parse(event.occurredAt))
    && !!event.details && typeof event.details === 'object' && !Array.isArray(event.details);
}

function isTranscript(value: unknown): value is CallTranscript {
  if (!value || typeof value !== 'object') return false;
  const transcript = value as Partial<CallTranscript>;
  return typeof transcript.date === 'string' && typeof transcript.contact === 'string'
    && (transcript.direction === 'inbound' || transcript.direction === 'outbound')
    && Array.isArray(transcript.utterances) && transcript.utterances.every((utterance) => !!utterance && typeof utterance.text === 'string');
}

function textValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function directionValue(value: unknown): 'inbound' | 'outbound' | undefined {
  return value === 'inbound' || value === 'outbound' ? value : undefined;
}
function dateValue(value: string): number { const date = Date.parse(value); return Number.isFinite(date) ? date : 0; }
function samePath(left: string, right: string): boolean { return path.resolve(left) === path.resolve(right); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
async function readNames(directory: string): Promise<string[]> {
  try { return await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function yieldToEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
