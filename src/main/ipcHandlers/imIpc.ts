/**
 * IM Gateway IPC handlers (config, start/stop, test, pairing, Feishu install).
 */
import { ipcMain } from 'electron';
import type { IpcContext } from './ipcContext';
import type { IMGatewayConfig, IMPlatform } from '../im';
import {
  listPairingRequests,
  approvePairingCode,
  rejectPairingRequest,
  readAllowFromStore,
} from '../im/imPairingStore';

export function registerImIpcHandlers(ctx: IpcContext): void {
  // ==================== IM Config ====================

  ipcMain.handle('im:config:get', async () => {
    try {
      const config = ctx.getIMGatewayManager().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM config',
      };
    }
  });

  // Debounce + serialization for im:config:set → syncOpenClawConfig.
  let imConfigSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let imConfigSyncRunning = false;
  let imConfigSyncPending = false;
  const IM_CONFIG_SYNC_DEBOUNCE_MS = 600;

  const doImConfigSync = async () => {
    imConfigSyncRunning = true;
    try {
      await ctx.syncOpenClawConfig({
        reason: 'im-config-change',
        restartGatewayIfRunning: true,
      });
      const adapter = ctx.getOpenClawRuntimeAdapter();
      if (adapter) {
        try {
          await adapter.connectGatewayIfNeeded();
        } catch (connectError) {
          console.error('[IM] Failed to connect gateway client after config sync:', connectError);
        }
      }
    } catch (error) {
      console.error('[IM] Debounced config sync failed:', error);
    } finally {
      imConfigSyncRunning = false;
      if (imConfigSyncPending) {
        imConfigSyncPending = false;
        scheduleImConfigSync();
      }
    }
  };

  const scheduleImConfigSync = () => {
    if (imConfigSyncRunning) {
      imConfigSyncPending = true;
      return;
    }
    if (imConfigSyncTimer) clearTimeout(imConfigSyncTimer);
    imConfigSyncTimer = setTimeout(() => {
      imConfigSyncTimer = null;
      void doImConfigSync();
    }, IM_CONFIG_SYNC_DEBOUNCE_MS);
  };

  ipcMain.handle('im:config:set', async (_event, config: Partial<IMGatewayConfig>, options?: { syncGateway?: boolean }) => {
    try {
      ctx.getIMGatewayManager().setConfig(config, { syncGateway: options?.syncGateway });

      const hasOpenClawChange = config.telegram || config.discord || config.dingtalk
        || config.feishu || config.qq || config.wecom || config.popo || config.weixin;
      if (options?.syncGateway && hasOpenClawChange && ctx.getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set IM config',
      };
    }
  });

  ipcMain.handle('im:config:sync', async () => {
    try {
      if (ctx.getOpenClawEngineManager().getStatus().phase === 'running') {
        scheduleImConfigSync();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to sync IM config',
      };
    }
  });

  // ==================== IM Gateway start/stop/test ====================

  ipcMain.handle('im:gateway:start', async (_event, platform: IMPlatform) => {
    try {
      const manager = ctx.getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: true } });
      await manager.startGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:stop', async (_event, platform: IMPlatform) => {
    try {
      const manager = ctx.getIMGatewayManager();
      manager.setConfig({ [platform]: { enabled: false } });
      await manager.stopGateway(platform);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop gateway',
      };
    }
  });

  ipcMain.handle('im:gateway:test', async (
    _event,
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ) => {
    try {
      const result = await ctx.getIMGatewayManager().testGateway(platform, configOverride);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test gateway connectivity',
      };
    }
  });

  ipcMain.handle('im:status:get', async () => {
    try {
      const status = ctx.getIMGatewayManager().getStatus();
      return { success: true, status };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get IM status',
      };
    }
  });

  // ==================== Pairing ====================

  ipcMain.handle('im:pairing:list', async (_event, platform: string) => {
    try {
      const stateDir = ctx.getOpenClawEngineManager().getStateDir();
      const requests = listPairingRequests(platform, stateDir);
      const allowFrom = readAllowFromStore(platform, stateDir);
      return { success: true, requests, allowFrom };
    } catch (error) {
      return {
        success: false,
        requests: [],
        allowFrom: [],
        error: error instanceof Error ? error.message : 'Failed to list pairing requests',
      };
    }
  });

  ipcMain.handle('im:pairing:approve', async (_event, platform: string, code: string) => {
    try {
      const stateDir = ctx.getOpenClawEngineManager().getStateDir();
      const approved = approvePairingCode(platform, code, stateDir);
      if (!approved) {
        return { success: false, error: 'Pairing code not found or expired' };
      }
      await ctx.syncOpenClawConfig({
        reason: `im-pairing-approval:${platform}`,
        restartGatewayIfRunning: true,
      });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to approve pairing code',
      };
    }
  });

  ipcMain.handle('im:pairing:reject', async (_event, platform: string, code: string) => {
    try {
      const stateDir = ctx.getOpenClawEngineManager().getStateDir();
      const rejected = rejectPairingRequest(platform, code, stateDir);
      if (!rejected) {
        return { success: false, error: 'Pairing code not found or expired' };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reject pairing request',
      };
    }
  });

  // ==================== Feishu Install ====================

  ipcMain.handle('feishu:install:qrcode', async (_event, { isLark }: { isLark: boolean }) => {
    try {
      return await ctx.getIMGatewayManager().startFeishuInstallQrcode(isLark);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '获取二维码失败');
    }
  });

  ipcMain.handle('feishu:install:poll', async (_event, { deviceCode }: { deviceCode: string }) => {
    try {
      return await ctx.getIMGatewayManager().pollFeishuInstall(deviceCode);
    } catch (error) {
      return { done: false, error: error instanceof Error ? error.message : '轮询失败' };
    }
  });

  ipcMain.handle('feishu:install:verify', async (_event, { appId, appSecret }: { appId: string; appSecret: string }) => {
    try {
      return await ctx.getIMGatewayManager().verifyFeishuCredentials(appId, appSecret);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '验证失败' };
    }
  });

  // ==================== Weixin QR Login ====================

  ipcMain.handle('im:weixin:qr-login-start', async () => {
    try {
      const result = await ctx.getIMGatewayManager().weixinQrLoginStart();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Failed to start Weixin QR login' };
    }
  });

  ipcMain.handle('im:weixin:qr-login-wait', async (_event, accountId?: string) => {
    try {
      const result = await ctx.getIMGatewayManager().weixinQrLoginWait(accountId);
      if (result.connected) {
        console.log('[IMGatewayManager] Weixin login succeeded, restarting OpenClaw gateway');
        await ctx.getOpenClawEngineManager().restartGateway();
      }
      return { success: true, ...result };
    } catch (error) {
      return { success: false, connected: false, message: error instanceof Error ? error.message : 'Weixin QR login failed' };
    }
  });
}
