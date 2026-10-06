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
  /** Pièces jointes (images, PDF…) liées depuis le document. */
  attachments?: AttachmentEntry[];
}

export interface AttachmentEntry {
  /** Chemin `/media/…` sur Docs. */
  media: string;
  /** Copie locale, relative à la racine de l'instantané (absente en cas d'erreur). */
  file?: string;
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

/**
 * Synchronisation interrompue : `data/.<id>.partial/`, un seul par document racine.
 * Chaque document téléchargé y est écrit aussitôt (`raw/<id>.md`), puis noté dans
 * `journal.jsonl` avec son `updated_at`. Le journal est écrit après le fichier :
 * un fichier sans ligne (arrêt pendant l'écriture) est ignoré et retéléchargé.
 * Les pièces jointes vont dans `attachments/`, sous un nom fixe tiré de leur chemin
 * `/media/…` ; écrites sous un nom temporaire puis renommées, elles sont complètes dès qu'elles existent.
 */
export interface PartialSync {
  dir: string;
  rootId: string;
  rootTitle: string;
  startedAt: Date;
  /** id → updated_at des documents déjà téléchargés. */
  done: Map<string, string>;
}

const PARTIAL_RE = /^\.(.+)\.partial$/;
export const partialDir = (rootId: string) => join(config.dataDir, `.${rootId}.partial`);

export function readPartial(rootId: string): PartialSync | undefined {
  const dir = partialDir(rootId);
  const info = join(dir, 'partial.json');
  if (!existsSync(info)) return undefined;
  const { rootTitle, startedAt } = JSON.parse(readFileSync(info, 'utf8'));
  const done = new Map<string, string>();
  const journal = join(dir, 'journal.jsonl');
  if (existsSync(journal)) {
    for (const line of readFileSync(journal, 'utf8').split('\n')) {
      // Dernière ligne tronquée par un arrêt brutal : ignorée, le document sera retéléchargé.
      try {
        const e = JSON.parse(line);
        done.set(e.id, e.updated_at);
      } catch {}
    }
  }
  return { dir, rootId, rootTitle, startedAt: new Date(startedAt), done };
}

export function listPartials(): PartialSync[] {
  if (!existsSync(config.dataDir)) return [];
  return readdirSync(config.dataDir).flatMap((name) => {
    const m = name.match(PARTIAL_RE);
    const p = m && readPartial(m[1]);
    return p ? [p] : [];
  });
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, META_DIR, 'manifest.json'), 'utf8'));
}

export const formatDate = (d: Date) =>
  d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).replace(':', 'h').replace(' ', ' à ');
