import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { agentService } from '../../services/agent';
import { imService } from '../../services/im';
import { i18nService } from '../../services/i18n';
import { XMarkIcon, TrashIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type { Agent } from '../../types/agent';
import type { Platform } from '@shared/platform';
import type { IMGatewayConfig } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import { PlatformRegistry } from '@shared/platform';
import AgentSkillSelector from './AgentSkillSelector';
import EmojiPicker from './EmojiPicker';

type SettingsTab = 'basic' | 'skills' | 'im';

interface AgentSettingsPanelProps {
  agentId: string | null;
  onClose: () => void;
  onSwitchAgent?: (agentId: string) => void;
}

const AgentSettingsPanel: React.FC<AgentSettingsPanelProps> = ({ agentId, onClose, onSwitchAgent }) => {
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const [, setAgent] = useState<Agent | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [identity, setIdentity] = useState('');
  const [icon, setIcon] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUnsavedConfirm, setShowUnsavedConfirm] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('basic');

  // IM binding state
  const [imConfig, setImConfig] = useState<IMGatewayConfig | null>(null);
  const [boundPlatforms, setBoundPlatforms] = useState<Set<Platform>>(new Set());
  const [initialBoundPlatforms, setInitialBoundPlatforms] = useState<Set<Platform>>(new Set());

  // Snapshot of initial values for dirty detection
  const initialValuesRef = useRef({
    name: '',
    description: '',
    systemPrompt: '',
    identity: '',
    icon: '',
    skillIds: [] as string[],
  });

  useEffect(() => {
    if (!agentId) return;
    setActiveTab('basic');
    setShowDeleteConfirm(false);
    setShowUnsavedConfirm(false);
    window.electron?.agents?.get(agentId).then((a) => {
      if (a) {
        setAgent(a);
        setName(a.name);
        setDescription(a.description);
        setSystemPrompt(a.systemPrompt);
        setIdentity(a.identity);
        setIcon(a.icon);
        setSkillIds(a.skillIds ?? []);
        initialValuesRef.current = {
          name: a.name,
          description: a.description,
          systemPrompt: a.systemPrompt,
          identity: a.identity,
          icon: a.icon,
          skillIds: a.skillIds ?? [],
        };
      }
    });
    // Load IM config for bindings
    imService.loadConfig().then((cfg) => {
      if (cfg) {
        setImConfig(cfg);
        const bindings = cfg.settings?.platformAgentBindings || {};
        const bound = new Set<Platform>();
        for (const [platform, boundAgentId] of Object.entries(bindings)) {
          if (boundAgentId === agentId) {
            bound.add(platform as Platform);
          }
        }
        setBoundPlatforms(bound);
        setInitialBoundPlatforms(new Set(bound));
      }
    });
  }, [agentId]);

  const isDirty = useCallback((): boolean => {
    const init = initialValuesRef.current;
    if (name !== init.name) return true;
    if (description !== init.description) return true;
    if (systemPrompt !== init.systemPrompt) return true;
    if (identity !== init.identity) return true;
    if (icon !== init.icon) return true;
    if (skillIds.length !== init.skillIds.length || skillIds.some((id, i) => id !== init.skillIds[i])) return true;
    if (boundPlatforms.size !== initialBoundPlatforms.size || [...boundPlatforms].some((p) => !initialBoundPlatforms.has(p))) return true;
    return false;
  }, [name, description, systemPrompt, identity, icon, skillIds, boundPlatforms, initialBoundPlatforms]);

  if (!agentId) return null;

  const handleClose = () => {
    if (isDirty()) {
      setShowUnsavedConfirm(true);
    } else {
      onClose();
    }
  };

  const handleConfirmDiscard = () => {
    setShowUnsavedConfirm(false);
    onClose();
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const result = await agentService.updateAgent(agentId, {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        identity: identity.trim(),
        icon: icon.trim(),
        skillIds,
      });
      if (!result) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
        return;
      }
      // Persist IM bindings if changed
      const bindingsChanged =
        boundPlatforms.size !== initialBoundPlatforms.size ||
        [...boundPlatforms].some((p) => !initialBoundPlatforms.has(p));
      if (bindingsChanged && imConfig) {
        const currentBindings = { ...(imConfig.settings?.platformAgentBindings || {}) };
        // Remove old bindings for this agent
        for (const key of Object.keys(currentBindings)) {
          if (currentBindings[key] === agentId) {
            delete currentBindings[key];
          }
        }
        // Add new bindings
        for (const platform of boundPlatforms) {
          currentBindings[platform] = agentId;
        }
        await imService.persistConfig({
          settings: { ...imConfig.settings, platformAgentBindings: currentBindings },
        });
        await imService.saveAndSyncConfig();
      }
      onClose();
    } catch {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('agentSaveFailed') }));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const success = await agentService.deleteAgent(agentId);
    if (success) {
      setShowDeleteConfirm(false);
      onClose();
    }
  };

  const handleToggleIMBinding = (platform: Platform) => {
    const next = new Set(boundPlatforms);
    if (next.has(platform)) {
      next.delete(platform);
    } else {
      next.add(platform);
    }
    setBoundPlatforms(next);
  };

  const isPlatformConfigured = (platform: Platform): boolean => {
    if (!imConfig) return false;
    return imConfig[platform]?.enabled === true;
  };

  const isMainAgent = agentId === 'main';

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'basic', label: i18nService.t('agentTabBasic') || 'Basic Info' },
    { key: 'skills', label: i18nService.t('agentTabSkills') || 'Skills' },
    { key: 'im', label: i18nService.t('agentTabIM') || 'IM Channels' },
  ];

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleClose}>
        <div
          className="w-full max-w-2xl mx-4 rounded-xl shadow-xl bg-surface border border-border max-h-[80vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header: agent icon + name + close */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-xl">{icon || '🤖'}</span>
              <h3 className="text-base font-semibold text-foreground">
                {name || (i18nService.t('agentSettings') || 'Agent Settings')}
              </h3>
            </div>
            <button type="button" onClick={handleClose} className="p-1 rounded-lg hover:bg-surface-raised">
              <XMarkIcon className="h-5 w-5 text-secondary" />
            </button>
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-border px-5">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                  activeTab === tab.key
                    ? 'text-primary'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {tab.label}
                {activeTab === tab.key && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="px-5 py-4 overflow-y-auto flex-1 min-h-[300px]">
            {activeTab === 'basic' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">
                    {i18nService.t('agentName') || 'Name'}
                  </label>
                  <div className="flex gap-2">
                    <EmojiPicker value={icon} onChange={setIcon} />
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="flex-1 px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">
                    {i18nService.t('agentDescription') || 'Description'}
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">
                    {i18nService.t('systemPrompt') || 'System Prompt'}
                  </label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm resize-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1">
                    {i18nService.t('agentIdentity') || 'Identity'}
                  </label>
                  <textarea
                    value={identity}
                    onChange={(e) => setIdentity(e.target.value)}
                    rows={3}
                    placeholder={i18nService.t('agentIdentityPlaceholder') || 'Identity description (IDENTITY.md)...'}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-transparent text-foreground text-sm resize-none"
                  />
                </div>
              </div>
            )}

            {activeTab === 'skills' && (
              <AgentSkillSelector selectedSkillIds={skillIds} onChange={setSkillIds} />
            )}

            {activeTab === 'im' && (
              <div>
                <p className="text-xs text-secondary/60 mb-4">
                  {i18nService.t('agentIMBindHint') || 'Select IM channels this Agent responds to'}
                </p>
                <div className="space-y-1">
                 {PlatformRegistry.platforms
                    .filter((platform) => (getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[]).includes(platform))
                    .map((platform) => {
                      const logo = PlatformRegistry.logo(platform);
                     const configured = isPlatformConfigured(platform);
                     const bound = boundPlatforms.has(platform);
                    return (
                      <div
                        key={platform}
                        className={`flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors ${
                          configured
                            ? 'hover:bg-surface-raised cursor-pointer'
                            : 'opacity-50'
                        }`}
                        onClick={() => configured && handleToggleIMBinding(platform)}
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center">
                            <img src={logo} alt={i18nService.t(platform)} className="w-6 h-6 object-contain rounded" />
                          </div>
                          <div>
                            <div className="text-sm font-medium text-foreground">
                              {i18nService.t(platform)}
                            </div>
                            {!configured && (
                              <div className="text-xs text-secondary/50">
                                {i18nService.t('agentIMNotConfiguredHint') || 'Please configure in Settings > IM Bots first'}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {configured ? (
                            <div
                              className={`relative w-9 h-5 rounded-full transition-colors ${
                                bound ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
                              }`}
                            >
                              <div
                                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                                  bound ? 'translate-x-4' : 'translate-x-0.5'
                                }`}
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-secondary/50">
                              {i18nService.t('agentIMNotConfigured') || 'Not configured'}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t border-border">
            <div>
              {!isMainAgent && (
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('delete') || 'Delete'}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              {onSwitchAgent && agentId !== currentAgentId && (
                <button
                  type="button"
                  onClick={() => onSwitchAgent(agentId)}
                  className="px-4 py-2 text-sm font-medium rounded-lg border border-primary text-primary hover:bg-primary/10 transition-colors"
                >
                  {i18nService.t('switchToAgent') || 'Use this Agent'}
                </button>
              )}
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm font-medium rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                {i18nService.t('cancel') || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!name.trim() || saving}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? (i18nService.t('saving') || 'Saving...') : (i18nService.t('save') || 'Save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-80 rounded-xl shadow-2xl bg-surface border border-border p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mb-3">
                <ExclamationTriangleIcon className="w-5 h-5 text-red-500" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                {i18nService.t('agentDeleteConfirmTitle') || 'Confirm Delete Agent'}
              </h3>
              <p className="text-sm text-secondary mb-5">
                {(i18nService.t('agentDeleteConfirmMessage') || 'Are you sure you want to delete Agent "{name}"? This action cannot be undone.').replace('{name}', name)}
              </p>
              <div className="flex items-center gap-3 w-full">
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 px-4 py-2 text-sm rounded-lg text-foreground border border-border hover:bg-surface-raised transition-colors"
                >
                  {i18nService.t('cancel') || 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex-1 px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors"
                >
                  {i18nService.t('delete') || 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved Changes Confirmation Modal */}
      {showUnsavedConfirm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onClick={() => setShowUnsavedConfirm(false)}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-80 rounded-xl shadow-2xl bg-surface border border-border p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
                <ExclamationTriangleIcon className="w-5 h-5 text-amber-500" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                {i18nService.t('agentUnsavedTitle') || 'Unsaved Changes'}
              </h3>
              <p className="text-sm text-secondary mb-5">
                {i18nService.t('agentUnsavedMessage') || 'You have unsaved changes. Are you sure you want to discard them?'}
              </p>
              <div className="flex items-center gap-3 w-full">
                <button
                  type="button"
                  onClick={() => setShowUnsavedConfirm(false)}
                  className="flex-1 px-4 py-2 text-sm rounded-lg text-foreground border border-border hover:bg-surface-raised transition-colors"
                >
                  {i18nService.t('cancel') || 'Cancel'}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDiscard}
                  className="flex-1 px-4 py-2 text-sm rounded-lg bg-amber-500 text-white hover:bg-amber-600 transition-colors"
                >
                  {i18nService.t('discard') || 'Discard'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AgentSettingsPanel;
