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

const CERT_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/;

/** Code utile d'une erreur de fetch (« fetch failed » seul ne dit rien). */
function networkErrorCode(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError') return 'délai dépassé';
  return err.cause?.code ?? err.cause?.message ?? err.message;
}

function networkErrorMessage(code: string): string {
  const lines = [`Docs injoignable (${config.baseUrl}) : ${code}`];
  if (CERT_ERRORS.test(code)) {
    lines.push(
      'Certificat HTTPS non reconnu : le proxy inspecte probablement le trafic HTTPS.',
      "Node utilise déjà les certificats du système (--use-system-ca) : demandez le certificat racine de",
      "votre organisation et installez-le sur le poste, ou pointez NODE_EXTRA_CA_CERTS vers ce fichier .pem.",
      'Ne désactivez pas la vérification des certificats : votre cookie de session serait exposé.',
    );
  } else if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/.test(code)) {
    lines.push('Derrière un proxy ? Définissez HTTPS_PROXY (et NO_PROXY), dans le shell ou dans .env.');
  }
  return lines.join('\n');
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
      const code = networkErrorCode(e);
      // Une erreur de certificat ne se corrige pas en réessayant.
      if (!CERT_ERRORS.test(code) && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new UserError(networkErrorMessage(code));
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

/** Réponse qui n'a pas la forme attendue : on s'arrête plutôt que d'écrire un instantané faux. */
function expect<T>(ok: boolean, value: T, what: string): T {
  if (!ok) throw new UserError(`Réponse inattendue de l'API Docs (${what}). Vérifiez DOCS_BASE_URL.`);
  return value;
}

const isDocMeta = (d: DocMeta) =>
  typeof d?.id === 'string' &&
  typeof d.updated_at === 'string' &&
  !Number.isNaN(Date.parse(d.updated_at)) &&
  typeof d.numchild === 'number';

export async function getMe(sessionId?: string) {
  const me = await request<{ email: string; full_name?: string }>('users/me/', sessionId);
  return expect(typeof me?.email === 'string', me, 'utilisateur');
}

export async function getDoc(id: string): Promise<DocMeta> {
  const doc = await request<DocMeta>(`documents/${id}/`);
  return expect(isDocMeta(doc), doc, `document ${id}`);
}

export async function* listChildren(id: string): AsyncGenerator<DocMeta> {
  let next: string | null = `documents/${id}/children/?page_size=200`;
  while (next) {
    const page: Page<DocMeta> = await request<Page<DocMeta>>(next);
    expect(Array.isArray(page?.results) && page.results.every(isDocMeta), page, `enfants de ${id}`);
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
