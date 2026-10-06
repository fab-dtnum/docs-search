// Fausse API Docs pour les tests : arborescence de 6 documents, contenu Y.js
// au format BlockNote, pagination des enfants (1 par page) et cookie exigé.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';

export const SESSION = 'goodsession123';
export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Run = [string, Record<string, unknown>?];

function el(name: string, attrs: Record<string, unknown> = {}, children: (Y.XmlElement | Y.XmlText)[] = []) {
  const e = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  e.insert(0, children);
  return e;
}
function txt(...runs: Run[]) {
  const t = new Y.XmlText();
  let i = 0;
  for (const [s, a] of runs) {
    t.insert(i, s, a ?? {});
    i += s.length;
  }
  return t;
}
const block = (content: Y.XmlElement, nested?: Y.XmlElement) =>
  el('blockContainer', {}, nested ? [content, nested] : [content]);
const para = (...runs: Run[]) => block(el('paragraph', {}, [txt(...runs)]));

export function encode(blocks: () => Y.XmlElement[]): string {
  const doc = new Y.Doc();
  doc.getXmlFragment('document-store').insert(0, [el('blockGroup', {}, blocks())]);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
}

/** Pièces jointes servies sous `/media/<doc>/attachments/` (`missing` répond 404). */
export const MEDIA = {
  png: 'a0000000-0000-4000-8000-000000000001.png',
  pdf: 'a0000000-0000-4000-8000-000000000002.pdf',
  missing: 'a0000000-0000-4000-8000-000000000003.png',
};
export const mediaBytes = (name: string) => Buffer.from(`contenu de ${name}`);

interface FakeDoc {
  title: string;
  updated_at: string;
  children: string[];
  content: () => Y.XmlElement[];
}

export const docs: Record<string, FakeDoc> = {
  [id(1)]: {
    title: 'Projet X',
    updated_at: '2026-09-01T10:00:00Z',
    children: [id(2), id(3), id(4)],
    content: () => [
      block(el('heading', { level: 1 }, [txt(['Présentation'])])),
      block(
        el('paragraph', {}, [
          txt(['Voir le '], ['budget', { bold: true }], [' et ']),
          el('interlinkingLinkInline', { docId: id(3), title: 'Budget' }),
          txt([' ou '], ['le site', { link: { href: 'https://example.org' } }]),
        ]),
      ),
      block(el('bulletListItem', {}, [txt(['point A'])]), el('blockGroup', {}, [block(el('bulletListItem', {}, [txt(['sous-point'])]))])),
      block(el('numberedListItem', {}, [txt(['un'])])),
      block(el('numberedListItem', {}, [txt(['deux'])])),
      block(el('checkListItem', { checked: true }, [txt(['fait'])])),
      block(el('codeBlock', { language: 'js' }, [txt(['const a = "<div>";'])])),
      block(
        el('table', {}, [
          el('tableRow', {}, [el('tableHeader', {}, [el('tableParagraph', {}, [txt(['Col1'])])]), el('tableHeader', {}, [el('tableParagraph', {}, [txt(['Col2'])])])]),
          el('tableRow', {}, [el('tableCell', {}, [el('tableParagraph', {}, [txt(['a'])])]), el('tableCell', {}, [el('tableParagraph', {}, [txt(['b|c'])])])]),
        ]),
      ),
    ],
  },
  [id(2)]: { title: 'Réunions', updated_at: '2026-09-15T08:30:00Z', children: [id(5), id(6)], content: () => [para(['Liste des réunions'])] },
  [id(3)]: {
    title: 'Budget',
    updated_at: '2026-09-02T10:00:00Z',
    children: [],
    content: () => [
      block(el('paragraph', {}, [txt(['Montant total 42 k€, voir ']), el('interlinkingLinkInline', { docId: id(5), title: 'CR' })])),
      block(el('image', { url: `/media/${id(3)}/attachments/${MEDIA.png}`, name: 'schéma.png' })),
      block(el('file', { url: `/media/${id(3)}/attachments/${MEDIA.pdf}`, name: 'Rapport final.pdf' })),
      block(el('image', { url: `/media/${id(3)}/attachments/${MEDIA.missing}`, name: 'manquante.png' })),
    ],
  },
  [id(4)]: { title: '../budget', updated_at: '2026-09-03T10:00:00Z', children: [], content: () => [para(['doublon de titre'])] },
  [id(5)]: { title: 'CR 2026/09/12 : comité', updated_at: '2026-10-04T16:45:00Z', children: [], content: () => [para(['Décision du COPIL : valider le mot-secret-xyz'])] },
  [id(6)]: { title: '', updated_at: '2026-09-20T10:00:00Z', children: [], content: () => [] },
};

