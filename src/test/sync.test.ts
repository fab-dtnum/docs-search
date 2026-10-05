import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { id, SESSION, startFakeDocs, type FakeServer } from './fake-docs.ts';

let server: FakeServer;
let dataDir: string;
// Chargés après la configuration de l'environnement (config.ts le lit à l'import).
let sync: typeof import('../sync.ts').sync;
let config: typeof import('../config.ts').config;

before(async () => {
  server = await startFakeDocs();
  dataDir = mkdtempSync(join(tmpdir(), 'docs-search-'));
  Object.assign(process.env, { DOCS_BASE_URL: server.url, DOCS_SESSIONID: SESSION, DOCS_DATA_DIR: dataDir });
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
