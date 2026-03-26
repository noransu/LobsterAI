/**
 * Auth IPC handlers.
 *
 * Handles lobsterai:// deep-link OAuth callbacks, token storage/refresh,
 * and all auth:* IPC channels exposed to the renderer.
 *
 * Token helpers are exported so main.ts can wire them into claudeSettings /
 * coworkOpenAICompatProxy via setAuthTokensGetter / setProxyTokenRefresher.
 */
import { ipcMain, shell, net } from 'electron';
import type { IpcContext } from './ipcContext';
import { getServerApiBaseUrl } from '../libs/endpoints';
import { t } from '../i18n';

// Token helpers

export const saveAuthTokens = (
  getStore: IpcContext['getStore'],
  accessToken: string,
  refreshToken: string,
): void => {
  getStore().set('auth_tokens', { accessToken, refreshToken });
};

export const getAuthTokens = (
  getStore: IpcContext['getStore'],
): { accessToken: string; refreshToken: string } | null => {
  return getStore().get<{ accessToken: string; refreshToken: string }>('auth_tokens') || null;
};

export const clearAuthTokens = (getStore: IpcContext['getStore']): void => {
  getStore().delete('auth_tokens');
};

/** Fetch with Bearer token, auto-refresh on 401 and retry once. */
export const fetchWithAuth = async (
  getStore: IpcContext['getStore'],
  url: string,
  options?: RequestInit,
): Promise<Response> => {
  const tokens = getAuthTokens(getStore);
  if (!tokens) throw new Error('No auth tokens');

  const doFetch = (accessToken: string) =>
    net.fetch(url, {
      ...options,
      headers: { ...(options?.headers as Record<string, string>), Authorization: `Bearer ${accessToken}` },
    });

  let resp = await doFetch(tokens.accessToken);

  if (resp.status === 401 && tokens.refreshToken) {
    const serverBaseUrl = getServerApiBaseUrl();
    const refreshResp = await net.fetch(`${serverBaseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (refreshResp.ok) {
      const refreshBody = await refreshResp.json() as {
        code: number;
        data: { accessToken: string; refreshToken?: string };
      };
      if (refreshBody.code === 0 && refreshBody.data) {
        saveAuthTokens(getStore, refreshBody.data.accessToken, refreshBody.data.refreshToken || tokens.refreshToken);
        resp = await doFetch(refreshBody.data.accessToken);
      }
    }
  }

  return resp;
};

const normalizeQuota = (raw: Record<string, unknown>) => {
  let creditsLimit = 0;
  let creditsUsed = 0;
  let planName = t('authPlanFree');
  let subscriptionStatus = 'free';

  if (typeof raw.freeCreditsTotal === 'number') {
    creditsLimit = raw.freeCreditsTotal as number;
    creditsUsed = (raw.freeCreditsUsed as number) || 0;
    planName = (raw.planName as string) || t('authPlanFree');
    subscriptionStatus = (raw.subscriptionStatus as string) || 'free';
  } else if (typeof raw.monthlyCreditsLimit === 'number') {
    creditsLimit = raw.monthlyCreditsLimit as number;
    creditsUsed = (raw.monthlyCreditsUsed as number) || 0;
    planName = (raw.planName as string) || t('authPlanStandard');
    subscriptionStatus = (raw.subscriptionStatus as string) || 'active';
  } else if (typeof raw.dailyCreditsLimit === 'number') {
    creditsLimit = raw.dailyCreditsLimit as number;
    creditsUsed = (raw.dailyCreditsUsed as number) || 0;
    planName = (raw.planName as string) || t('authPlanFree');
    subscriptionStatus = (raw.subscriptionStatus as string) || 'free';
  } else if (typeof raw.creditsLimit === 'number') {
    return raw;
  }

  return {
    planName,
    subscriptionStatus,
    creditsLimit,
    creditsUsed,
    creditsRemaining: Math.max(0, creditsLimit - creditsUsed),
  };
};

/**
 * Register all auth:* IPC handlers.
 *
 * @param ctx        Shared IPC context.
 * @param getPending Returns the buffered deep-link auth code (set by handleDeepLink in main.ts).
 * @param clearPending Clears the buffered code after it is consumed.
 */
export function registerAuthIpcHandlers(
  ctx: IpcContext,
  getPending: () => string | null,
  clearPending: () => void,
): void {
  const { getStore } = ctx;

  ipcMain.handle('auth:getPendingCallback', () => {
    const code = getPending();
    clearPending();
    return code;
  });

  ipcMain.handle('auth:login', async (_event, { loginUrl }: { loginUrl?: string } = {}) => {
    try {
      const baseUrl = loginUrl || `${getServerApiBaseUrl()}/login`;
      const finalUrl = `${baseUrl}?source=electron`;
      await shell.openExternal(finalUrl);
      return { success: true };
    } catch (error) {
      console.error('[Auth] login failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open login' };
    }
  });

  ipcMain.handle('auth:exchange', async (_event, { code }: { code: string }) => {
    try {
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await net.fetch(`${serverBaseUrl}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authCode: code }),
      });
      if (!resp.ok) {
        return { success: false, error: `Exchange failed: ${resp.status}` };
      }
      const body = await resp.json() as {
        code: number;
        message?: string;
        data: {
          accessToken: string;
          refreshToken: string;
          user: Record<string, unknown>;
          quota: Record<string, unknown>;
        };
      };
      if (body.code !== 0 || !body.data) {
        return { success: false, error: body.message || 'Exchange failed' };
      }
      saveAuthTokens(getStore, body.data.accessToken, body.data.refreshToken);
      return { success: true, user: body.data.user, quota: normalizeQuota(body.data.quota) };
    } catch (error) {
      console.error('[Auth] exchange failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Exchange failed' };
    }
  });

  ipcMain.handle('auth:getUser', async () => {
    try {
      const tokens = getAuthTokens(getStore);
      if (!tokens) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const profileResp = await fetchWithAuth(getStore, `${serverBaseUrl}/api/user/profile`);
      if (!profileResp.ok) return { success: false };
      const profileBody = await profileResp.json() as { code: number; data: Record<string, unknown> };
      if (profileBody.code !== 0 || !profileBody.data) return { success: false };
      const quotaResp = await fetchWithAuth(getStore, `${serverBaseUrl}/api/user/quota`);
      let quota = null;
      if (quotaResp.ok) {
        const quotaBody = await quotaResp.json() as { code: number; data: Record<string, unknown> };
        if (quotaBody.code === 0 && quotaBody.data) {
          quota = normalizeQuota(quotaBody.data);
        }
      }
      return { success: true, user: profileBody.data, quota };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:getQuota', async () => {
    try {
      const tokens = getAuthTokens(getStore);
      if (!tokens) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await fetchWithAuth(getStore, `${serverBaseUrl}/api/user/quota`);
      if (!resp.ok) return { success: false };
      const body = await resp.json() as { code: number; data: Record<string, unknown> };
      if (body.code !== 0 || !body.data) return { success: false };
      return { success: true, quota: normalizeQuota(body.data) };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:getProfileSummary', async () => {
    try {
      const tokens = getAuthTokens(getStore);
      if (!tokens) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await fetchWithAuth(getStore, `${serverBaseUrl}/api/user/profile-summary`);
      if (!resp.ok) return { success: false };
      const body = await resp.json() as { code: number; data: Record<string, unknown> };
      if (body.code !== 0 || !body.data) return { success: false };
      return { success: true, data: body.data };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    try {
      const tokens = getAuthTokens(getStore);
      if (tokens) {
        const serverBaseUrl = getServerApiBaseUrl();
        await net.fetch(`${serverBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }).catch(() => { /* best-effort */ });
      }
      clearAuthTokens(getStore);
      return { success: true };
    } catch {
      clearAuthTokens(getStore);
      return { success: true };
    }
  });

  ipcMain.handle('auth:refreshToken', async () => {
    try {
      const tokens = getAuthTokens(getStore);
      if (!tokens?.refreshToken) return { success: false };
      const serverBaseUrl = getServerApiBaseUrl();
      const resp = await net.fetch(`${serverBaseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      });
      if (!resp.ok) return { success: false };
      const body = await resp.json() as {
        code: number;
        data: { accessToken: string; refreshToken?: string };
      };
      if (body.code !== 0 || !body.data) return { success: false };
      saveAuthTokens(getStore, body.data.accessToken, body.data.refreshToken || tokens.refreshToken);
      return { success: true, accessToken: body.data.accessToken };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('auth:getAccessToken', () => {
    const tokens = getAuthTokens(getStore);
    return tokens?.accessToken || null;
  });

  ipcMain.handle('auth:getModels', async () => {
    try {
      const tokens = getAuthTokens(getStore);
      if (!tokens) {
        console.log('[Auth:getModels] No auth tokens available');
        return { success: false };
      }
      const serverBaseUrl = getServerApiBaseUrl();
      const url = `${serverBaseUrl}/api/models/available`;
      console.log('[Auth:getModels] Fetching:', url);
      const resp = await fetchWithAuth(getStore, url);
      console.log('[Auth:getModels] Response status:', resp.status);
      if (!resp.ok) {
        console.log('[Auth:getModels] Response not ok:', resp.status, resp.statusText);
        return { success: false };
      }
      const data = await resp.json() as {
        code: number;
        data: Array<{
          modelId: string;
          modelName: string;
          provider: string;
          apiFormat: string;
          supportsImage?: boolean;
        }>;
      };
      console.log('[Auth:getModels] Response data:', JSON.stringify(data).slice(0, 500));
      if (data.code !== 0) return { success: false };
      return { success: true, models: data.data };
    } catch (e) {
      console.error('[Auth:getModels] Error:', e);
      return { success: false };
    }
  });
}