export interface FakeServer {
  url: string;
  requests: string[];
  /** Lien `next` renvoyé par la pagination (pour tester un domaine étranger). */
  nextOrigin?: string;
  /**
   * Comme l'instance en production : pas de champ `content`, le Markdown est
   * produit par le serveur (`formatted-content`).
   */
  formattedContent?: boolean;
  /** Le document racine répond `{}` (serveur qui n'est pas Docs, proxy qui réécrit…). */
  brokenResponses?: boolean;
  /** Nombre de réponses 429 à renvoyer avant de répondre normalement (`Infinity` : toujours). */
  throttle?: number;
  /** Nombre de requêtes servies avant de répondre 429 à toutes les suivantes. */
  throttleAfter?: number;
  close(): Promise<void>;
}

export async function startFakeDocs(): Promise<FakeServer> {
  const state: FakeServer = { url: '', requests: [], close: async () => {} };
  const meta = (i: string) => ({ id: i, title: docs[i].title, updated_at: docs[i].updated_at, numchild: docs[i].children.length, depth: 1, path: '' });

  const server = http.createServer((req, res) => {
    state.requests.push(req.url ?? '');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.cookie !== `docs_sessionid=${SESSION}`) return send(401, { detail: 'auth' });
    if (state.throttleAfter !== undefined && state.throttleAfter-- <= 0) state.throttle = 1;
    if (state.throttle) {
      state.throttle--;
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end(JSON.stringify({ detail: 'Request was throttled. Expected available in 1 second.' }));
    }
    const u = new URL(req.url ?? '/', state.url);
    if (u.pathname === '/api/v1.0/users/me/') return send(200, { email: 'test@example.org' });

    const media = u.pathname.match(/^\/media\/[^/]+\/attachments\/([^/]+)$/);
    if (media && media[1] !== MEDIA.missing) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(mediaBytes(media[1]));
    }

    let m = u.pathname.match(/^\/api\/v1.0\/documents\/([^/]+)\/children\/$/);
    if (m) {
      const page = Number(u.searchParams.get('page') ?? 1);
      const all = docs[m[1]].children;
      const origin = state.nextOrigin ?? state.url;
      return send(200, {
        next: page < all.length ? `${origin}/api/v1.0/documents/${m[1]}/children/?page=${page + 1}` : null,
        results: all.slice(page - 1, page).map(meta),
      });
    }
    m = u.pathname.match(/^\/api\/v1.0\/documents\/([^/]+)\/formatted-content\/$/);
    if (m && docs[m[1]] && u.searchParams.get('content_format') === 'markdown') {
      const image = m[1] === id(3) ? `\n![schéma.png](${state.url}/media/${id(3)}/attachments/${MEDIA.png})\n` : '';
      return send(200, { id: m[1], title: docs[m[1]].title, content: `Markdown serveur de ${docs[m[1]].title}, voir [lien](${state.url}/docs/${id(5)}/)\n${image}` });
    }
    m = u.pathname.match(/^\/api\/v1.0\/documents\/([^/]+)\/$/);
    if (m && state.brokenResponses) return send(200, {});
    if (m && docs[m[1]]) {
      if (state.formattedContent) return send(200, meta(m[1]));
      return send(200, { ...meta(m[1]), content: encode(docs[m[1]].content) });
    }
    send(404, {});
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
