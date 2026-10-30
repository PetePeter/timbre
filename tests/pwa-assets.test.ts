import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/public');

describe('PWA assets', () => {
  it('has a Timbre standalone manifest with valid 192px, 512px, and maskable PNG icons', () => {
    const manifest = JSON.parse(readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8')) as {
      name: string;
      short_name: string;
      start_url: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };
    expect(manifest).toMatchObject({
      name: 'Timbre', short_name: 'Timbre', start_url: '/', display: 'standalone',
      theme_color: '#2F9BE0', background_color: '#F6F1EA',
    });
    expect(manifest.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/pwa-icon-192.png', sizes: '192x192', type: 'image/png' }),
      expect.objectContaining({ src: '/pwa-icon-512.png', sizes: '512x512', type: 'image/png' }),
      expect.objectContaining({ src: '/pwa-icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }),
    ]));

    for (const icon of manifest.icons) {
      const image = readFileSync(path.join(publicDir, path.basename(icon.src)));
      expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const size = Number.parseInt(icon.sizes, 10);
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([size, size]);
    }

    const appleIcon = readFileSync(path.join(publicDir, 'apple-touch-icon.png'));
    expect(appleIcon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([appleIcon.readUInt32BE(16), appleIcon.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
