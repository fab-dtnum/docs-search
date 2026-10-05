import http from 'node:http';

/** Proxy défini dans l'environnement (HTTPS_PROXY, puis HTTP_PROXY, en majuscules ou minuscules). */
export function envProxy(): { url: URL; noProxy?: string } | undefined {
  const env = process.env;
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return undefined;
  try {
    return { url: new URL(raw), noProxy: env.NO_PROXY || env.no_proxy || undefined };
  } catch {
    console.error('Variable de proxy invalide (HTTPS_PROXY / HTTP_PROXY) : ignorée.');
    return undefined;
  }
}

/**
 * Le fetch de Node ignore HTTPS_PROXY par défaut : on l'active si un proxy est défini.
 * http.setGlobalProxyFromEnv existe depuis Node 24.14 / 25.4.
 */
export function applyEnvProxyToFetch(): void {
  if (!envProxy()) return;
  const setGlobal = (http as { setGlobalProxyFromEnv?: () => unknown }).setGlobalProxyFromEnv;
  if (typeof setGlobal === 'function') {
    setGlobal();
  } else if (process.env.NODE_USE_ENV_PROXY !== '1') {
    console.error(
      'Proxy détecté, mais cette version de Node ne sait pas l\'appliquer d\'elle-même.\n' +
        'Relancez avec NODE_USE_ENV_PROXY=1 (Node ≥ 22.21 ou 24.5), ou passez à Node 24.14+.',
    );
  }
}

/** Option `proxy` de Playwright : Chromium lancé par Playwright n'utilise pas HTTPS_PROXY. */
export function playwrightProxy() {
  const p = envProxy();
  if (!p) return undefined;
  return {
    server: `${p.url.protocol}//${p.url.host}`,
    bypass: p.noProxy,
    // Identifiants éventuels du proxy : transmis à Chromium, jamais affichés.
    username: p.url.username ? decodeURIComponent(p.url.username) : undefined,
    password: p.url.password ? decodeURIComponent(p.url.password) : undefined,
  };
}
