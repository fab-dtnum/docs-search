import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrl, mediaUrl } from '../api.ts';
import { isValidSessionId, parseBaseUrl, setEnvVar } from '../config.ts';
import { formatDuration, isImmutableMedia, safeJoin, sanitize } from '../sync.ts';

const BASE = 'https://docs.numerique.gouv.fr';

test('DOCS_BASE_URL : https obligatoire, http accepté seulement en local', () => {
  assert.equal(parseBaseUrl('https://docs.numerique.gouv.fr/'), BASE);
  assert.equal(parseBaseUrl('http://127.0.0.1:8000'), 'http://127.0.0.1:8000');
  assert.throws(() => parseBaseUrl('http://docs.numerique.gouv.fr'), /https/);
  assert.throws(() => parseBaseUrl('file:///etc/passwd'), /https/);
  assert.throws(() => parseBaseUrl('pas une url'), /invalide/);
});

test("le cookie n'est jamais envoyé hors de l'API Docs", () => {
  assert.equal(apiUrl('users/me/', BASE), `${BASE}/api/v1.0/users/me/`);
  assert.equal(apiUrl(`${BASE}/api/v1.0/documents/x/children/?page=2`, BASE), `${BASE}/api/v1.0/documents/x/children/?page=2`);
  assert.throws(() => apiUrl('https://evil.example/api/v1.0/documents/', BASE), /refusée/);
  assert.throws(() => apiUrl('//evil.example/api/v1.0/', BASE), /refusée/);
  assert.throws(() => apiUrl('../../admin/', BASE), /refusée/);
  assert.throws(() => apiUrl('http://docs.numerique.gouv.fr/api/v1.0/x/', BASE), /refusée/);
  assert.equal(mediaUrl('/media/d/attachments/a.png', BASE), `${BASE}/media/d/attachments/a.png`);
  assert.throws(() => mediaUrl('https://evil.example/media/a.png', BASE), /refusée/);
  assert.throws(() => mediaUrl('//evil.example/media/a.png', BASE), /refusée/);
  assert.throws(() => mediaUrl('/media/../api/v1.0/users/me/', BASE), /refusée/);
});

test('identifiant de session : alphanumérique uniquement', () => {
  assert.ok(isValidSessionId('abc123XYZ'));
  assert.ok(!isValidSessionId(''));
  assert.ok(!isValidSessionId('abc\r\nX-Injected: 1'));
  assert.ok(!isValidSessionId('abc; other=1'));
  assert.throws(() => setEnvVar('DOCS_SESSIONID', 'a\nDOCS_BASE_URL=http://evil'), /invalide/);
});

test("un titre ne peut pas faire sortir un fichier de l'instantané", () => {
  assert.equal(sanitize('../../etc/passwd'), 'etc passwd');
  assert.equal(sanitize(' .bashrc. '), 'bashrc');
  assert.equal(sanitize('✅ \u200bTâches\u200e'), '✅ Tâches');
  assert.equal(sanitize('..'), 'Sans titre');
  assert.equal(sanitize('a/b\\c:d*e?"f<g>h|i#j^k[l]m'), 'a b c d e f g h i j k l m');
  assert.equal(sanitize('x'.repeat(200)).length, 80);
  assert.throws(() => safeJoin('/tmp/snap', '../dehors.md'), /refusé/);
  assert.throws(() => safeJoin('/tmp/snap', '/etc/passwd'), /refusé/);
  assert.equal(safeJoin('/tmp/snap', 'a/b.md'), '/tmp/snap/a/b.md');
});

test('pièces jointes recopiées seulement sous un chemin immuable de Docs', () => {
  const doc = 'e9ebe2ad-e54b-498f-971a-05845f1a662c';
  assert.ok(isImmutableMedia(`/media/${doc}/attachments/7544ee92-b4e0-400b-9716-393e61a2d409.png`));
  assert.ok(!isImmutableMedia(`/media/${doc}/attachments/image.png`));
  assert.ok(!isImmutableMedia(`/media/${doc}/attachments/7544ee92-b4e0-400b-9716-393e61a2d409.png?v=2`));
  assert.ok(!isImmutableMedia('/media/avatar.png'));
});

test('durée de synchronisation lisible', () => {
  assert.equal(formatDuration(42_400), '42 s');
  assert.equal(formatDuration(185_000), '3 min 05 s');
});
