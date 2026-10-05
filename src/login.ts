import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { getMe } from './api.ts';
import { config, isValidSessionId, setEnvVar, UserError } from './config.ts';
import { envProxy, playwrightProxy } from './proxy.ts';

const PROFILE_DIR = resolve('.auth/profile');
const TIMEOUT_MS = 5 * 60_000;

/**
 * Ouvre une fenêtre Chromium sur Docs : l'utilisateur se connecte lui-même via
 * ProConnect, on récupère ensuite le cookie de session pour l'écrire dans .env.
 */
export async function login(): Promise<void> {
  // Le profil contient la session ProConnect : lisible par l'utilisateur seul.
  mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(resolve('.auth'), 0o700);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
    proxy: playwrightProxy(),
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await page.goto(`${config.baseUrl}/`);
    } catch (e) {
      throw new UserError(navigationHelp((e as Error).message));
    }
    console.log('Connectez-vous dans la fenêtre qui vient de s\'ouvrir (5 min max)…');

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const cookie = (await context.cookies(config.baseUrl)).find(
        (c) => c.name === 'docs_sessionid',
      );
      if (cookie && isValidSessionId(cookie.value)) {
        const me = await getMe(cookie.value).catch(() => null);
        if (me) {
          setEnvVar('DOCS_SESSIONID', cookie.value);
          const expires =
            cookie.expires > 0
              ? ` (expire le ${new Date(cookie.expires * 1000).toLocaleString('fr-FR')})`
              : '';
          console.log(`Connecté en tant que ${me.email}. Session enregistrée dans .env${expires}.`);
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new UserError('Délai de connexion dépassé (5 min).');
  } finally {
    await context.close();
  }
}

/** Message d'aide quand Chromium n'arrive pas à ouvrir Docs. */
function navigationHelp(message: string): string {
  const error = message.match(/net::[A-Z_]+/)?.[0] ?? message.split('\n')[0];
  const proxy = envProxy();
  const lines = [`Impossible d'ouvrir ${config.baseUrl} dans Chromium (${error}).`];
  if (/NAME_NOT_RESOLVED|PROXY|TUNNEL/.test(error)) {
    lines.push(
      proxy
        ? `Proxy utilisé : ${proxy.url.protocol}//${proxy.url.host}. Vérifiez qu'il est joignable et qu'il autorise ce site.`
        : 'Aucun proxy défini : si votre réseau en impose un, exportez HTTPS_PROXY (et NO_PROXY) puis relancez.',
      `Diagnostic : getent hosts ${new URL(config.baseUrl).hostname} ; curl -sI ${config.baseUrl}/`,
    );
  }
  return lines.join('\n');
}
