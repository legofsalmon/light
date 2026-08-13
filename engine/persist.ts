import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/types.ts';
import { sanitizeProject } from '../shared/types.ts';

const DIR = process.env.LIGHT_PROJECT_DIR ?? path.join(process.cwd(), 'projects');
const FILE = path.join(DIR, 'default.project.json');
const BACKUPS = 5;

export function projectPath(): string {
  return FILE;
}

function tryLoad(file: string): Project | null {
  try {
    const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Project;
    return sanitizeProject(p);
  } catch {
    return null;
  }
}

/**
 * Load the project — falling back through the rotating backups if the main
 * file is corrupt. A corrupt main file is preserved aside (never silently
 * replaced, never rotated over the good backups).
 */
export function loadProject(): Project | null {
  if (!fs.existsSync(FILE)) return null;
  const main = tryLoad(FILE);
  if (main) return main;

  console.error('[persist] project file is corrupt — trying backups');
  for (let i = 1; i <= BACKUPS; i++) {
    const p = tryLoad(`${FILE}.bak${i}`);
    if (p) {
      console.error(`[persist] recovered from ${path.basename(FILE)}.bak${i}`);
      try {
        fs.renameSync(FILE, `${FILE}.corrupt-${Date.now()}`);
        saveProjectNow(p); // restore a good main file immediately
      } catch {
        // best effort — the recovered project is still returned
      }
      return p;
    }
  }
  try {
    const aside = `${FILE}.corrupt-${Date.now()}`;
    fs.renameSync(FILE, aside);
    console.error(`[persist] no readable backup — corrupt file preserved at ${aside}`);
  } catch {
    // nothing more we can do
  }
  return null;
}

function rotateBackups(): void {
  try {
    for (let i = BACKUPS - 1; i >= 1; i--) {
      const from = `${FILE}.bak${i}`;
      const to = `${FILE}.bak${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(FILE)) fs.copyFileSync(FILE, `${FILE}.bak1`);
  } catch {
    // backups are best-effort
  }
}

export function saveProjectNow(p: Project): string {
  fs.mkdirSync(DIR, { recursive: true });
  rotateBackups();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, FILE);
  return FILE;
}

/** Fully async save — never blocks the render thread. */
async function saveProjectAsync(p: Project): Promise<void> {
  await fs.promises.mkdir(DIR, { recursive: true });
  rotateBackups(); // rename/copy of small files; sub-ms
  const tmp = `${FILE}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(p, null, 1));
  await fs.promises.rename(tmp, FILE);
}

let timer: NodeJS.Timeout | null = null;
let dirtySince: number | null = null;

/** Debounced autosave with a bounded maximum latency: quiet for 1.2 s OR
 *  dirty for 10 s, whichever comes first — continuous editing can no longer
 *  postpone persistence indefinitely. */
export function saveProjectDebounced(get: () => Project, delayMs = 1200): void {
  const now = Date.now();
  dirtySince ??= now;
  const overdue = now - dirtySince >= 10_000;
  if (timer) clearTimeout(timer);
  timer = setTimeout(
    () => {
      timer = null;
      dirtySince = null;
      saveProjectAsync(get()).catch((err) => {
        console.error('[persist] autosave failed:', (err as Error).message);
      });
    },
    overdue ? 0 : delayMs
  );
}
