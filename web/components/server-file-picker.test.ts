// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import ServerFilePicker from './ServerFilePicker.vue';

let overlayHost: HTMLDivElement;
afterEach(() => {
  overlayHost?.remove();
  vi.restoreAllMocks();
});

describe('ServerFilePicker', () => {
  it('navigates folders and emits the selected absolute path', async () => {
    overlayHost = document.createElement('div');
    overlayHost.id = 'timbre-overlay-host';
    document.body.append(overlayHost);

    const listFiles = vi.spyOn(api, 'serverFiles').mockImplementation(async (directory, extension) => {
      expect(extension).toBe('.onnx');
      if (!directory) {
        return { path: '/', parentPath: null, roots: ['/'], entries: [{ name: 'models', isDir: true, size: 0 }], truncated: false };
      }
      if (directory === '/models') {
        return { path: directory, parentPath: '/', roots: ['/'], entries: [{ name: 'voice.onnx', isDir: false, size: 12 }], truncated: false };
      }
      throw new Error(`unexpected directory: ${directory}`);
    });

    const wrapper = mount(ServerFilePicker, {
      attachTo: document.body,
      props: { extension: '.onnx' },
      global: { plugins: [[PrimeVue, { unstyled: true }]] },
    });

    await wrapper.get('button').trigger('click');
    await flushPromises();
    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(overlayHost.querySelectorAll('.server-file-entry')).toHaveLength(1);

    (overlayHost.querySelector('.server-file-entry') as HTMLButtonElement).click();
    await flushPromises();
    expect(listFiles).toHaveBeenCalledWith('/models', '.onnx');

    (overlayHost.querySelector('.server-file-entry') as HTMLButtonElement).click();
    await flushPromises();
    expect(wrapper.emitted('select')).toEqual([['/models/voice.onnx']]);
    wrapper.unmount();
  });
});
