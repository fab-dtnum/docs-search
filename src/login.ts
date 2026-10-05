import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { getMe } from './api.ts';
import { config, isValidSessionId, setEnvVar, UserError } from './config.ts';

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
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${config.baseUrl}/`);
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
