import { createHash } from 'node:crypto';
import {
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { AuthError, type DocMeta, RateLimitError, getDoc, getFormattedMarkdown, getMe, getMedia, listChildren } from './api.ts';
import { config, docUrl, UserError } from './config.ts';
import {
  formatDate,
  latestSnapshot,
  type Manifest,
  type ManifestEntry,
  META_DIR,
  type PartialSync,
  partialDir,
  readManifest,
  readPartial,
  snapshotName,
} from './snapshots.ts';
import { yjsToMarkdown } from './yjs-to-markdown.ts';

type ContentSource = Manifest['contentSource'];

interface Node {
  entry: ManifestEntry;
  /** Markdown brut, avant réécriture des liens internes. */
  body: string;
  /** Téléchargé, recopié de l'instantané précédent, ou repris d'une synchronisation interrompue. */
  origin: 'fetched' | 'copied' | 'resumed';
  /** Chemin `/media/…` → fichier local à recopier dans l'instantané. */
  sources: Map<string, string>;
}

export interface SyncResult {
  dir: string;
  manifest: Manifest;
}

export async function sync(rootId: string, { force = false } = {}): Promise<SyncResult> {
  const startedAt = Date.now();
  const me = await getMe();
  console.log(`Connecté en tant que ${me.email}`);

  const root = await getDoc(rootId);
  const source: ContentSource = 'content' in root ? 'yjs' : 'formatted-content';

  // Synchronisation interrompue : ses documents sont réutilisés s'ils n'ont pas changé depuis.
  const partial = openPartial(rootId, root.title?.trim() || 'Sans titre', force);
  if (partial.done.size) {
    console.log(
      `Reprise de la synchronisation interrompue du ${formatDate(partial.startedAt)} : ` +
        `${partial.done.size} document(s) déjà téléchargé(s).`,
    );
  }
  // Réutilisé seulement s'il est au journal et inchangé dans Docs (updated_at de la liste des enfants).
  const resumedRaw = (meta: DocMeta) =>
    partial.done.get(meta.id) === meta.updated_at
      ? readFileSync(join(partial.dir, 'raw', `${meta.id}.md`), 'utf8')
      : undefined;

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
  // Recopiée de l'instantané précédent ou du dossier de reprise si son chemin est immuable (voir isImmutableMedia).
  const prevMedia = new Map<string, string>();
  for (const e of prevById.values()) {
    for (const a of e.attachments ?? []) if (a.file) prevMedia.set(a.media, safeJoin(previous!.dir, a.file));
  }

  const now = new Date();
  let name = snapshotName(rootId, now);
  for (let i = 2; existsSync(join(config.dataDir, name)); i++) name = `${snapshotName(rootId, now)}-${i}`;
  const finalDir = join(config.dataDir, name);
  const tmpDir = join(config.dataDir, `.${name}.writing`);

  const nodes: Node[] = [];
  const limiter = createLimiter(config.concurrency);
  // Première erreur fatale : plus aucune requête ensuite, les autres branches s'arrêtent d'elles-mêmes.
  let aborted: { error: unknown } | undefined;
  const limit = <T>(fn: () => Promise<T>) =>
    limiter(() => {
      if (aborted) throw aborted.error;
      return fn();
    });
  let done = 0;
  const progress = () => {
    if (process.stderr.isTTY) process.stderr.write(`\r${++done} document(s) traité(s)…`);
  };

  // Les noms sont attribués dans l'ordre de Docs, avant tout parallélisme : résultat stable.
  const fileFor = (meta: DocMeta, dir: string) =>
    posix.join(dir, `${uniqueName(usedNames, dir, sanitize(meta.title?.trim() || 'Sans titre'))}.md`);
  const usedNames = new Map<string, Set<string>>();

  // Une pièce jointe liée depuis plusieurs documents n'est téléchargée qu'une fois.
  const mediaDownloads = new Map<string, Promise<string>>();
  const downloadMedia = (media: string) => {
    let p = mediaDownloads.get(media);
    if (!p) {
      p = (async () => {
        const cached = join(partial.dir, 'attachments', mediaKey(media));
        if (isImmutableMedia(media)) {
          if (existsSync(cached)) return cached;
          const previousCopy = prevMedia.get(media);
          if (previousCopy && existsSync(previousCopy)) return previousCopy;
        }
        const data = await limit(() => getMedia(media));
        mkdirSync(dirname(cached), { recursive: true, mode: DIR_MODE });
        writeFileSync(`${cached}.tmp`, data, { mode: FILE_MODE });
        renameSync(`${cached}.tmp`, cached);
        return cached;
      })();
      mediaDownloads.set(media, p);
    }
    return p;
  };

  async function fetchAttachments(node: Node) {
    const medias = [...new Set(findAttachments(node.body).map((a) => a.media))];
    if (!medias.length) return;
    node.entry.attachments = medias.map((media) => ({ media }));
    const results = await Promise.allSettled(
      node.entry.attachments.map(async (a) => {
        try {
          node.sources.set(a.media, await downloadMedia(a.media));
        } catch (e) {
          if (e instanceof AuthError || e instanceof RateLimitError) throw (aborted ??= { error: e }).error;
          a.error = (e as Error).message;
        }
      }),
    );
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

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
    const node: Node = { entry, body: '', origin: 'fetched', sources: new Map() };
    nodes.push(node);

    const resumed = resumedRaw(meta);
    const copied = prevById.get(meta.id)?.updated_at === meta.updated_at ? prevRaw(meta.id) : undefined;
    if (resumed !== undefined) {
      node.body = resumed;
      node.origin = 'resumed';
    } else if (copied !== undefined) {
      node.body = copied;
      node.origin = 'copied';
    } else {
      try {
        // `formatted-content` n'a besoin que de l'id : pas de lecture du document, une requête de moins.
        node.body = await limit(async () =>
          fetchBody(full ?? (source === 'yjs' ? await getDoc(meta.id) : meta), source),
        );
        recordPartial(partial, meta, node.body);
      } catch (e) {
        if (e instanceof AuthError || e instanceof RateLimitError) throw (aborted ??= { error: e }).error;
        entry.error = (e as Error).message;
      }
    }
    await fetchAttachments(node);
    progress();

    if (meta.numchild > 0) {
      const children = await limit(async () => {
        const list: DocMeta[] = [];
        for await (const child of listChildren(meta.id)) list.push(child);
        return list;
      }).catch((e) => {
        throw (aborted ??= { error: e }).error;
      });
      const childDir = file.slice(0, -'.md'.length);
      const files = children.map((c) => fileFor(c, childDir));
      // Toutes les branches terminées avant de rendre la main : le journal de reprise est alors complet.
      const results = await Promise.allSettled(children.map((c, i) => visit(c, meta.id, files[i])));
      if (results.some((r) => r.status === 'rejected')) throw aborted!.error;
    }
  }

  try {
    await visit(root, null, fileFor(root, ''), root);
  } catch (e) {
    throw interrupted(e, rootId, partial);
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
  rmSync(partial.dir, { recursive: true, force: true });

  printSummary(nodes, finalDir, previous?.name);
  console.log(`Durée : ${formatDuration(Date.now() - startedAt)}`);
  return { dir: finalDir, manifest };
}

function openPartial(rootId: string, rootTitle: string, force: boolean): PartialSync {
  const dir = partialDir(rootId);
  if (force) rmSync(dir, { recursive: true, force: true });
  const existing = readPartial(rootId);
  if (existing) return existing;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'raw'), { recursive: true, mode: DIR_MODE });
  const startedAt = new Date();
  writeFileSync(join(dir, 'partial.json'), JSON.stringify({ rootId, rootTitle, startedAt }), { mode: FILE_MODE });
  return { dir, rootId, rootTitle, startedAt, done: new Map() };
}

