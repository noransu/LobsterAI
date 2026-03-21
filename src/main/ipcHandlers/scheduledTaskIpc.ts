/**
 * Scheduled Task IPC handlers (OpenClaw cron jobs).
 */
import { ipcMain } from 'electron';
import type { IpcContext } from './ipcContext';

export function registerScheduledTaskIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle('scheduledTask:list', async () => {
    try {
      if (!ctx.getOpenClawRuntimeAdapter()?.getGatewayClient()) {
        return { success: true, tasks: [] };
      }
      const tasks = await ctx.getCronJobService().listJobs();
      return { success: true, tasks };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list tasks' };
    }
  });

  ipcMain.handle('scheduledTask:get', async (_event, id: string) => {
    try {
      const task = await ctx.getCronJobService().getJob(id);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get task' };
    }
  });

  ipcMain.handle('scheduledTask:create', async (_event, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      const task = await ctx.getCronJobService().addJob(normalizedInput);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create task' };
    }
  });

  ipcMain.handle('scheduledTask:update', async (_event, id: string, input: any) => {
    try {
      const normalizedInput = input && typeof input === 'object' ? { ...input } : {};
      const task = await ctx.getCronJobService().updateJob(id, normalizedInput);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update task' };
    }
  });

  ipcMain.handle('scheduledTask:delete', async (_event, id: string) => {
    try {
      await ctx.getCronJobService().removeJob(id);
      return { success: true, result: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete task' };
    }
  });

  ipcMain.handle('scheduledTask:toggle', async (_event, id: string, enabled: boolean) => {
    try {
      const task = await ctx.getCronJobService().toggleJob(id, enabled);
      return { success: true, task };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle task' };
    }
  });

  ipcMain.handle('scheduledTask:runManually', async (_event, id: string) => {
    try {
      await ctx.getCronJobService().runJob(id);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[IPC] Manual run failed for ${id}:`, msg);
      return { success: false, error: msg };
    }
  });

  ipcMain.handle('scheduledTask:stop', async (_event, id: string) => {
    try {
      return { success: true, result: false };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop task' };
    }
  });

  ipcMain.handle('scheduledTask:listRuns', async (_event, taskId: string, limit?: number, offset?: number) => {
    try {
      const runs = await ctx.getCronJobService().listRuns(taskId, limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list runs' };
    }
  });

  ipcMain.handle('scheduledTask:countRuns', async (_event, taskId: string) => {
    try {
      const count = await ctx.getCronJobService().countRuns(taskId);
      return { success: true, count };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to count runs' };
    }
  });

  ipcMain.handle('scheduledTask:listAllRuns', async (_event, limit?: number, offset?: number) => {
    try {
      const runs = await ctx.getCronJobService().listAllRuns(limit, offset);
      return { success: true, runs };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list all runs' };
    }
  });

  ipcMain.handle('scheduledTask:resolveSession', async (_event, sessionKey: string) => {
    try {
      if (!sessionKey) return { success: true, session: null };
      const session = await ctx.getOpenClawRuntimeAdapter()?.fetchSessionByKey(sessionKey);
      return { success: true, session: session ?? null };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve session' };
    }
  });

  ipcMain.handle('scheduledTask:listChannels', async () => {
    try {
      return { success: true, channels: ctx.listScheduledTaskChannels() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list channels' };
    }
  });
}
