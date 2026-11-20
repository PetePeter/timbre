/** Repairs prefixes saved before levels were checked: trims and collapses '/'. */
export function tidyMqttTopicPrefix(prefix: string): string {
  return prefix.trim().replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

/** MQTT topic prefix: one or more `/`-separated levels, none empty and no wildcards. Shared by the server and the Settings page. */
export function isValidMqttTopicPrefix(prefix: string): boolean {
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix);
}