/** Le fichier d'abord, la ligne du journal ensuite : un fichier sans ligne (arrêt brutal) est retéléchargé. */
function recordPartial(partial: PartialSync, meta: DocMeta, body: string): void {
  writeFileSync(join(partial.dir, 'raw', `${meta.id}.md`), body, { mode: FILE_MODE });
  const line = JSON.stringify({ id: meta.id, updated_at: meta.updated_at });
  appendFileSync(join(partial.dir, 'journal.jsonl'), `${line}\n`, { mode: FILE_MODE });
  partial.done.set(meta.id, meta.updated_at);
}

/** Erreur d'une synchronisation interrompue, complétée de la marche à suivre pour reprendre. */
function interrupted(e: unknown, rootId: string, partial: PartialSync): unknown {
  if (!partial.done.size) {
    rmSync(partial.dir, { recursive: true, force: true });
    return e;
  }
  const hint =
    `${partial.done.size} document(s) déjà téléchargé(s) sont conservés. ` +
    `Relancez \`pnpm docs:sync ${rootId}\` pour reprendre là où la synchronisation s'est arrêtée.`;
  if (!(e instanceof UserError)) {
    console.error(hint);
    return e;
  }
  e.message += `\n\n${hint}`;
  return e;
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
  // Les pièces jointes partagent le dossier des sous-documents : aucun nom ne doit en écraser un autre.
  const usedFiles = new Set(nodes.map((n) => n.entry.file.toLowerCase()));

  for (const { entry, body, sources } of nodes) {
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
    const fileByMedia = writeAttachments(dir, entry, body, sources, usedFiles);
    const content = rewriteAttachmentLinks(rewriteDocLinks(body, entry.file, fileById), entry.file, fileByMedia);
    const path = safeJoin(dir, entry.file);
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    writeFileSync(path, frontMatter + content, { mode: FILE_MODE });
  }
}

