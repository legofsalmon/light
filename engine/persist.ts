import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/types.ts';
import { sanitizeProject } from '../shared/types.ts';

const DIR = process.env.LIGHT_PROJECT_DIR ?? path.join(process.cwd(), 'projects');
const BACKUPS = 5;
const CURRENT = path.join(DIR, '.current');

/** Active project slug — read once at boot, updated by new/open/save-as. */
let slug = 'default';
try {
  const s = fs.readFileSync(CURRENT, 'utf8').trim();
  if (/^[a-z0-9-]+$/.test(s)) slug = s;
} catch {
  // no pointer file — first boot or pre-multi-project install
}

function fileFor(sl: string): string {
  return path.join(DIR, `${sl}.project.json`);
}
const FILE = () => fileFor(slug);

export function projectPath(): string {
  return FILE();
}

export function currentSlug(): string {
  return slug;
}

export function setCurrentSlug(sl: string): void {
  slug = sl;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CURRENT, sl);
  } catch (err) {
    console.error('[persist] cannot write .current:', (err as Error).message);
  }
}

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

/** A slug not colliding with an existing project file. */
export function uniqueSlug(name: string): string {
  const base = slugify(name);
  if (!fs.existsSync(fileFor(base))) return base;
  for (let i = 2; i < 100; i++) {
    if (!fs.existsSync(fileFor(`${base}-${i}`))) return `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

export function listProjects(): { slug: string; name: string }[] {
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.project.json'))
      .map((f) => {
        const sl = f.slice(0, -'.project.json'.length);
        let name = sl;
        try {
          name = String(JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).name ?? sl);
        } catch {
          name = `${sl} (unreadable)`;
        }
        return { slug: sl, name };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
}

/** Load a specific project file (no backup fallback — used by open). */
export function loadSlug(sl: string): Project | null {
  return tryLoad(fileFor(sl));
}

/** Write a project under a specific slug immediately. Overwriting a slug
 *  other than the current one preserves the old file aside — save-as onto an
 *  existing show must never be able to destroy it outright. */
export function saveSlugNow(sl: string, p: Project): void {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileFor(sl);
  if (sl !== slug && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.replaced-${Date.now()}`);
    } catch (err) {
      console.error('[persist] cannot preserve replaced project:', (err as Error).message);
    }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, file);
}

/** Drop any pending debounced autosave — call before switching projects so
 *  a stale timer can never fire against the new slug. */
export function cancelPendingSave(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  dirtySince = null;
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
  if (!fs.existsSync(FILE())) {
    // the pointed-at file is gone (sync hiccup, cleanup script) — its
    // backups may still hold the show; booting a blank default here would
    // rotate them into oblivion within five autosaves
    for (let i = 1; i <= BACKUPS; i++) {
      const p = tryLoad(`${FILE()}.bak${i}`);
      if (p) {
        console.error(`[persist] ${path.basename(FILE())} missing — recovered from .bak${i}`);
        saveProjectNow(p);
        return p;
      }
    }
    if (slug !== 'default') {
      console.error(`[persist] project "${slug}" has no file or backups — falling back to default`);
      setCurrentSlug('default');
      return loadProject();
    }
    return null;
  }
  const main = tryLoad(FILE());
  if (main) return main;

  console.error('[persist] project file is corrupt — trying backups');
  for (let i = 1; i <= BACKUPS; i++) {
    const p = tryLoad(`${FILE()}.bak${i}`);
    if (p) {
      console.error(`[persist] recovered from ${path.basename(FILE())}.bak${i}`);
      try {
        fs.renameSync(FILE(), `${FILE()}.corrupt-${Date.now()}`);
        saveProjectNow(p); // restore a good main file immediately
      } catch {
        // best effort — the recovered project is still returned
      }
      return p;
    }
  }
  try {
    const aside = `${FILE()}.corrupt-${Date.now()}`;
    fs.renameSync(FILE(), aside);
    console.error(`[persist] no readable backup — corrupt file preserved at ${aside}`);
  } catch {
    // nothing more we can do
  }
  return null;
}

function rotateBackups(): void {
  try {
    for (let i = BACKUPS - 1; i >= 1; i--) {
      const from = `${FILE()}.bak${i}`;
      const to = `${FILE()}.bak${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    if (fs.existsSync(FILE())) fs.copyFileSync(FILE(), `${FILE()}.bak1`);
  } catch {
    // backups are best-effort
  }
}

export function saveProjectNow(p: Project): string {
  fs.mkdirSync(DIR, { recursive: true });
  rotateBackups();
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 1));
  fs.renameSync(tmp, FILE());
  return FILE();
}

/** Fully async save — never blocks the render thread. The target file is
 *  resolved once on entry: a project switch mid-await must not redirect the
 *  write to the new slug. */
async function saveProjectAsync(p: Project): Promise<void> {
  const file = FILE();
  await fs.promises.mkdir(DIR, { recursive: true });
  rotateBackups(); // rename/copy of small files; sub-ms
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(p, null, 1));
  await fs.promises.rename(tmp, file);
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
