import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ActivityFeed } from './activity-feed';
import { api, type ActivityRecordAppend, type PhoneStatus, type RecordEvent } from './api';

export function useSwitchboardActivity() {
  const feed = new ActivityFeed();
  const phones = ref<PhoneStatus[]>([]);
  const loading = ref(true);
  const loadError = ref('');
  const now = ref(Date.now());
  const revision = ref(0);
  let source: EventSource | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;

  const todayFrom = computed(() => {
    const current = new Date(now.value);
    return new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  });
  const todayTo = computed(() => {
    const current = new Date(now.value);
    return new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1).getTime();
  });
  const lanes = computed(() => {
    revision.value;
    return feed.lanes(phones.value, now.value);
  });
  const today = computed(() => {
    revision.value;
    return feed.today(phones.value, todayFrom.value, todayTo.value);
  });

  function receiveAppend(message: MessageEvent<string>): void {
    try {
      const append = JSON.parse(message.data) as ActivityRecordAppend;
      if (!append || typeof append.phoneId !== 'string' || !isRecordEvent(append.event)) return;
      feed.append(append.phoneId, append.event);
      revision.value++;
    } catch { /* Ignore malformed stream data; EventSource will keep reconnecting. */ }
  }

  async function load(): Promise<void> {
    try {
      const status = await api.status();
      phones.value = status.phones;
      const failures: string[] = [];
      await Promise.all(status.phones.map(async (phone) => {
        try {
          const events = new Map<string, RecordEvent>();
          const remember = (items: Awaited<ReturnType<typeof api.records>>['items']) => {
            for (const item of items) for (const event of item.events) events.set(event.eventId, event);
          };
          remember((await api.records(phone.id, { limit: 100 })).items);

          let cursor: string | undefined;
          do {
            const page = await api.records(phone.id, {
              from: new Date(todayFrom.value).toISOString(),
              to: new Date(todayTo.value).toISOString(),
              limit: 100,
              ...(cursor ? { cursor } : {}),
            });
            remember(page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor);
          feed.seed(phone.id, [...events.values()]);
        } catch {
          failures.push(phone.id);
        }
      }));
      loadError.value = failures.length ? 'Some phone activity could not be loaded.' : '';
    } catch {
      loadError.value = 'Phone activity could not be loaded.';
    } finally {
      loading.value = false;
      revision.value++;
    }
  }

  onMounted(() => {
    if (typeof EventSource !== 'undefined') {
      source = new EventSource(api.activityEventsUrl());
      source.addEventListener('record', (event) => receiveAppend(event as MessageEvent<string>));
    }
    clock = setInterval(() => { now.value = Date.now(); }, 1000);
    void load();
  });

  onBeforeUnmount(() => {
    source?.close();
    if (clock) clearInterval(clock);
  });

  return { lanes, loading, loadError, today };
}

function isRecordEvent(value: unknown): value is RecordEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<RecordEvent>;
  return typeof event.eventId === 'string' && typeof event.interactionId === 'string'
    && typeof event.kind === 'string' && typeof event.type === 'string'
    && typeof event.occurredAt === 'string' && !!event.details && typeof event.details === 'object';
}
