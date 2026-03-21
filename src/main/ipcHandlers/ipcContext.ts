/**
 * Shared context object passed to all IPC handler modules.
 * Provides lazy access to singleton services without circular dependencies.
 */
import type { BrowserWindow } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkEngineRouter, CoworkAgentEngine } from '../libs/agentEngine';
import type { SkillManager } from '../skillManager';
import type { McpStore } from '../mcpStore';
import type { OpenClawEngineManager, OpenClawEngineStatus } from '../libs/openclawEngineManager';
import type { OpenClawRuntimeAdapter } from '../libs/agentEngine';
import type { IMGatewayManager, IMGatewayConfig, IMPlatform } from '../im';
import type { CronJobService } from '../libs/cronJobService';

export interface IpcContext {
  getStore: () => SqliteStore;
  getCoworkStore: () => CoworkStore;
  getCoworkRunner: () => CoworkRunner;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  getSkillManager: () => SkillManager;
  getMcpStore: () => McpStore;
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getOpenClawRuntimeAdapter: () => OpenClawRuntimeAdapter | null;
  getIMGatewayManager: () => IMGatewayManager;
  getCronJobService: () => CronJobService;
  getMainWindow: () => BrowserWindow | null;

  resolveCoworkAgentEngine: () => CoworkAgentEngine;
  ensureOpenClawRunningForCowork: () => Promise<OpenClawEngineStatus>;
  bootstrapOpenClawEngine: (options?: { forceReinstall?: boolean; reason?: string }) => Promise<OpenClawEngineStatus>;
  syncOpenClawConfig: (options: { reason: string; restartGatewayIfRunning?: boolean }) => Promise<{ success: boolean; changed: boolean; status?: OpenClawEngineStatus; error?: string }>;
  refreshMcpBridge: () => Promise<{ tools: number; error?: string }>;
  mergeCoworkSystemPrompt: (engine: CoworkAgentEngine, systemPrompt?: string) => string | undefined;
  listScheduledTaskChannels: () => Array<{ value: string; label: string }>;

  activeStreamControllers: Map<string, AbortController>;
  isDev: boolean;
}
