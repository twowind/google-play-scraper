import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function onFailedHtml(html: string): void {
  try {
    const path = join(
      tmpdir(),
      `gps-failed-${Date.now().toString()}-${randomUUID().slice(0, 8)}.html`,
    );
    writeFileSync(path, html);
  } catch {
    return;
  }
}
