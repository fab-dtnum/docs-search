import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { playwrightProxy } from '../proxy.ts';

const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const setEnv = (vars: Record<string, string>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
};

test('sans variable de proxy : aucun proxy pour Chromium', () => {
  setEnv({});
  assert.equal(playwrightProxy(), undefined);
});

test('HTTPS_PROXY avec identifiants et NO_PROXY : transmis à Chromium', () => {
  setEnv({ https_proxy: 'http://p%40ole:s%3Acret@proxy.interne:3128', NO_PROXY: 'localhost,.interne' });
  assert.deepEqual(playwrightProxy(), {
    server: 'http://proxy.interne:3128',
    bypass: 'localhost,.interne',
    username: 'p@ole',
    password: 's:cret',
  });
});

test('HTTPS_PROXY prioritaire sur HTTP_PROXY ; valeur invalide ignorée', (t) => {
  setEnv({ HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2' });
  assert.equal(playwrightProxy()?.server, 'http://a:1');
  t.mock.method(console, 'error', () => {});
  setEnv({ HTTPS_PROXY: 'pas une url' });
  assert.equal(playwrightProxy(), undefined);
});