/**
 * Copie les pièces jointes d'un document dans le dossier du même nom que son .md
 * (`Projet X.md` → `Projet X/`), nommées d'après le texte du lien (`image.png`, `rapport.pdf`).
 */
function writeAttachments(
  dir: string,
  entry: ManifestEntry,
  body: string,
  sources: Map<string, string>,
  usedFiles: Set<string>,
): Map<string, string> {
  const fileByMedia = new Map<string, string>();
  const textByMedia = new Map<string, string>();
  for (const a of findAttachments(body)) if (!textByMedia.get(a.media)) textByMedia.set(a.media, a.text);
  const attachmentDir = entry.file.slice(0, -'.md'.length);

  for (const a of entry.attachments ?? []) {
    const source = sources.get(a.media);
    if (!source) continue;
    const ext = posix.extname(new URL(a.media, 'http://x').pathname).toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
    const text = textByMedia.get(a.media)?.trim() ?? '';
    const stem = text.toLowerCase().endsWith(safeExt) ? text.slice(0, text.length - safeExt.length) : text;
    const base = sanitize(stem || posix.basename(a.media, ext));
    let file = posix.join(attachmentDir, `${base}${safeExt}`);
    for (let i = 2; usedFiles.has(file.toLowerCase()); i++) file = posix.join(attachmentDir, `${base} (${i})${safeExt}`);
    usedFiles.add(file.toLowerCase());

    const path = safeJoin(dir, file);
    mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE });
    // Clone APFS/Btrfs quand c'est possible : pas d'espace disque en plus d'un instantané à l'autre.
    copyFileSync(source, path, constants.COPYFILE_FICLONE);
    a.file = file;
    fileByMedia.set(a.media, file);
  }
  return fileByMedia;
}

/**
 * Docs ne réécrit jamais une pièce jointe : chaque envoi crée `/media/<doc>/attachments/<uuid4>.<ext>`
 * (UUID tiré au hasard, remplacer une image en crée une nouvelle). Même chemin, même contenu :
 * une copie locale suffit. Tout autre chemin est retéléchargé à chaque synchronisation.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IMMUTABLE_MEDIA_RE = new RegExp(`^/media/${UUID}/attachments/${UUID}\\.[A-Za-z0-9]{1,10}$`);
export const isImmutableMedia = (media: string) => IMMUTABLE_MEDIA_RE.test(media);

/** « 42 s », « 3 min 05 s ». */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Nom de la copie d'une pièce jointe dans le dossier de reprise : fixe, et sans rien de venu du serveur. */
const mediaKey = (media: string) => createHash('sha256').update(media).digest('hex').slice(0, 32);

/** `![texte](https://docs…/media/…)` ou `[texte](/media/…)` : pièces jointes hébergées par Docs. */
function attachmentRe(): RegExp {
  const base = config.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[([^\\]]*)\\]\\((?:${base})?(/media/[^)\\s]+)\\)`, 'g');
}

export function findAttachments(body: string): { text: string; media: string }[] {
  return [...body.matchAll(attachmentRe())].map((m) => ({ text: m[1], media: m[2] }));
}

/** Liens vers les pièces jointes téléchargées → liens relatifs ; les autres gardent l'URL de Docs. */
function rewriteAttachmentLinks(body: string, from: string, fileByMedia: Map<string, string>): string {
  return body.replace(attachmentRe(), (match, text: string, media: string) => {
    const target = fileByMedia.get(media);
    if (!target) return match;
    return `[${text}](<${posix.relative(posix.dirname(from), target)}>)`;
  });
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
  const copied = nodes.filter((n) => n.origin === 'copied').length;
  const resumed = nodes.filter((n) => n.origin === 'resumed').length;
  const errors = nodes.filter((n) => n.entry.error);

  console.log(`\n${nodes.length} document(s) récupéré(s) : 1 document + ${subs} sous-document(s).`);
  if (resumed) console.log(`  dont ${resumed} repris de la synchronisation interrompue`);
  if (copied) console.log(`  dont ${copied} inchangé(s), recopié(s) depuis ${previousName}`);
  if (errors.length) {
    console.log(`  dont ${errors.length} en erreur :`);
    for (const n of errors) console.log(`    - ${n.entry.file} : ${n.entry.error}`);
  }
  const attachments = nodes.flatMap((n) => (n.entry.attachments ?? []).map((a) => ({ ...a, doc: n.entry.file })));
  if (attachments.length) {
    const failed = attachments.filter((a) => a.error);
    console.log(`${attachments.length} pièce(s) jointe(s) (images, fichiers)${failed.length ? `, dont ${failed.length} en erreur :` : '.'}`);
    for (const a of failed) console.log(`    - ${a.doc} : ${a.media} — ${a.error}`);
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
