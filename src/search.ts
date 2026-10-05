import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { UserError } from './config.ts';
import { formatDate, latestSnapshot, readManifest } from './snapshots.ts';
import { sync } from './sync.ts';

export type SyncMode = 'ask' | 'yes' | 'no';

/** Recherche ripgrep dans l'instantané du jour (ou propose d'en refaire un). Renvoie le code de sortie de rg. */
export async function search(rootId: string, rgArgs: string[], mode: SyncMode): Promise<number> {
  if (spawnSync('rg', ['--version']).error) {
    throw new UserError('ripgrep (rg) est introuvable. Installez-le : brew install ripgrep');
  }
  if (!rgArgs.length) throw new UserError('Indiquez un motif de recherche (syntaxe ripgrep).');

  const dir = await pickSnapshot(rootId, mode);
  const baseArgs = ['--glob', '*.md', ...rgArgs];

  // Chemin explicite : sans lui, rg lit l'entrée standard quand ce n'est pas un terminal.
  const rg = spawnSync('rg', [...baseArgs, '.'], { cwd: dir, stdio: 'inherit' });
  if (rg.status !== 0) return rg.status ?? 2;

  // Liens vers Docs pour les fichiers trouvés.
  const files = spawnSync('rg', [...baseArgs, '--files-with-matches', '--color', 'never', '.'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^\.\//, ''));
  const byFile = new Map(readManifest(dir).documents.map((d) => [d.file, d]));
  const links = files.flatMap((f) => (byFile.has(f) ? [[f, byFile.get(f)!.url]] : []));
  if (links.length) {
    console.log(`\nLiens (${links.length} document(s)) :`);
    for (const [file, url] of links) console.log(`  ${file}\n    → ${url}`);
  }
  return 0;
}

async function pickSnapshot(rootId: string, mode: SyncMode): Promise<string> {
  const snap = latestSnapshot(rootId);

  if (!snap) {
    if (mode === 'no') throw new UserError(`Aucun instantané pour ${rootId}. Lancez : pnpm run sync ${rootId}`);
    if (mode === 'ask' && !(await confirm(`Aucun instantané pour ce document. Le télécharger maintenant ? [O/n] `, true))) {
      throw new UserError('Recherche annulée.');
    }
    return (await sync(rootId)).dir;
  }

  const isToday = snap.date.toDateString() === new Date().toDateString();
  const rel = relative(process.cwd(), snap.dir);
  const label = `${rel.startsWith('..') ? snap.dir : rel} (${formatDate(snap.date)})`;
  if (mode === 'yes' || (!isToday && mode === 'ask' && (await askRefresh(snap.date)))) {
    return (await sync(rootId)).dir;
  }
  if (!isToday) console.error(`⚠ Recherche dans un instantané ancien : ${label}\n`);
  else console.error(`Instantané : ${label}\n`);
  return snap.dir;
}

async function askRefresh(date: Date): Promise<boolean> {
  const msg = `Le dernier instantané date du ${formatDate(date)}.`;
  if (!process.stdin.isTTY) {
    console.error(`${msg} (utilisez --sync pour le retélécharger)`);
    return false;
  }
  return confirm(`${msg} Retélécharger d'abord ? [o/N] `, false);
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer ? /^(o|oui|y|yes)$/.test(answer) : defaultYes;
  } finally {
    rl.close();
  }
}
