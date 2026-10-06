import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { docs, id, SESSION, startFakeDocs, type FakeServer } from './fake-docs.ts';

let server: FakeServer;
let dataDir: string;
// Chargés après la configuration de l'environnement (config.ts le lit à l'import).
let sync: typeof import('../sync.ts').sync;
let config: typeof import('../config.ts').config;

before(async () => {
  server = await startFakeDocs();
  dataDir = mkdtempSync(join(tmpdir(), 'docs-search-'));
  Object.assign(process.env, { DOCS_BASE_URL: server.url, DOCS_SESSIONID: SESSION, DOCS_DATA_DIR: dataDir, DOCS_RATE_PER_MINUTE: '100000' });
  ({ sync } = await import('../sync.ts'));
  ({ config } = await import('../config.ts'));
});
after(() => server.close());

const quiet = <T>(t: import('node:test').TestContext, fn: () => Promise<T>) => {
  t.mock.method(console, 'log', () => {});
  return fn();
};

function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !relative(dir, e.parentPath).startsWith('.docs-search'))
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

// Asynchrone : un appel bloquant figerait aussi la fausse API, qui tourne dans ce processus.
function cli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, ['src/cli.ts', ...args], { env }, (err, stdout, stderr) =>
      resolve({ status: err ? Number(err.code) : 0, stdout, stderr }),
    );
    child.stdin?.end(); // entrée standard qui n'est pas un terminal
  });
}

test('sync : arborescence Obsidian, Markdown, liens internes, droits', async (t) => {
  const { dir, manifest } = await quiet(t, () => sync(id(1)));

  assert.match(dir, new RegExp(`${id(1)}-\\d{4}-\\d{2}-\\d{2}-\\d{2}h\\d{2}$`));
  assert.equal(manifest.documents.length, 6);
  assert.deepEqual(filesOf(dir), [
    'Projet X.md',
    'Projet X/Budget.md',
    'Projet X/Réunions.md',
    'Projet X/Réunions/CR 2026 09 12 comité.md',
    'Projet X/Réunions/Sans titre.md',
    'Projet X/budget (2).md', // titre « ../budget » : nettoyé et dédoublonné
  ]);

  const root = readFileSync(join(dir, 'Projet X.md'), 'utf8');
  assert.match(root, /^---\nid: 00000000-0000-4000-8000-000000000001\ntitle: "Projet X"\n/);
  assert.match(root, /^# Présentation$/m);
  assert.match(root, /Voir le \*\*budget\*\* et \[Budget\]\(<Projet X\/Budget\.md>\) ou \[le site\]\(https:\/\/example\.org\)/);
  assert.match(root, /^- point A\n {4}- sous-point\n\n1\. un\n2\. deux\n\n- \[x\] fait$/m);
  assert.match(root, /```js\nconst a = "<div>";\n```/);
  assert.match(root, /\| Col1 \| Col2 \|\n\| --- \| --- \|\n\| a \| b\\\|c \|/);
  assert.match(readFileSync(join(dir, 'Projet X/Budget.md'), 'utf8'), /\[CR\]\(<Réunions\/CR 2026 09 12 comité\.md>\)/);

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'Projet X.md')).mode & 0o777, 0o600);
});

test("sync suivant : nouvel instantané, documents inchangés recopiés sans requête", async (t) => {
  server.requests.length = 0;
  const { dir } = await quiet(t, () => sync(id(1)));
  assert.equal(readdirSync(dataDir).length, 2);
  assert.ok(dir.endsWith(readdirSync(dataDir).sort()[1]));
  // Seuls la racine (toujours lue) et les listes d'enfants sont demandées.
  const contentRequests = server.requests.filter((r) => /^\/api\/v1\.0\/documents\/[^/]+\/$/.test(r));
  assert.deepEqual(contentRequests, [`/api/v1.0/documents/${id(1)}/`]);
});

test('search : syntaxe ripgrep et liens vers Docs', async () => {
  const r = await cli(['search', id(1), '-i', 'copil|42 k']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Budget\.md:Montant total 42 k€/);
  assert.match(r.stdout, /CR 2026 09 12 comité\.md:Décision du COPIL/);
  assert.match(r.stdout, new RegExp(`→ ${server.url}/docs/${id(5)}/`));

  assert.equal((await cli(['search', id(1), 'introuvable'])).status, 1);
});

test('search : instantané ancien signalé, sans question hors terminal', async () => {
  for (const name of readdirSync(dataDir)) {
    renameSync(join(dataDir, name), join(dataDir, name.replace(/-\d{4}-\d{2}-\d{2}-/, '-2020-01-01-')));
  }
  const r = await cli(['search', id(1), '-l', 'mot-secret']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /dernier instantané date du 01\/01\/2020/);
  assert.match(r.stderr, /--sync/);
});

