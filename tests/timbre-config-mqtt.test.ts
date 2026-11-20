import { describe, expect, it } from 'vitest';
import { MCP_SECRET_MASK, defaultConfig, normalizeConfig, redactMcpSecrets, restoreMaskedMcpSecrets } from '../src/config/timbre-config.js';

describe('mqtt config', () => {
  it('defaults to disabled Home Assistant settings', () => {
    expect(normalizeConfig({}).mqtt).toEqual({
      enabled: false, url: 'mqtt://homeassistant.local:1883', username: '', password: '', topicPrefix: 'timbre',
    });
  });

  it('replaces bad values with defaults and keeps good ones', () => {
    const fixed = normalizeConfig({ mqtt: { enabled: 'yes', url: 42, username: 'ha', password: null, topicPrefix: 'bad prefix#' } as never });
    expect(fixed.mqtt).toEqual({ enabled: false, url: 'mqtt://homeassistant.local:1883', username: 'ha', password: '', topicPrefix: 'timbre' });
    expect(normalizeConfig({ mqtt: { enabled: true, url: 'mqtt://h:1', username: '', password: 'p', topicPrefix: 'home/timbre_1-a' } }).mqtt)
      .toMatchObject({ enabled: true, url: 'mqtt://h:1', topicPrefix: 'home/timbre_1-a' });
  });

  it('masks the password on read and keeps or replaces it on write', () => {
    const stored = normalizeConfig({ mqtt: { ...defaultConfig().mqtt, password: 'secret' } });
    const shown = redactMcpSecrets(stored);
    expect(shown.mqtt.password).toBe(MCP_SECRET_MASK);
    expect(restoreMaskedMcpSecrets(stored, shown).mqtt.password).toBe('secret');
    expect(restoreMaskedMcpSecrets(stored, { ...shown, mqtt: { ...shown.mqtt, password: 'new' } }).mqtt.password).toBe('new');
    expect(redactMcpSecrets(normalizeConfig({})).mqtt.password).toBe('');
  });

  it('keeps the saved MQTT settings when an older client saves a config without mqtt', () => {
    const stored = normalizeConfig({ mqtt: { ...defaultConfig().mqtt, enabled: true, password: 'secret' } });
    const { mqtt: _omitted, ...withoutMqtt } = redactMcpSecrets(stored);
    expect(restoreMaskedMcpSecrets(stored, withoutMqtt as never).mqtt).toEqual(stored.mqtt);
  });

  it('repairs empty levels in prefixes saved by older builds instead of dropping them', () => {
    const prefixOf = (topicPrefix: string) => normalizeConfig({ mqtt: { ...defaultConfig().mqtt, topicPrefix } }).mqtt.topicPrefix;
    expect(prefixOf('ha/')).toBe('ha');
    expect(prefixOf('/ha')).toBe('ha');
    expect(prefixOf('ha//timbre')).toBe('ha/timbre');
    expect(prefixOf('/')).toBe('timbre');
  });
});
