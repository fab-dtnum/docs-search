import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, firefox } from 'playwright';
import { getMe } from './api.ts';
import { config, isValidSessionId, setEnvVar, UserError } from './config.ts';
import { envProxy, playwrightProxy } from './proxy.ts';

const TIMEOUT_MS = 5 * 60_000;

export const BROWSERS = { chromium, firefox } as const;
export type BrowserName = keyof typeof BROWSERS;
const LABEL: Record<BrowserName, string> = { chromium: 'Chromium', firefox: 'Firefox' };

/** Navigateur choisi : option --browser, sinon DOCS_BROWSER (.env), sinon Chromium. */
export function parseBrowser(value = process.env.DOCS_BROWSER || 'chromium'): BrowserName {
  const name = value.toLowerCase();
  if (!(name in BROWSERS)) {
    throw new UserError(`Navigateur inconnu : ${value} (choix : ${Object.keys(BROWSERS).join(', ')})`);
  }
  return name as BrowserName;
}

/**
 * Ouvre une fenêtre du navigateur sur Docs : l'utilisateur se connecte lui-même via
 * ProConnect, on récupère ensuite le cookie de session pour l'écrire dans .env.
 */
export async function login(browser: BrowserName = parseBrowser()): Promise<void> {
  // Un profil par navigateur ; il contient la session ProConnect : lisible par l'utilisateur seul.
  const profileDir = resolve('.auth', browser);
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  chmodSync(resolve('.auth'), 0o700);
  let context;
  try {
    context = await BROWSERS[browser].launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    proxy: playwrightProxy(),
  });
  } catch (e) {
    if (/Executable doesn't exist/.test((e as Error).message)) {
      throw new UserError(`${LABEL[browser]} n'est pas installé pour Playwright : pnpm exec playwright install ${browser}`);
    }
    throw e;
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await page.goto(`${config.baseUrl}/`);
    } catch (e) {
      throw new UserError(navigationHelp(LABEL[browser], (e as Error).message));
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

/** Message d'aide quand le navigateur n'arrive pas à ouvrir Docs. */
function navigationHelp(label: string, message: string): string {
  // Codes d'erreur réseau : net::ERR_… (Chromium), NS_ERROR_… (Firefox).
  const error = message.match(/net::[A-Z_]+|NS_ERROR_[A-Z_]+/)?.[0] ?? message.split('\n')[0];
  const proxy = envProxy();
  const lines = [`Impossible d'ouvrir ${config.baseUrl} dans ${label} (${error}).`];
  // Derrière un proxy, Firefox signale un hôte injoignable par NS_ERROR_NET_RESET.
  if (/NAME_NOT_RESOLVED|UNKNOWN_HOST|PROXY|TUNNEL|NET_RESET|CONNECTION_REFUSED/.test(error)) {
    lines.push(
      proxy
        ? `Proxy utilisé : ${proxy.url.protocol}//${proxy.url.host}. Vérifiez qu'il est joignable et qu'il autorise ce site.`
        : 'Aucun proxy défini : si votre réseau en impose un, exportez HTTPS_PROXY (et NO_PROXY) puis relancez.',
      `Diagnostic : getent hosts ${new URL(config.baseUrl).hostname} ; curl -sI ${config.baseUrl}/`,
    );
  }
  return lines.join('\n');
}
