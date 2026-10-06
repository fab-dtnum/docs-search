import { config, requireSession, UserError } from './config.ts';

export class AuthError extends UserError {
  constructor() {
    super('Session expirée ou invalide. Lancez `pnpm docs:login` pour vous reconnecter.');
  }
}

export class RateLimitError extends UserError {
  constructor(retryAfter: number) {
    super(
      `Docs limite le débit des requêtes (HTTP 429, disponible dans ${retryAfter} s). ` +
        'Synchronisation interrompue pour ne pas insister. ' +
        'Relancez dans une minute, ou baissez DOCS_RATE_PER_MINUTE.',
    );
  }
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, path: string) {
    super(`HTTP ${status} sur ${path}`);
    this.status = status;
  }
}

export interface DocMeta {
  id: string;
  title: string | null;
  updated_at: string;
  numchild: number;
  depth: number;
  path: string;
  /** Y.js encodé en base64 (absent sur les versions récentes de Docs). */
  content?: string | null;
}

interface Page<T> {
  next: string | null;
  results: T[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_S = 120;
/** Marge ajoutée au `Retry-After` du serveur, pour ne pas revenir pile à la limite. */
const RETRY_MARGIN_S = 5;

/**
 * Espacement des requêtes, partagé par tous les appels en parallèle : au plus
 * `config.ratePerMinute` requêtes par minute. Une réponse 429 repousse le prochain
 * créneau de tous les appels de la durée indiquée par `Retry-After`, plus une marge.
 */
let nextSlot = 0;
/** Après un 429 persistant, plus aucune requête avant la fin du blocage : les appels en attente échouent aussitôt. */
let blockedUntil = 0;
async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 60_000 / config.ratePerMinute;
  if (slot > now) await sleep(slot - now);
}

/** `Retry-After` en secondes ou en date HTTP ; 60 s si absent ou illisible. */
function retryAfterSeconds(res: Response): number {
  const raw = res.headers.get('retry-after');
  if (raw === null) return 60;
  const s = /^\d+$/.test(raw.trim()) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(s) ? Math.max(1, Math.ceil(s)) : 60;
}

/**
 * URL absolue d'un appel API. Les liens `next` de pagination viennent du serveur :
 * on refuse tout autre domaine, pour ne jamais y envoyer le cookie de session.
 */
export function apiUrl(path: string, baseUrl = config.baseUrl): string {
  const url = new URL(path, `${baseUrl}/api/v1.0/`);
  if (url.origin !== baseUrl || !url.pathname.startsWith('/api/v1.0/')) {
    throw new UserError(`URL hors de l'API Docs refusée : ${url.origin}${url.pathname}`);
  }
  return url.href;
}

async function request<T>(path: string, sessionId = requireSession()): Promise<T> {
  const url = apiUrl(path);
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    if (Date.now() < blockedUntil) throw new RateLimitError(Math.ceil((blockedUntil - Date.now()) / 1000));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Cookie: `docs_sessionid=${sessionId}`, Accept: 'application/json' },
        // Pas de redirection suivie : le cookie ne doit pas partir ailleurs.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const cause = (e as Error).name === 'TimeoutError' ? 'délai dépassé' : (e as Error).message;
      throw new UserError(`Docs injoignable (${config.baseUrl}) : ${cause}`);
    }
    if (res.status === 401 || res.status === 403) throw new AuthError();
    if (res.status === 429) {
      const retryAfter = retryAfterSeconds(res);
      const wait = retryAfter + RETRY_MARGIN_S;
      // Une seule nouvelle tentative, après le délai demandé : insister aggraverait le blocage.
      if (attempt > 0 || retryAfter > MAX_RETRY_AFTER_S) {
        blockedUntil = Date.now() + wait * 1000;
        throw new RateLimitError(retryAfter);
      }
      if (process.stderr.isTTY) process.stderr.write(`\nDocs limite le débit : pause de ${wait} s…\n`);
      nextSlot = Math.max(nextSlot, Date.now() + wait * 1000);
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, path);
    return (await res.json()) as T;
  }
}

export const getMe = (sessionId?: string) =>
  request<{ email: string; full_name?: string }>('users/me/', sessionId);

export const getDoc = (id: string) => request<DocMeta>(`documents/${id}/`);

export async function* listChildren(id: string): AsyncGenerator<DocMeta> {
  let next: string | null = `documents/${id}/children/?page_size=200`;
  while (next) {
    const page: Page<DocMeta> = await request<Page<DocMeta>>(next);
    yield* page.results;
    next = page.next;
  }
}

export async function getFormattedMarkdown(id: string): Promise<string> {
  const r = await request<{ content: string | null }>(
    `documents/${id}/formatted-content/?content_format=markdown`,
  );
  return r.content ?? '';
}
