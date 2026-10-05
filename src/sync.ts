import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { AuthError, type DocMeta, getDoc, getFormattedMarkdown, getMe, listChildren } from './api.ts';
import { config, docUrl } from './config.ts';
import {
  formatDate,
  latestSnapshot,
  type Manifest,
  type ManifestEntry,
  META_DIR,
  readManifest,
  snapshotName,
} from './snapshots.ts';
import { yjsToMarkdown } from './yjs-to-markdown.ts';

type ContentSource = Manifest['contentSource'];

interface Node {
  entry: ManifestEntry;
  /** Markdown brut, avant réécriture des liens internes. */
  body: string;
  copied: boolean;
}

export interface SyncResult {
  dir: string;
  manifest: Manifest;
}

export async function sync(rootId: string, { force = false } = {}): Promise<SyncResult> {
  const me = await getMe();
  console.log(`Connecté en tant que ${me.email}`);

  const root = await getDoc(rootId);
  const source: ContentSource = 'content' in root ? 'yjs' : 'formatted-content';

  // Instantané précédent : permet de recopier les documents inchangés.
  const previous = force ? undefined : latestSnapshot(rootId);
  const prevById = new Map<string, ManifestEntry>();
  if (previous) {
    for (const e of readManifest(previous.dir).documents) if (!e.error) prevById.set(e.id, e);
  }
  const prevRaw = (id: string) => {
    const f = previous && join(previous.dir, META_DIR, 'raw', `${id}.md`);
    return f && existsSync(f) ? readFileSync(f, 'utf8') : undefined;
  };

  const now = new Date();
  let name = snapshotName(rootId, now);
  for (let i = 2; existsSync(join(config.dataDir, name)); i++) name = `${snapshotName(rootId, now)}-${i}`;
  const finalDir = join(config.dataDir, name);
  const tmpDir = join(config.dataDir, `.${name}.partial`);

  const nodes: Node[] = [];
  const limit = createLimiter(config.concurrency);
  let done = 0;
  const progress = () => {
    if (process.stderr.isTTY) process.stderr.write(`\r${++done} document(s) traité(s)…`);
  };

  // Les noms sont attribués dans l'ordre de Docs, avant tout parallélisme : résultat stable.
  const fileFor = (meta: DocMeta, dir: string) =>
    posix.join(dir, `${uniqueName(usedNames, dir, sanitize(meta.title?.trim() || 'Sans titre'))}.md`);
  const usedNames = new Map<string, Set<string>>();

  // Le limiteur n'encadre que les requêtes, jamais la récursion (sinon blocage).
  async function visit(meta: DocMeta, parentId: string | null, file: string, full?: DocMeta) {
    const entry: ManifestEntry = {
      id: meta.id,
      title: meta.title?.trim() || 'Sans titre',
      parentId,
      depth: meta.depth,
      updated_at: meta.updated_at,
      file,
      url: docUrl(meta.id),
    };
    const node: Node = { entry, body: '', copied: false };
    nodes.push(node);

    const cached = prevById.get(meta.id)?.updated_at === meta.updated_at ? prevRaw(meta.id) : undefined;
    if (cached !== undefined) {
      node.body = cached;
      node.copied = true;
    } else {
      try {
        node.body = await limit(async () => fetchBody(full ?? (await getDoc(meta.id)), source));
      } catch (e) {
        if (e instanceof AuthError) throw e;
        entry.error = (e as Error).message;
      }
    }
    progress();

    if (meta.numchild > 0) {
      const children = await limit(async () => {
        const list: DocMeta[] = [];
        for await (const child of listChildren(meta.id)) list.push(child);
        return list;
      });
      const childDir = file.slice(0, -'.md'.length);
      const files = children.map((c) => fileFor(c, childDir));
      await Promise.all(children.map((c, i) => visit(c, meta.id, files[i])));
    }
  }

  try {
    await visit(root, null, fileFor(root, ''), root);
  } finally {
    if (process.stderr.isTTY) process.stderr.write('\n');
  }

  writeSnapshot(tmpDir, nodes);
  const manifest: Manifest = {
    rootId,
    rootTitle: nodes[0].entry.title,
    syncedAt: now.toISOString(),
    contentSource: source,
    documents: nodes.map((n) => n.entry),
  };
  writeFileSync(join(tmpDir, META_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: FILE_MODE,
  });
  renameSync(tmpDir, finalDir);

  printSummary(nodes, finalDir, previous?.name);
  return { dir: finalDir, manifest };
}

