// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { defaultConfig } from '../src/config/timbre-config.js';
import BackupControls from './components/BackupControls.vue';

let overlayHost: HTMLDivElement;
beforeEach(() => {
  overlayHost = document.createElement('div');
  overlayHost.id = 'timbre-overlay-host';
  document.body.append(overlayHost);
});
afterEach(() => { overlayHost.remove(); vi.unstubAllGlobals(); });

describe('backup controls', () => {
  it('discloses exactly which user data and call artifacts the archive contains', () => {
    const wrapper = mount(BackupControls, { global: { plugins: [[PrimeVue, { unstyled: true }]] } });
    expect(wrapper.text()).toContain('daily event history');
    expect(wrapper.text()).toContain('Transcripts, WAV audio, and custom transcript exports are not included');
    expect(wrapper.text()).toContain('Voice files under dataDir/voices are not included');
  });

  it('creates an owner download ticket with selected options and keeps the passphrase out of its URL', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ticket: 'f8d23a0a-7c66-419a-9042-c12b86a629c0', fileName: 'timbre-backup-2026-10-30.json' }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(BackupControls, { global: { plugins: [[PrimeVue, { unstyled: true }]] } });
    await wrapper.get('input[aria-label="Include daily event history"]').setValue(true);
    await wrapper.get('input[aria-label="Include secrets"]')
      .setValue(true);
    await wrapper.get('input[aria-label="Export passphrase"]').setValue('private export passphrase');
    await wrapper.get('button[aria-label="Create backup"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/backup/export', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ includeRecords: true, includeSecrets: true, passphrase: 'private export passphrase' }),
    }));
    const link = wrapper.get('a[aria-label="Download backup"]');
    expect(link.attributes('href')).toBe('/api/backup/export/f8d23a0a-7c66-419a-9042-c12b86a629c0');
    expect(link.attributes('href')).not.toContain('private export passphrase');
    expect(link.attributes('download')).toBe('timbre-backup-2026-10-30.json');
  });

  it('uploads the selected archive and adopts the returned config after restore', async () => {
    const config = defaultConfig();
    const fetchMock = vi.fn(async () => Response.json({ ok: true, config }));
    vi.stubGlobal('fetch', fetchMock);
    const restored = vi.fn();
    const wrapper = mount(BackupControls, { props: { onRestored: restored }, global: { plugins: [[PrimeVue, { unstyled: true }]] } });
    const file = new File(['backup bytes'], 'home.json', { type: 'application/json' });
    Object.defineProperty(wrapper.get('input[type="file"]').element, 'files', { value: [file] });
    await wrapper.get('input[aria-label="Restore passphrase"]').setValue('private restore passphrase');
    await wrapper.get('button[aria-label="Restore backup"]').trigger('click');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith('/api/backup/import', expect.objectContaining({
      method: 'POST', body: file,
      headers: expect.objectContaining({ 'x-timbre-backup-passphrase': 'private%20restore%20passphrase' }),
    }));
    expect(restored).toHaveBeenCalledWith(config);
    expect(wrapper.text()).toContain('Backup restored');
  });
});
