import { app } from 'electron';
import https from 'https';

/**
 * Server API base URL — hardcoded per environment.
 * Used for auth exchange/refresh, models, proxy, etc.
 */
export const getServerApiBaseUrl = (): string => {
  return app.isPackaged
    ? 'https://lobsterai-server.youdao.com'
    : 'https://lobsterai-server.inner.youdao.com';
};

let cachedLoginUrl: string | null = null;

/**
 * Login URL — fetched from overmind at startup, cached.
 * Falls back to server API base + /login if overmind fetch hasn't completed.
 */
export const getLoginUrl = (): string => {
  return cachedLoginUrl || `${getServerApiBaseUrl()}/login`;
};

/**
 * Fetch login URL from overmind and cache it.
 * Call during app startup (non-blocking).
 */
export async function fetchLoginUrlFromOvermind(): Promise<void> {
  const overmindPath = app.isPackaged
    ? 'luna/hardware/lobsterai/prod/login-url'
    : 'luna/hardware/lobsterai/test/login-url';
  const url = `https://api-overmind.youdao.com/openapi/get/${overmindPath}`;
  try {
    const data = await new Promise<string>((resolve, reject) => {
      const req = https.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const json = JSON.parse(data);
    const value = json?.data?.value;
    if (typeof value === 'string' && value.trim()) {
      cachedLoginUrl = value.trim();
      console.log('[Auth] Login URL from overmind:', cachedLoginUrl);
    } else {
      console.log('[Auth] Overmind returned no login URL, using fallback:', getLoginUrl());
    }
  } catch (e) {
    console.error('[Auth] Failed to fetch login URL from overmind:', e);
    console.log('[Auth] Using fallback login URL:', getLoginUrl());
  }
}
