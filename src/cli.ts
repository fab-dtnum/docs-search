#!/usr/bin/env node
import { relative } from 'node:path';
import { parseDocId, UserError } from './config.ts';
import { applyEnvProxyToFetch } from './proxy.ts';
import { search, type SyncMode } from './search.ts';
import { formatDate, listSnapshots, readManifest } from './snapshots.ts';

const USAGE = `Usage :
  pnpm docs:login [--browser chromium|firefox]       Connexion ProConnect, enregistre la session dans .env
  pnpm docs:sync <doc_id|url> [--force]             Télécharge le document et ses sous-documents (instantané daté)
  pnpm docs:search <doc_id|url> [--sync|--no-sync] <arguments ripgrep…>
                                                      Recherche ripgrep dans l'instantané du jour
  pnpm docs:list                                    Instantanés locaux

Exemples :
  pnpm docs:sync https://docs.numerique.gouv.fr/docs/<id>/
  pnpm docs:search <id> -i "comité|copil" -C2`;

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'login': {
      const { login, parseBrowser } = await import('./login.ts');
      const i = args.indexOf('--browser');
      await login(parseBrowser(i >= 0 ? args[i + 1] : undefined));
      return 0;
    }
    case 'sync': {
      const { sync } = await import('./sync.ts');
      await sync(parseDocId(args.find((a) => !a.startsWith('-'))), { force: args.includes('--force') });
      return 0;
    }
    case 'search': {
      const mode: SyncMode = args.includes('--sync') ? 'yes' : args.includes('--no-sync') ? 'no' : 'ask';
      const rest = args.filter((a) => a !== '--sync' && a !== '--no-sync');
      const idIndex = rest.findIndex((a) => !a.startsWith('-'));
      if (idIndex < 0) throw new UserError(USAGE);
      const rootId = parseDocId(rest[idIndex]);
      return search(rootId, rest.filter((_, i) => i !== idIndex), mode);
    }
    case 'list': {
      const snaps = listSnapshots();
      if (!snaps.length) console.log('Aucun instantané.');
      for (const s of snaps) {
        const m = readManifest(s.dir);
        const rel = relative(process.cwd(), s.dir);
        console.log(
          `${formatDate(s.date)}  ${String(m.documents.length).padStart(4)} doc(s)  ${m.rootTitle}\n` +
            `  ${rel.startsWith('..') ? s.dir : rel}`,
        );
      }
      return 0;
    }
    default:
      console.log(USAGE);
      return command && !['-h', '--help', 'help'].includes(command) ? 1 : 0;
  }
}

applyEnvProxyToFetch();

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof UserError) console.error(err.message);
    else console.error(err);
    process.exit(1);
  },
);
