import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../shared/types.ts';

const DIR = process.env.LIGHT_PROJECT_DIR ?? path.join(process.cwd(), 'projects');
const FILE = path.join(DIR, 'default.project.json');
const BACKUPS = 5;

export function projectPath(): string {
  return FILE;
}

export function loadProject(): Project | null {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const p = JSON.parse(raw) as Project;
    if (p.version !== 1 || !Array.isArray(p.layers)) throw new Error('unrecognised project format');
    return p;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[persist] failed to load project:', (err as Error).message);
    }
    return null;
  }
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

let timer: NodeJS.Timeout | null = null;
export function saveProjectDebounced(get: () => Project, delayMs = 1200): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try {
      saveProjectNow(get());
    } catch (err) {
      console.error('[persist] autosave failed:', (err as Error).message);
    }
  }, delayMs);
}
