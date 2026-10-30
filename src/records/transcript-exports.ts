import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const TRANSCRIPT_EXPORT_MARKER = 'helm-phone-transcript';

/** Remove only old transcript exports written by Timbre; user files are left alone. */
export async function purgeTranscriptExports(root: string, retentionDays: number, now: Date, phoneId?: string): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  let removed = 0;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.(md|json)$/.test(entry.name)) continue;
      try {
        if ((await stat(file)).mtimeMs >= cutoff) continue;
        const header = (await readFile(file, 'utf8')).slice(0, 1000);
        if (!header.includes(TRANSCRIPT_EXPORT_MARKER)) continue;
        if (phoneId && !hasPhoneStamp(header, phoneId)) continue;
        await unlink(file);
        removed++;
      } catch { /* gone or unreadable: skip it */ }
    }
  };

  await walk(root);
  return removed;
}

function hasPhoneStamp(header: string, phoneId: string): boolean {
  const yaml = `phone_id: ${JSON.stringify(phoneId)}`;
  const json = `"phoneId": ${JSON.stringify(phoneId)}`;
  return header.split(/\r?\n/).some((line) => {
    const value = line.trim();
    return value === yaml || value === json || value === `${json},`;
  });
}
