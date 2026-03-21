/**
 * Cowork session/config/memory/permission IPC handlers.
 */
import { ipcMain, BrowserWindow } from 'electron';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { IpcContext } from './ipcContext';
import type { CoworkAgentEngine } from '../libs/agentEngine';
import type { CoworkStore } from '../coworkStore';
import {
  getEngineNotReadyResponse,
  resolveTaskWorkingDirectory,
  savePngWithDialog,
  normalizeCaptureRect,
  MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
  MAX_MEMORY_USER_MEMORIES_MAX_ITEMS,
  ENGINE_NOT_READY_CODE,
} from './ipcUtils';
import {
  resolveMemoryFilePath,
  readMemoryEntries,
  addMemoryEntry,
  updateMemoryEntry,
  deleteMemoryEntry,
  searchMemoryEntries,
  migrateSqliteToMemoryMd,
  syncMemoryFileOnWorkspaceChange,
  readBootstrapFile,
  writeBootstrapFile,
  ensureDefaultIdentity,
} from '../libs/openclawMemoryFile';

let memoryMigrationDone = false;

export function registerCoworkIpcHandlers(ctx: IpcContext): void {

  // ==================== Session Start ====================

  ipcMain.handle('cowork:session:start', async (_event, options: {
    prompt: string;
    cwd?: string;
    systemPrompt?: string;
    title?: string;
    activeSkillIds?: string[];
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  }) => {
    try {
      const activeEngine = ctx.resolveCoworkAgentEngine();
      if (activeEngine === 'openclaw') {
        const engineStatus = await ctx.ensureOpenClawRunningForCowork();
        if (engineStatus.phase !== 'running') {
          return getEngineNotReadyResponse(engineStatus);
        }
      }

      const coworkStoreInstance = ctx.getCoworkStore();
      const config = coworkStoreInstance.getConfig();
      const systemPrompt = ctx.mergeCoworkSystemPrompt(
        activeEngine,
        options.systemPrompt ?? config.systemPrompt,
      );
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();

      if (!selectedWorkspaceRoot) {
        return {
          success: false,
          error: 'Please select a task folder before submitting.',
        };
      }

      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const title = options.title?.trim() || fallbackTitle;
      const taskWorkingDirectory = resolveTaskWorkingDirectory(selectedWorkspaceRoot);

      const session = coworkStoreInstance.createSession(
        title,
        taskWorkingDirectory,
        systemPrompt,
        config.executionMode || 'local',
        options.activeSkillIds || []
      );

      coworkStoreInstance.updateSession(session.id, { status: 'running' });

      const messageMetadata: Record<string, unknown> = {};
      if (options.activeSkillIds?.length) {
        messageMetadata.skillIds = options.activeSkillIds;
      }
      if (options.imageAttachments?.length) {
        messageMetadata.imageAttachments = options.imageAttachments;
      }
      coworkStoreInstance.addMessage(session.id, {
        type: 'user',
        content: options.prompt,
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
      });

      coworkStoreInstance.updateSession(session.id, { status: 'running' });

      const runtime = ctx.getCoworkEngineRouter();
      runtime.startSession(session.id, options.prompt, {
        skipInitialUserMessage: true,
        systemPrompt,
        skillIds: options.activeSkillIds,
        workspaceRoot: selectedWorkspaceRoot,
        confirmationMode: 'modal',
        imageAttachments: options.imageAttachments,
      }).catch(error => {
        console.error('Cowork session error:', error);
        const existing = coworkStoreInstance.getSession(session.id);
        if (existing?.status === 'error') return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const windows = BrowserWindow.getAllWindows();
        windows.forEach((win) => {
          if (win.isDestroyed()) return;
          win.webContents.send('cowork:stream:error', { sessionId: session.id, error: errorMessage });
        });
      });

      const sessionWithMessages = coworkStoreInstance.getSession(session.id) || {
        ...session,
        status: 'running' as const,
      };
      return { success: true, session: sessionWithMessages };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    }
  });

  // ==================== Session Continue ====================

  ipcMain.handle('cowork:session:continue', async (_event, options: {
    sessionId: string;
    prompt: string;
    systemPrompt?: string;
    activeSkillIds?: string[];
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  }) => {
    try {
      const activeEngine = ctx.resolveCoworkAgentEngine();
      if (activeEngine === 'openclaw') {
        const engineStatus = await ctx.ensureOpenClawRunningForCowork();
        if (engineStatus.phase !== 'running') {
          return getEngineNotReadyResponse(engineStatus);
        }
      }

      const runtime = ctx.getCoworkEngineRouter();
      const existingSession = ctx.getCoworkStore().getSession(options.sessionId);
      runtime.continueSession(options.sessionId, options.prompt, {
        systemPrompt: ctx.mergeCoworkSystemPrompt(
          activeEngine,
          options.systemPrompt ?? existingSession?.systemPrompt,
        ),
        skillIds: options.activeSkillIds,
        imageAttachments: options.imageAttachments,
      }).catch(error => {
        console.error('Cowork continue error:', error);
        const existing = ctx.getCoworkStore().getSession(options.sessionId);
        if (existing?.status === 'error') return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const windows = BrowserWindow.getAllWindows();
        windows.forEach((win) => {
          if (win.isDestroyed()) return;
          win.webContents.send('cowork:stream:error', { sessionId: options.sessionId, error: errorMessage });
        });
      });

      const session = ctx.getCoworkStore().getSession(options.sessionId);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue session',
      };
    }
  });

  // ==================== Session Stop / Delete / Pin / Rename / Get / List ====================

  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    try {
      ctx.getCoworkEngineRouter().stopSession(sessionId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop session' };
    }
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      ctx.getCoworkStore().deleteSession(sessionId);
      try {
        ctx.getIMGatewayManager()?.getIMStore()?.deleteSessionMappingByCoworkSessionId(sessionId);
      } catch { /* IM store may not be initialised yet */ }
      try {
        ctx.getCoworkEngineRouter().onSessionDeleted(sessionId);
      } catch { /* Router may not be initialised yet */ }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete session' };
    }
  });

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    try {
      ctx.getCoworkStore().deleteSessions(sessionIds);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to batch delete sessions' };
    }
  });

  ipcMain.handle('cowork:session:pin', async (_event, options: { sessionId: string; pinned: boolean }) => {
    try {
      ctx.getCoworkStore().setSessionPinned(options.sessionId, options.pinned);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update session pin' };
    }
  });

  ipcMain.handle('cowork:session:rename', async (_event, options: { sessionId: string; title: string }) => {
    try {
      const title = options.title.trim();
      if (!title) return { success: false, error: 'Title is required' };
      ctx.getCoworkStore().updateSession(options.sessionId, { title });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to rename session' };
    }
  });

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      const session = ctx.getCoworkStore().getSession(sessionId);
      return { success: true, session };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get session' };
    }
  });

  ipcMain.handle('cowork:session:list', async () => {
    try {
      const sessions = ctx.getCoworkStore().listSessions();
      return { success: true, sessions };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list sessions' };
    }
  });

  // ==================== Session Export ====================

  ipcMain.handle('cowork:session:exportResultImage', async (event, options: {
    rect: { x: number; y: number; width: number; height: number };
    defaultFileName?: string;
  }) => {
    try {
      const captureRect = normalizeCaptureRect(options?.rect);
      if (!captureRect) return { success: false, error: 'Capture rect is required' };
      const image = await event.sender.capturePage(captureRect);
      return savePngWithDialog(event.sender, image.toPNG(), options?.defaultFileName);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to export session image' };
    }
  });

  ipcMain.handle('cowork:session:captureImageChunk', async (event, options: {
    rect: { x: number; y: number; width: number; height: number };
  }) => {
    try {
      const captureRect = normalizeCaptureRect(options?.rect);
      if (!captureRect) return { success: false, error: 'Capture rect is required' };
      const image = await event.sender.capturePage(captureRect);
      const pngBuffer = image.toPNG();
      return {
        success: true,
        width: captureRect.width,
        height: captureRect.height,
        pngBase64: pngBuffer.toString('base64'),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to capture session image chunk' };
    }
  });

  ipcMain.handle('cowork:session:saveResultImage', async (event, options: {
    pngBase64: string;
    defaultFileName?: string;
  }) => {
    try {
      const base64 = typeof options?.pngBase64 === 'string' ? options.pngBase64.trim() : '';
      if (!base64) return { success: false, error: 'Image data is required' };
      const pngBuffer = Buffer.from(base64, 'base64');
      if (pngBuffer.length <= 0) return { success: false, error: 'Invalid image data' };
      return savePngWithDialog(event.sender, pngBuffer, options?.defaultFileName);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to save session image' };
    }
  });

  // ==================== Permission ====================

  ipcMain.handle('cowork:permission:respond', async (_event, options: {
    requestId: string;
    result: PermissionResult;
  }) => {
    try {
      ctx.getCoworkEngineRouter().respondToPermission(options.requestId, options.result);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to respond to permission' };
    }
  });

  // ==================== Config ====================

  ipcMain.handle('cowork:config:get', async () => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get config' };
    }
  });

  ipcMain.handle('cowork:config:set', async (_event, config: {
    workingDirectory?: string;
    executionMode?: 'auto' | 'local' | 'sandbox';
    agentEngine?: CoworkAgentEngine;
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
  }) => {
    try {
      const normalizedExecutionMode =
        config.executionMode && String(config.executionMode) === 'container'
          ? 'local'
          : config.executionMode;
      const normalizedAgentEngine = config.agentEngine === 'yd_cowork'
        ? 'yd_cowork'
        : config.agentEngine === 'openclaw'
          ? 'openclaw'
          : undefined;
      const normalizedMemoryEnabled = typeof config.memoryEnabled === 'boolean'
        ? config.memoryEnabled
        : undefined;
      const normalizedMemoryImplicitUpdateEnabled = typeof config.memoryImplicitUpdateEnabled === 'boolean'
        ? config.memoryImplicitUpdateEnabled
        : undefined;
      const normalizedMemoryLlmJudgeEnabled = typeof config.memoryLlmJudgeEnabled === 'boolean'
        ? config.memoryLlmJudgeEnabled
        : undefined;
      const normalizedMemoryGuardLevel = config.memoryGuardLevel === 'strict'
        || config.memoryGuardLevel === 'standard'
        || config.memoryGuardLevel === 'relaxed'
        ? config.memoryGuardLevel
        : undefined;
      const normalizedMemoryUserMemoriesMaxItems =
        typeof config.memoryUserMemoriesMaxItems === 'number' && Number.isFinite(config.memoryUserMemoriesMaxItems)
          ? Math.max(
            MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
            Math.min(MAX_MEMORY_USER_MEMORIES_MAX_ITEMS, Math.floor(config.memoryUserMemoriesMaxItems))
          )
        : undefined;
      const normalizedConfig: Parameters<CoworkStore['setConfig']>[0] = {
        ...config,
        executionMode: normalizedExecutionMode,
        agentEngine: normalizedAgentEngine,
        memoryEnabled: normalizedMemoryEnabled,
        memoryImplicitUpdateEnabled: normalizedMemoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: normalizedMemoryLlmJudgeEnabled,
        memoryGuardLevel: normalizedMemoryGuardLevel,
        memoryUserMemoriesMaxItems: normalizedMemoryUserMemoriesMaxItems,
      };
      const previousConfig = ctx.getCoworkStore().getConfig();
      const previousWorkingDir = previousConfig.workingDirectory;
      ctx.getCoworkStore().setConfig(normalizedConfig);
      if (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir) {
        ctx.getSkillManager().handleWorkingDirectoryChange();
        const syncResult = syncMemoryFileOnWorkspaceChange(previousWorkingDir, normalizedConfig.workingDirectory);
        if (syncResult.error) {
          console.warn('[OpenClaw Memory] Workspace sync failed:', syncResult.error);
        }
        try {
          ensureDefaultIdentity(normalizedConfig.workingDirectory);
        } catch (err) {
          console.warn('[OpenClaw] ensureDefaultIdentity failed (non-fatal):', err);
        }
      }

      const nextConfig = ctx.getCoworkStore().getConfig();
      if (normalizedAgentEngine !== undefined && normalizedAgentEngine !== previousConfig.agentEngine) {
        ctx.getCoworkEngineRouter().handleEngineConfigChanged(normalizedAgentEngine);
      }
      const switchedToOpenClaw = normalizedAgentEngine === 'openclaw'
        && previousConfig.agentEngine !== 'openclaw';

      const shouldSyncOpenClawConfig = normalizedExecutionMode !== undefined
        || normalizedAgentEngine !== undefined
        || (normalizedConfig.workingDirectory !== undefined && normalizedConfig.workingDirectory !== previousWorkingDir);
      if (shouldSyncOpenClawConfig) {
        const syncResult = await ctx.syncOpenClawConfig({
          reason: 'cowork-config-change',
          restartGatewayIfRunning: true,
        });
        if (!syncResult.success && nextConfig.agentEngine === 'openclaw') {
          return {
            success: false,
            code: ENGINE_NOT_READY_CODE,
            error: syncResult.error || 'OpenClaw config sync failed.',
            engineStatus: syncResult.status || ctx.getOpenClawEngineManager().getStatus(),
          };
        }
      }

      if (switchedToOpenClaw) {
        void ctx.ensureOpenClawRunningForCowork().catch((error) => {
          console.error('[OpenClaw] Failed to auto-start gateway after engine switch:', error);
        });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set config' };
    }
  });

  // ==================== Memory ====================

  ipcMain.handle('cowork:memory:listEntries', async (_event, input: {
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);

      if (!memoryMigrationDone) {
        migrateSqliteToMemoryMd(filePath, {
          isMigrationDone: () => ctx.getStore().get<string>('openclawMemory.migration.v1.completed') === '1',
          markMigrationDone: () => {
            ctx.getStore().set('openclawMemory.migration.v1.completed', '1');
            memoryMigrationDone = true;
          },
          getActiveMemoryTexts: () => {
            return ctx.getCoworkStore().listUserMemories({ status: 'all', includeDeleted: false, limit: 200 })
              .map((m) => m.text);
          },
        });
        memoryMigrationDone = true;
      }

      const query = input?.query?.trim() || '';
      const entries = query
        ? searchMemoryEntries(filePath, query)
        : readMemoryEntries(filePath);
      return { success: true, entries };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list memory entries' };
    }
  });

  ipcMain.handle('cowork:memory:createEntry', async (_event, input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }) => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const entry = addMemoryEntry(filePath, input.text);
      return { success: true, entry };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create memory entry' };
    }
  });

  ipcMain.handle('cowork:memory:updateEntry', async (_event, input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }) => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      if (!input.text) return { success: false, error: 'Memory text is required' };
      const entry = updateMemoryEntry(filePath, input.id, input.text);
      if (!entry) return { success: false, error: 'Memory entry not found' };
      return { success: true, entry };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update memory entry' };
    }
  });

  ipcMain.handle('cowork:memory:deleteEntry', async (_event, input: { id: string }) => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const success = deleteMemoryEntry(filePath, input.id);
      return success ? { success: true } : { success: false, error: 'Memory entry not found' };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete memory entry' };
    }
  });

  ipcMain.handle('cowork:memory:getStats', async () => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const entries = readMemoryEntries(filePath);
      return {
        success: true,
        stats: {
          total: entries.length,
          created: entries.length,
          stale: 0,
          deleted: 0,
          explicit: entries.length,
          implicit: 0,
        },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get memory stats' };
    }
  });

  // ==================== Bootstrap Files ====================

  ipcMain.handle('cowork:bootstrap:read', async (_event, filename: string) => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      const content = readBootstrapFile(config.workingDirectory, filename);
      return { success: true, content };
    } catch (error) {
      return { success: false, content: '', error: error instanceof Error ? error.message : 'Failed to read bootstrap file' };
    }
  });

  ipcMain.handle('cowork:bootstrap:write', async (_event, filename: string, content: string) => {
    try {
      const config = ctx.getCoworkStore().getConfig();
      writeBootstrapFile(config.workingDirectory, filename, content);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write bootstrap file' };
    }
  });
}