test('session invalide : message clair, pas de trace', async () => {
  const r = await cli(['sync', id(1)], { ...process.env, DOCS_SESSIONID: 'mauvaise' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Session expirée ou invalide/);
  assert.doesNotMatch(r.stderr, /at .*\.ts:\d+/);
});

test("pagination vers un autre domaine : refusée avant tout envoi du cookie", async (t) => {
  server.nextOrigin = 'https://evil.example';
  try {
    await assert.rejects(quiet(t, () => sync(id(1), { force: true })), /hors de l'API Docs refusée/);
  } finally {
    server.nextOrigin = undefined;
  }
  assert.equal(config.baseUrl, server.url);
});

test('source formatted-content (production) : Markdown du serveur, liens réécrits', async (t) => {
  server.formattedContent = true;
  server.requests.length = 0;
  try {
    const { dir, manifest } = await quiet(t, () => sync(id(1), { force: true }));
    assert.equal(manifest.contentSource, 'formatted-content');
    // Seule la racine est lue en entier : le Markdown n'a besoin que de l'id.
    assert.equal(server.requests.filter((r) => /^\/api\/v1\.0\/documents\/[^/]+\/$/.test(r)).length, 1);
    assert.equal(manifest.documents.length, 6);
    const budget = readFileSync(join(dir, 'Projet X/Budget.md'), 'utf8');
    assert.match(budget, /Markdown serveur de Budget, voir \[lien\]\(<Réunions\/CR 2026 09 12 comité\.md>\)/);
  } finally {
    server.formattedContent = false;
  }
});

test("réponse de l'API sans la forme attendue : arrêt, aucun instantané écrit", async (t) => {
  const before = readdirSync(dataDir).length;
  server.brokenResponses = true;
  try {
    await assert.rejects(quiet(t, () => sync(id(1), { force: true })), /Réponse inattendue de l'API Docs/);
  } finally {
    server.brokenResponses = false;
  }
  assert.equal(readdirSync(dataDir).length, before);
});

test('429 isolé : une pause de la durée Retry-After, puis la synchronisation reprend', async (t) => {
  server.throttle = 1;
  const start = Date.now();
  const { manifest } = await quiet(t, () => sync(id(1), { force: true }));
  assert.ok(Date.now() - start >= 6000); // Retry-After (1 s) + marge (5 s)
  assert.equal(manifest.documents.filter((d) => d.error).length, 0);
});

test('reprise après interruption : seuls les documents absents du journal sont retéléchargés', async (t) => {
  const contentRequests = () => server.requests.filter((r) => /^\/api\/v1\.0\/documents\/[^/]+\/$/.test(r));
  server.throttleAfter = 6;
  await assert.rejects(quiet(t, () => sync(id(1), { force: true })), /HTTP 429[^]*conservés[^]*pnpm docs:sync/);
  server.throttleAfter = undefined;
  server.throttle = 0;

  const partial = join(dataDir, `.${id(1)}.partial`);
  const journal = readFileSync(join(partial, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
  assert.ok(journal.length >= 1 && journal.length < 6, `journal : ${journal.length}`);
  // Fichier écrit mais absent du journal (arrêt pendant l'écriture) : retéléchargé.
  const missing = Object.keys(docs).filter((d) => !journal.includes(d));
  writeFileSync(join(partial, 'raw', `${missing[0]}.md`), 'tronqu');

  // Instantanés complets mis de côté : rien ne peut en être recopié, seule la reprise joue.
  const aside = mkdtempSync(join(tmpdir(), 'docs-search-aside-'));
  const snapshots = readdirSync(dataDir).filter((n) => !n.startsWith('.'));
  for (const n of snapshots) renameSync(join(dataDir, n), join(aside, n));

  await new Promise((r) => setTimeout(r, 6100)); // fin du blocage : Retry-After + marge
  server.requests.length = 0;
  const { manifest } = await quiet(t, () => sync(id(1)));
  assert.equal(manifest.documents.length, 6);
  assert.equal(manifest.documents.filter((d) => d.error).length, 0);
  const expected = new Set([id(1), ...missing]);
  assert.deepEqual(new Set(contentRequests()), new Set([...expected].map((d) => `/api/v1.0/documents/${d}/`)));
  assert.ok(!existsSync(partial)); // instantané complet : dossier de reprise supprimé
});

test("429 persistant : arrêt de la synchronisation, sans insister", async (t) => {
  server.throttle = Infinity;
  server.requests.length = 0;
  try {
    await assert.rejects(quiet(t, () => sync(id(1), { force: true })), /HTTP 429.*interrompue/s);
    await new Promise((r) => setTimeout(r, 1500));
    // users/me puis sa seule nouvelle tentative : rien d'autre n'est envoyé.
    assert.equal(server.requests.length, 2);
  } finally {
    server.throttle = 0;
  }
});
