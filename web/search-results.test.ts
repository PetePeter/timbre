// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchResults from './components/SearchResults.vue';

describe('SearchResults', () => {
  it('highlights matching text without interpreting untrusted snippets as HTML', async () => {
    const wrapper = mount(SearchResults, {
      props: {
        query: 'needle',
        status: 'ready',
        items: [{ id: 'sms-1', kind: 'sms', occurredAt: '2026-10-29T10:00:00.000Z', snippet: '<img onerror=alert(1)> needle' }],
      },
    });

    expect(wrapper.find('mark').text()).toBe('needle');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('<img onerror=alert(1)>');
    await wrapper.get('button').trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual([expect.objectContaining({ id: 'sms-1' })]);
  });

  it('shows the asynchronous indexing state', () => {
    const wrapper = mount(SearchResults, { props: { query: 'needle', status: 'indexing', items: [] } });
    expect(wrapper.text()).toContain('Building search index');
  });
});
