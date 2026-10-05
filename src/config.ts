import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ENV_FILE = resolve('.env');

if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export class UserError extends Error {}

/** HTTPS obligatoire (le cookie de session y transite), sauf en local pour les tests. */
export function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserError(`DOCS_BASE_URL invalide : ${raw}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new UserError(`DOCS_BASE_URL doit être en https : ${raw}`);
  }
  return url.origin;
}

function loadBaseUrl(): string {
  try {
    return parseBaseUrl(process.env.DOCS_BASE_URL ?? 'https://docs.numerique.gouv.fr');
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

export const config = {
  baseUrl: loadBaseUrl(),
  sessionId: process.env.DOCS_SESSIONID ?? '',
  dataDir: resolve(process.env.DOCS_DATA_DIR ?? 'data'),
  concurrency: Math.max(1, Number(process.env.DOCS_CONCURRENCY ?? 4) || 4),
};

/** Format d'un identifiant de session Django : empêche toute injection d'en-tête ou de ligne dans .env. */
const SESSION_RE = /^[A-Za-z0-9]{1,256}$/;
export const isValidSessionId = (v: string) => SESSION_RE.test(v);

export function requireSession(): string {
  if (!config.sessionId) {
    throw new UserError(
      'Aucune session : DOCS_SESSIONID est vide dans .env.\n' +
        'Lancez `pnpm docs:login` pour vous connecter via ProConnect.',
    );
  }
  if (!isValidSessionId(config.sessionId)) {
    throw new UserError('DOCS_SESSIONID a un format inattendu. Relancez `pnpm docs:login`.');
  }
  return config.sessionId;
}

/** Écrit (ou remplace) une variable dans .env sans toucher aux autres lignes. */
export function setEnvVar(key: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new UserError(`Valeur invalide pour ${key}`);
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600); // mode ignoré si le fichier existait déjà
  process.env[key] = value;
  if (key === 'DOCS_SESSIONID') config.sessionId = value;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accepte un UUID ou une URL Docs complète. */
export function parseDocId(input: string | undefined): string {
  const m = input?.match(UUID_RE);
  if (!m) throw new UserError(`Identifiant de document invalide : ${input ?? '(manquant)'}`);
  return m[0].toLowerCase();
}

export const docUrl = (id: string) => `${config.baseUrl}/docs/${id}/`;