async function fetchBody(doc: DocMeta, source: ContentSource): Promise<string> {
  if (source === 'yjs') return doc.content ? yjsToMarkdown(doc.content) : '';
  return getFormattedMarkdown(doc.id);
}

// Documents privés : dossiers et fichiers lisibles par l'utilisateur seul.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function writeSnapshot(dir: string, nodes: Node[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, META_DIR, 'raw'), { recursive: true, mode: DIR_MODE });
  const fileById = new Map(nodes.map((n) => [n.entry.id, n.entry.file]));

  for (const { entry, body } of nodes) {
    writeFileSync(join(dir, META_DIR, 'raw', `${entry.id}.md`), body, { mode: FILE_MODE });
    const frontMatter = [
      '---',
      `id: ${entry.id}`,
      `title: ${JSON.stringify(entry.title)}`,
      `url: ${entry.url}`,
      `updated_at: ${entry.updated_at}`,
      ...(entry.error ? [`error: ${JSON.stringify(entry.error)}`] : []),
      '---',
      '',
    ].join('\n');
    const content = rewriteDocLinks(body, entry.file, fileById);
    const path = safeJoin(dir, entry.file);
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    writeFileSync(path, frontMatter + content, { mode: FILE_MODE });
  }
}

/** Liens vers des documents Docs de l'instantané → liens relatifs (navigables dans Obsidian). */
function rewriteDocLinks(body: string, from: string, fileById: Map<string, string>): string {
  const base = config.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\]\\(${base}/docs/([0-9a-f-]{36})/?(#[^)\\s]*)?\\)`, 'g');
  return body.replace(re, (match, id: string, anchor = '') => {
    const target = fileById.get(id);
    if (!target) return match;
    return `](<${posix.relative(posix.dirname(from), target)}${anchor}>)`;
  });
}

function printSummary(nodes: Node[], dir: string, previousName?: string): void {
  const subs = nodes.length - 1;
  const copied = nodes.filter((n) => n.copied).length;
  const errors = nodes.filter((n) => n.entry.error);

  console.log(`\n${nodes.length} document(s) récupéré(s) : 1 document + ${subs} sous-document(s).`);
  if (copied) console.log(`  dont ${copied} inchangé(s), recopié(s) depuis ${previousName}`);
  if (errors.length) {
    console.log(`  dont ${errors.length} en erreur :`);
    for (const n of errors) console.log(`    - ${n.entry.file} : ${n.entry.error}`);
  }

  const latest = nodes
    .slice(1)
    .reduce<Node | undefined>((a, n) => (!a || n.entry.updated_at > a.entry.updated_at ? n : a), undefined);
  if (latest) {
    console.log(
      `Dernière modification d'un sous-document : ${formatDate(new Date(latest.entry.updated_at))} — ${latest.entry.file}`,
    );
  }
  console.log(`Racine modifiée le ${formatDate(new Date(nodes[0].entry.updated_at))}`);
  console.log(`Instantané : ${dir}`);
}

/** Chemin dans l'instantané : les titres venant du serveur ne doivent jamais en sortir. */
export function safeJoin(root: string, relativePath: string): string {
  const base = resolve(root);
  const path = resolve(base, relativePath);
  if (!path.startsWith(base + sep)) throw new Error(`Chemin hors de l'instantané refusé : ${relativePath}`);
  return path;
}

/** Nom de fichier utilisable partout (et dans les liens Obsidian). */
export function sanitize(title: string): string {
  const s = title
    // Caractères invisibles (espace de largeur nulle, marques de direction…) : retirés.
    .replace(/\p{Cf}/gu, '')
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    // Ni point initial (fichier caché, ignoré par rg et Obsidian) ni final.
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return s || 'Sans titre';
}

/** Suffixe « (2) », « (3) »… en cas de doublon entre frères (insensible à la casse, comme macOS). */
function uniqueName(usedNames: Map<string, Set<string>>, dir: string, name: string): string {
  const used = usedNames.get(dir) ?? new Set();
  usedNames.set(dir, used);
  let candidate = name;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${name} (${i})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
