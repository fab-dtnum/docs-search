import { config, requireSession, UserError } from './config.ts';

export class AuthError extends UserError {
  constructor() {
    super('Session expirée ou invalide. Lancez `pnpm docs:login` pour vous reconnecter.');
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
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
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
