import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';

export interface ManifestEntry {
  id: string;
  title: string;
  parentId: string | null;
  depth: number;
  updated_at: string;
  /** Chemin du .md, relatif à la racine de l'instantané. */
  file: string;
  url: string;
  error?: string;
}

export interface Manifest {
  rootId: string;
  rootTitle: string;
  syncedAt: string;
  contentSource: 'yjs' | 'formatted-content';
  documents: ManifestEntry[];
}

export interface Snapshot {
  dir: string;
  name: string;
  date: Date;
}

export const META_DIR = '.docs-search';
const NAME_RE = /^(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{2})h(\d{2})(?:-\d+)?$/;

export function snapshotName(rootId: string, date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${rootId}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}h${p(date.getMinutes())}`;
}

/** Instantanés existants d'un document, du plus ancien au plus récent. */
export function listSnapshots(rootId?: string): (Snapshot & { rootId: string })[] {
  if (!existsSync(config.dataDir)) return [];
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const m = d.name.match(NAME_RE);
      if (!m || (rootId && m[1] !== rootId)) return [];
      const [, id, y, mo, da, h, mi] = m;
      const dir = join(config.dataDir, d.name);
      if (!existsSync(join(dir, META_DIR, 'manifest.json'))) return [];
      return [{ rootId: id, dir, name: d.name, date: new Date(+y, +mo - 1, +da, +h, +mi) }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const latestSnapshot = (rootId: string) => listSnapshots(rootId).at(-1);

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, META_DIR, 'manifest.json'), 'utf8'));
}

export const formatDate = (d: Date) =>
  d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).replace(':', 'h').replace(' ', ' à ');
