// AI agent persistence, verified connection health, and isolated chat/inline
// coordination.
//
// The implementation is deliberately independent from the legacy BOBO/global
// object.  renderer/compat/ai-service-adapter.ts supplies the schema, prompt,
// state, and private host ports and projects the historical facade.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  AiActiveConnectionsResultDto,
  AiApplySettingsOptions,
  AiChatMessageDto,
  AiChatPayloadDto,
  AiConnectionDto,
  AiHealthDto,
  AiInlineCompletionResultDto,
  AiInlineContextDto,
  AiInlineRequestDto,
  AiLegacyModelDto,
  AiOperationResultDto,
  AiProfileDto,
  AiPurpose,
  AiResultErrorDto,
  AiService,
  AiServiceDependencies,
  AiServiceFacade,
  AiServiceMutableState,
  AiSettingsDto,
  AiStatusDto,
  AiStreamChunkDto,
  AiStreamEndDto,
  AiStreamErrorDto,
  AiStreamChunkListener,
  AiStreamEndListener,
  AiStreamErrorListener
} from '../types/ai-service';
import type { AiPromptContextDto } from '../types/ai-prompts';

export const AI_SERVICE_ID = 'workbench.aiService' as const;

const INLINE_CACHE_LIMIT = 80;

type MutableRecord = Record<string, unknown>;
type PurposeHealth = Record<AiPurpose, Record<string, AiHealthDto>>;
type PurposeNonce = Record<AiPurpose, Record<string, number>>;

interface CompatibilitySnapshot {
  readonly chatModel: string | undefined;
  readonly inlineModel: string | undefined;
  readonly inlineEnabled: boolean | undefined;
  readonly inlineDebounceMs: number | undefined;
  readonly chatSystemPrompt: string | undefined;
  readonly inlineInstruction: string | undefined;
  readonly inlinePrefixChars: number | undefined;
  readonly inlineSuffixChars: number | undefined;
  readonly inlineMaxTokens: number | undefined;
}

interface SettingsFailure {
  readonly failed: true;
  readonly result: AiResultErrorDto;
}

function isRecord(value: unknown): value is MutableRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePurpose(purpose: unknown): AiPurpose {
  return purpose === 'inline' ? 'inline' : 'chat';
}

function normalizeEndpoint(value: unknown): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  if (isRecord(error) && error.message !== undefined) return String(error.message);
  // The legacy implementation only consumed `.message`; non-error thrown
  // values therefore intentionally became an empty detail string.
  return '';
}

function resultError(code: string, detail?: unknown): AiResultErrorDto {
  // Keep the old truthiness rule: falsy details were represented by an empty
  // string, while truthy values were stringified at the service boundary.
  return { success: false, code, detail: String(detail || '') };
}

function mutableRecord(value: unknown): MutableRecord {
  return isRecord(value) ? value : {};
}

function subscriptionDisposable(candidate: unknown): { dispose(): void } {
  return toDisposable(typeof candidate === 'function' ? candidate as () => void : () => {});
}

function replaceCanonicalState(ai: AiServiceMutableState, normalized: AiSettingsDto): void {
  ai.schemaVersion = normalized.schemaVersion;
  ai.chatProfiles = normalized.chatProfiles as AiProfileDto[];
  ai.inlineProfiles = normalized.inlineProfiles as AiProfileDto[];
  ai.chatProfileId = normalized.chatProfileId;
  ai.inlineProfileId = normalized.inlineProfileId;
  ai.globalInstructions = normalized.globalInstructions;
  ai.chat = normalized.chat as AiServiceMutableState['chat'];
  ai.inline = normalized.inline as AiServiceMutableState['inline'];
  ai.chatOpen = normalized.chatOpen;
}

export function createAiService(dependencies: AiServiceDependencies): AiService {
  const ai = dependencies.state.ai;
  const schema = dependencies.schema;
  const host = dependencies.host;
  const lifecycle = new DisposableStore();

  const chatListeners: {
    chunk: AiStreamChunkListener | null;
    end: AiStreamEndListener | null;
    error: AiStreamErrorListener | null;
  } = { chunk: null, end: null, error: null };
  let activeChatNonce = 0;
  let activeChatRequestId = '';
  let inlineNonce = 0;
  let activeInlineRequestId = '';
  const inlineCache = new Map<string, string>();
  let compatibilitySnapshot: CompatibilitySnapshot | null = null;
  let committedSettings: AiSettingsDto | null = null;
  let settingsWriteQueue: Promise<void> = Promise.resolve();
  const connectionTestNonce: PurposeNonce = {
    chat: Object.create(null) as Record<string, number>,
    inline: Object.create(null) as Record<string, number>
  };
  let streamListenersBound = false;
  let disposed = false;
  let lifecycleGeneration = 0;

  function isCurrentGeneration(generation: number): boolean {
    return !disposed && generation === lifecycleGeneration;
  }

  function cancelledStatus(): AiStatusDto {
    return { state: 'cancelled', code: 'ai.error.cancelled' };
  }

  function cancelledActiveConnections(): AiActiveConnectionsResultDto {
    return { chat: cancelledStatus(), inline: cancelledStatus() };
  }

  function requireSchema(): typeof schema {
    if (!schema || typeof schema.normalizeSettings !== 'function') {
      throw new Error('ai-settings-schema.js must load before ai-service.js');
    }
    return schema;
  }

  function settingsFromState(): AiSettingsDto {
    return requireSchema().normalizeSettings({
      schemaVersion: ai.schemaVersion,
      chatProfiles: ai.chatProfiles,
      inlineProfiles: ai.inlineProfiles,
      chatProfileId: ai.chatProfileId,
      inlineProfileId: ai.inlineProfileId,
      globalInstructions: ai.globalInstructions,
      chat: ai.chat,
      inline: ai.inline,
      chatOpen: ai.chatOpen
    });
  }

  function profileToLegacy(
    profile: AiProfileDto | null | undefined,
    purpose?: AiPurpose
  ): AiLegacyModelDto | null {
    if (!profile) return null;
    const result: MutableRecord = {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      apiKey: profile.apiKey,
      endpoint: profile.endpoint,
      modelId: profile.modelId,
      options: clone(profile.options || {}),
      isPreset: false
    };
    if (purpose === 'inline') {
      result.inlineEndpoint = profile.endpoint;
      result.inlineModelId = profile.modelId;
      result.inlineMode = profile.mode;
    }
    return result as AiLegacyModelDto;
  }

  function writeCompatibilityAliases(): void {
    const chat = ai.chat;
    const inline = ai.inline;
    const profiles: AiLegacyModelDto[] = [];
    for (const profile of ai.chatProfiles || []) {
      const legacy = profileToLegacy(profile, 'chat');
      if (!legacy) continue;
      const inlineMatch = (ai.inlineProfiles || []).find((item) => item.id === profile.id);
      if (inlineMatch) {
        const mutable = legacy as MutableRecord;
        mutable.inlineEndpoint = inlineMatch.endpoint;
        mutable.inlineModelId = inlineMatch.modelId;
        mutable.inlineMode = inlineMatch.mode;
      }
      profiles.push(legacy);
    }
    ai.profiles = profiles;
    ai.models = profiles.slice();
    ai.chatModel = ai.chatProfileId || '';
    ai.inlineModel = ai.inlineProfileId || '';
    ai.currentModel = ai.chatProfileId || '';
    ai.inlineEnabled = inline.enabled === true;
    ai.inlineDebounceMs = inline.debounceMs;
    ai.chatSystemPrompt = chat.instructions;
    ai.inlineInstruction = inline.instructions;
    ai.inlinePrefixChars = inline.context.prefixChars;
    ai.inlineSuffixChars = inline.context.suffixChars;
    ai.inlineMaxTokens = inline.parameters.maxTokens;
    compatibilitySnapshot = {
      chatModel: ai.chatModel,
      inlineModel: ai.inlineModel,
      inlineEnabled: ai.inlineEnabled,
      inlineDebounceMs: ai.inlineDebounceMs,
      chatSystemPrompt: ai.chatSystemPrompt,
      inlineInstruction: ai.inlineInstruction,
      inlinePrefixChars: ai.inlinePrefixChars,
      inlineSuffixChars: ai.inlineSuffixChars,
      inlineMaxTokens: ai.inlineMaxTokens
    };
  }

  function ensureHealthState(): PurposeHealth {
    const current = ai.connectionHealth as unknown as MutableRecord;
    if (!isRecord(current)) {
      ai.connectionHealth = { chat: {}, inline: {} };
    }
    const health = ai.connectionHealth as unknown as MutableRecord;
    if (!isRecord(health.chat)) health.chat = {};
    if (!isRecord(health.inline)) health.inline = {};
    return ai.connectionHealth as unknown as PurposeHealth;
  }

  function applySettings(value: unknown, options?: AiApplySettingsOptions): AiSettingsDto {
    const normalized = requireSchema().normalizeSettings(value);
    replaceCanonicalState(ai, normalized);
    ensureHealthState();
    writeCompatibilityAliases();
    if (!options || options.trackCommitted !== false) committedSettings = clone(normalized);
    return normalized;
  }

  function reconcileCompatibilityAliases(): void {
    if (!compatibilitySnapshot) return;
    const snapshot = compatibilitySnapshot;
    if (ai.chatModel !== snapshot.chatModel) ai.chatProfileId = ai.chatModel || '';
    if (ai.inlineModel !== snapshot.inlineModel) ai.inlineProfileId = ai.inlineModel || '';
    if (ai.inlineEnabled !== snapshot.inlineEnabled) ai.inline.enabled = ai.inlineEnabled === true;
    if (ai.inlineDebounceMs !== snapshot.inlineDebounceMs) {
      mutableRecord(ai.inline).debounceMs = ai.inlineDebounceMs;
    }
    if (ai.chatSystemPrompt !== snapshot.chatSystemPrompt) {
      mutableRecord(ai.chat).instructions = String(ai.chatSystemPrompt || '');
    }
    if (ai.inlineInstruction !== snapshot.inlineInstruction) {
      mutableRecord(ai.inline).instructions = String(ai.inlineInstruction || '');
    }
    if (ai.inlinePrefixChars !== snapshot.inlinePrefixChars) {
      mutableRecord(ai.inline.context).prefixChars = ai.inlinePrefixChars;
    }
    if (ai.inlineSuffixChars !== snapshot.inlineSuffixChars) {
      mutableRecord(ai.inline.context).suffixChars = ai.inlineSuffixChars;
    }
    if (ai.inlineMaxTokens !== snapshot.inlineMaxTokens) {
      mutableRecord(ai.inline.parameters).maxTokens = ai.inlineMaxTokens;
    }
  }

  function deepMerge(target: MutableRecord, patch: unknown): MutableRecord {
    if (!isRecord(patch)) return target;
    Object.keys(patch).forEach((key) => {
      const value = patch[key];
      if (isRecord(value) && isRecord(target[key])) deepMerge(target[key], value);
      else target[key] = clone(value);
    });
    return target;
  }

  function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!isRecord(value)) return value;
    const result: MutableRecord = {};
    Object.keys(value).sort().forEach((key) => { result[key] = stableValue(value[key]); });
    return result;
  }

  function fingerprint(profile: unknown, purpose?: AiPurpose): string {
    if (!profile) return '';
    const value = mutableRecord(profile);
    const source = JSON.stringify({
      purpose,
      id: value.id,
      provider: value.provider,
      protocol: value.protocol,
      authType: value.authType,
      endpoint: normalizeEndpoint(value.endpoint),
      modelId: String(value.modelId || '').trim(),
      apiKey: String(value.apiKey || ''),
      mode: purpose === 'inline' ? value.mode : 'chat',
      apiVersion: value.apiVersion,
      organizationId: value.organizationId,
      projectId: value.projectId,
      workspaceId: value.workspaceId,
      region: value.region,
      billingPlan: value.billingPlan,
      capabilities: stableValue(value.capabilities || {}),
      options: stableValue(value.options || {})
    });
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function activeConnectionSignatures(settings: unknown): { chat: string; inline: string } {
    const value = isRecord(settings) ? settings : {};
    const chatProfiles = Array.isArray(value.chatProfiles) ? value.chatProfiles : [];
    const inlineProfiles = Array.isArray(value.inlineProfiles) ? value.inlineProfiles : [];
    const chat = chatProfiles.find((profile) => isRecord(profile) && profile.id === value.chatProfileId) || null;
    const inlineSettings = isRecord(value.inline) ? value.inline : {};
    const inlineEnabled = Boolean(inlineSettings.enabled);
    const inline = inlineEnabled
      ? inlineProfiles.find((profile) => isRecord(profile) && profile.id === value.inlineProfileId) || null
      : null;
    return {
      chat: chat ? fingerprint(chat, 'chat') : '',
      inline: inlineEnabled ? (inline ? fingerprint(inline, 'inline') : 'missing') : 'disabled'
    };
  }

  function activeConnectionsChanged(before: unknown, after: unknown): boolean {
    const previous = activeConnectionSignatures(before);
    const next = activeConnectionSignatures(after);
    return previous.chat !== next.chat || previous.inline !== next.inline;
  }

  function profilesFor(purpose?: AiPurpose): AiProfileDto[] {
    return normalizePurpose(purpose) === 'inline' ? (ai.inlineProfiles || []) : (ai.chatProfiles || []);
  }

  function getProfileById(id: string, purpose?: AiPurpose): AiProfileDto | null {
    if (purpose) return profilesFor(purpose).find((profile) => profile.id === id) || null;
    return getProfileById(id, 'chat') || getProfileById(id, 'inline');
  }

  function getProfileFor(purpose?: AiPurpose): AiProfileDto | null {
    const selectedPurpose = normalizePurpose(purpose);
    const id = selectedPurpose === 'inline' ? ai.inlineProfileId : ai.chatProfileId;
    return getProfileById(id, selectedPurpose);
  }

  function normalizeCandidate(candidate: unknown, purpose: AiPurpose): AiProfileDto | null {
    if (!candidate) return null;
    return requireSchema().normalizeProfile(candidate, 0, purpose);
  }

  function connectionForProfile(profile: unknown, purpose: AiPurpose): AiConnectionDto | null {
    const normalized = normalizeCandidate(profile, purpose);
    if (!normalized) return null;
    return {
      id: normalized.id,
      name: normalized.name,
      provider: normalized.provider,
      protocol: normalized.protocol,
      authType: normalized.authType,
      apiKey: normalized.apiKey,
      endpoint: normalizeEndpoint(normalized.endpoint),
      modelId: String(normalized.modelId || '').trim(),
      mode: purpose === 'inline' && normalized.mode === 'fim' ? 'fim' : 'chat',
      apiVersion: normalized.apiVersion,
      organizationId: normalized.organizationId,
      projectId: normalized.projectId,
      workspaceId: normalized.workspaceId,
      region: normalized.region,
      billingPlan: normalized.billingPlan,
      capabilities: clone(normalized.capabilities || {}) as AiConnectionDto['capabilities'],
      options: clone(normalized.options || {}) as AiConnectionDto['options']
    };
  }

  function getConnectionFor(purpose?: AiPurpose): AiConnectionDto | null {
    const selectedPurpose = normalizePurpose(purpose);
    return connectionForProfile(getProfileFor(selectedPurpose), selectedPurpose);
  }

  function structuralStatus(candidate: unknown, purpose: AiPurpose): AiStatusDto {
    const connection = connectionForProfile(candidate, purpose);
    if (!connection) return { state: 'missing', code: 'ai.error.noModel' };
    if (!connection.endpoint) return { state: 'invalid', code: 'ai.error.endpointRequired' };
    if (!connection.modelId) return { state: 'invalid', code: 'ai.error.modelRequired' };
    if (!connection.apiKey) return { state: 'needs-key', code: 'ai.error.keyRequired' };
    return { state: 'complete', code: 'ai.status.untested' };
  }

  function modelStatus(candidate: unknown, purpose?: AiPurpose): AiStatusDto {
    const selectedPurpose = normalizePurpose(purpose);
    const structural = structuralStatus(candidate, selectedPurpose);
    if (structural.state !== 'complete') return structural;
    const profile = normalizeCandidate(candidate, selectedPurpose);
    if (!profile) return { state: 'missing', code: 'ai.error.noModel' };
    const health = ensureHealthState()[selectedPurpose][profile.id];
    if (!health || health.fingerprint !== fingerprint(profile, selectedPurpose)) {
      return { state: 'untested', code: 'ai.status.untested' };
    }
    return clone(health);
  }

  function updateStatus(status: string): void {
    if (disposed) return;
    ai.status = status;
    const button = dependencies.getAgentButton?.();
    if (button && typeof button.updateLEDs === 'function') button.updateLEDs(status);
  }

  function updateOverallStatus(): void {
    if (disposed) return;
    if (ai.chatStreaming) { updateStatus('thinking'); return; }
    const statuses: AiStatusDto[] = [];
    const chatProfile = getProfileFor('chat');
    const inlineProfile = ai.inline && ai.inline.enabled ? getProfileFor('inline') : null;
    if (chatProfile) statuses.push(modelStatus(chatProfile, 'chat'));
    if (ai.inline && ai.inline.enabled) statuses.push(modelStatus(inlineProfile, 'inline'));
    if (!statuses.length) { updateStatus('unconfigured'); return; }
    if (statuses.some((status) => status.state === 'error')) updateStatus('error');
    else if (statuses.some((status) => status.state === 'testing')) updateStatus('testing');
    else if (statuses.every((status) => status.state === 'ready')) updateStatus('idle');
    else updateStatus('unconfigured');
  }

  function invalidateHealth(): void {
    if (disposed) return;
    ai.connectionHealth = { chat: {}, inline: {} };
    updateOverallStatus();
  }

  function settingsFailure(code: string, detail?: unknown): SettingsFailure {
    return { failed: true, result: resultError(code, detail) };
  }

  function mergeChangedSettings(target: unknown, base: unknown, desired: unknown): unknown {
    if (JSON.stringify(base) === JSON.stringify(desired)) return clone(target);
    const objects = [target, base, desired].every((value) => isRecord(value));
    if (!objects) return clone(desired);
    const result = clone(target) as MutableRecord;
    const desiredRecord = desired as MutableRecord;
    const targetRecord = target as MutableRecord;
    const baseRecord = base as MutableRecord;
    Object.keys(desiredRecord).forEach((key) => {
      result[key] = mergeChangedSettings(targetRecord[key], baseRecord[key], desiredRecord[key]);
    });
    return result;
  }

  function persistCanonical(
    change: (latest: AiSettingsDto) => unknown,
    options?: { readonly retest?: boolean }
  ): Promise<AiOperationResultDto>;
  function persistCanonical(
    change: unknown,
    options?: { readonly retest?: boolean }
  ): Promise<AiOperationResultDto>;
  function persistCanonical(
    change: unknown,
    options?: { readonly retest?: boolean }
  ): Promise<AiOperationResultDto> {
    const requestGeneration = lifecycleGeneration;
    const transform = typeof change === 'function'
      ? change as (latest: AiSettingsDto) => unknown
      : () => change;
    const operation = settingsWriteQueue.then(async (): Promise<AiOperationResultDto> => {
      if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
      try {
        const before = requireSchema().normalizeSettings(settingsFromState());
        const outcome = transform(clone(before));
        if (isRecord(outcome) && outcome.failed === true) return outcome.result as AiResultErrorDto;
        const normalized = requireSchema().normalizeSettings(outcome);
        const written = await host.aiWriteSettings(normalized);
        if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
        if (written === false) return resultError('ai.error.settingsWrite');
        applySettings(normalized);
        if (options?.retest && activeConnectionsChanged(before, normalized)) {
          if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
          invalidateHealth();
          await testActiveConnections(requestGeneration);
          if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
        }
        return { success: true, settings: clone(normalized) };
      } catch (error) {
        if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
        return resultError('ai.error.settingsWrite', errorMessage(error));
      }
    });
    settingsWriteQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function loadSettings(): Promise<AiSettingsDto | AiResultErrorDto> {
    const requestGeneration = lifecycleGeneration;
    if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
    try {
      const settings = await host.aiReadSettings();
      if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
      const normalized = applySettings(settings || {});
      invalidateHealth();
      await testActiveConnections(requestGeneration);
      if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
      return clone(normalized);
    } catch (error) {
      if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
      updateStatus('error');
      return resultError('ai.error.settingsRead', errorMessage(error));
    }
  }

  function saveSettings(): Promise<AiOperationResultDto> {
    if (disposed) return Promise.resolve(resultError('ai.error.cancelled'));
    const base = clone(committedSettings || settingsFromState());
    const current = settingsFromState();
    reconcileCompatibilityAliases();
    const candidate = settingsFromState();
    applySettings(current, { trackCommitted: false });
    return persistCanonical((latest) => mergeChangedSettings(latest, base, candidate), { retest: false });
  }

  function updateSettings(patch?: unknown): Promise<AiOperationResultDto> {
    if (disposed) return Promise.resolve(resultError('ai.error.cancelled'));
    const value = clone(patch || {});
    inlineCache.clear();
    return persistCanonical((next) => deepMerge(next as unknown as MutableRecord, value), { retest: true });
  }

  function getSettings(): AiSettingsDto { return clone(settingsFromState()); }

  async function addProfile(value: unknown, purpose?: AiPurpose): Promise<AiOperationResultDto> {
    if (disposed) return resultError('ai.error.cancelled');
    const selectedPurpose = normalizePurpose(purpose);
    const key = selectedPurpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    const candidate = clone(value || {});
    return persistCanonical((next) => {
      const nextRecord = next as unknown as MutableRecord;
      const list = nextRecord[key] as AiProfileDto[];
      const profile = requireSchema().normalizeProfile(candidate, list.length, selectedPurpose);
      if (list.some((entry) => entry.id === profile.id)) return settingsFailure('ai.error.profileExists');
      list.push(profile);
      return next;
    }, { retest: true });
  }

  async function updateProfile(id: string, patch: unknown, purpose?: AiPurpose): Promise<AiOperationResultDto> {
    if (disposed) return resultError('ai.error.cancelled');
    const selectedPurpose = normalizePurpose(purpose);
    const key = selectedPurpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    const value = clone(patch || {});
    inlineCache.clear();
    return persistCanonical((next) => {
      const nextRecord = next as unknown as MutableRecord;
      const list = nextRecord[key] as AiProfileDto[];
      const index = list.findIndex((profile) => profile.id === id);
      if (index < 0) return settingsFailure('ai.error.noModel');
      const merged = deepMerge(clone(list[index]) as unknown as MutableRecord, value);
      merged.id = id;
      list[index] = requireSchema().normalizeProfile(merged, index, selectedPurpose);
      return next;
    }, { retest: true });
  }

  async function removeProfile(id: string, purpose?: AiPurpose): Promise<AiOperationResultDto> {
    if (disposed) return resultError('ai.error.cancelled');
    const selectedPurpose = normalizePurpose(purpose);
    const key = selectedPurpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
    inlineCache.clear();
    return persistCanonical((next) => {
      const nextRecord = next as unknown as MutableRecord;
      const list = nextRecord[key] as AiProfileDto[];
      nextRecord[key] = list.filter((profile) => profile.id !== id);
      if (selectedPurpose === 'chat' && nextRecord.chatProfileId === id) nextRecord.chatProfileId = '';
      if (selectedPurpose === 'inline' && nextRecord.inlineProfileId === id) nextRecord.inlineProfileId = '';
      return next;
    }, { retest: true });
  }

  async function setProfileFor(purpose: AiPurpose, id?: string): Promise<AiOperationResultDto> {
    if (disposed) return resultError('ai.error.cancelled');
    const selectedPurpose = normalizePurpose(purpose);
    return persistCanonical((next) => {
      const key = selectedPurpose === 'inline' ? 'inlineProfiles' : 'chatProfiles';
      const nextRecord = next as unknown as MutableRecord;
      const profiles = nextRecord[key] as AiProfileDto[];
      if (id && !profiles.some((profile) => profile.id === id)) return settingsFailure('ai.error.noModel');
      if (selectedPurpose === 'inline') {
        nextRecord.inlineProfileId = id || '';
        nextRecord.inline = { ...mutableRecord(nextRecord.inline), enabled: Boolean(id) };
      } else nextRecord.chatProfileId = id || '';
      return next;
    }, { retest: true });
  }

  function promptBuilder() {
    const prompts = dependencies.getPrompts();
    if (!prompts || typeof prompts.buildChatMessages !== 'function') {
      throw new Error('ai-prompts.js must load before ai-service.js');
    }
    return prompts;
  }

  function buildMessages(userMessage?: unknown, context?: unknown): AiChatMessageDto[] {
    return promptBuilder().buildChatMessages({
      settings: settingsFromState(),
      context: (context || {}) as AiPromptContextDto,
      history: ai.chatMessages || [],
      userMessage: String(userMessage || '')
    }).messages as AiChatMessageDto[];
  }

  function buildChatPayload(
    profile: unknown,
    userMessage?: unknown,
    context?: unknown,
    requestId?: string,
    stream?: boolean
  ): AiChatPayloadDto {
    const settings = settingsFromState();
    const built = promptBuilder().buildChatMessages({
      settings,
      context: (context || {}) as AiPromptContextDto,
      history: ai.chatMessages || [],
      userMessage: String(userMessage || '')
    });
    const parameters = settings.chat.parameters;
    return {
      requestId: requestId || ('chat-' + (++activeChatNonce)),
      messages: built.messages as AiChatMessageDto[],
      contextMetadata: built.metadata as unknown as Record<string, unknown>,
      modelConfig: connectionForProfile(profile, 'chat'),
      maxTokens: parameters.maxTokens,
      temperature: parameters.temperature,
      topP: parameters.topP,
      stop: parameters.stop,
      stream: stream !== false
    };
  }

  async function sendChat(message?: unknown, context?: unknown): Promise<AiOperationResultDto> {
    const requestGeneration = lifecycleGeneration;
    if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
    const profile = getProfileFor('chat');
    const status = modelStatus(profile, 'chat');
    if (status.state !== 'ready') {
      updateOverallStatus();
      if (chatListeners.error) chatListeners.error({ code: status.code });
      return resultError(status.code);
    }
    const payload = buildChatPayload(profile, message, context, '', true);
    const nonce = activeChatNonce;
    activeChatRequestId = payload.requestId;
    updateStatus('thinking');
    ai.chatStreaming = true;
    try {
      const response = await host.aiChatRequest(payload);
      if (!isCurrentGeneration(requestGeneration) || nonce !== activeChatNonce) {
        return resultError('ai.error.cancelled');
      }
      if (!response || response.error || response.success === false) {
        const code = response && response.code ? response.code : 'ai.error.requestFailed';
        const ownsRequest = activeChatRequestId === payload.requestId;
        if (ownsRequest) activeChatRequestId = '';
        updateStatus('error');
        ai.chatStreaming = false;
        if (ownsRequest && chatListeners.error) {
          chatListeners.error({ code, detail: response && response.error });
        }
        return resultError(code, response && response.error);
      }
      return { success: true };
    } catch (error) {
      if (!isCurrentGeneration(requestGeneration) || nonce !== activeChatNonce) {
        return resultError('ai.error.cancelled');
      }
      const ownsRequest = activeChatRequestId === payload.requestId;
      if (ownsRequest) activeChatRequestId = '';
      updateStatus('error');
      ai.chatStreaming = false;
      if (ownsRequest && chatListeners.error) {
        chatListeners.error({ code: 'ai.error.requestFailed', detail: errorMessage(error) });
      }
      return resultError('ai.error.requestFailed', errorMessage(error));
    }
  }

  function cancelStream(): Promise<unknown> {
    if (disposed) return Promise.resolve(resultError('ai.error.cancelled'));
    activeChatNonce += 1;
    activeChatRequestId = '';
    ai.chatStreaming = false;
    updateOverallStatus();
    return host.aiCancelStream();
  }

  function buildInlineRequest(
    candidate: unknown,
    context?: AiInlineContextDto,
    requestId?: string
  ): AiInlineRequestDto {
    const inlineContext = context || {};
    const settings = settingsFromState();
    const profile = normalizeCandidate(candidate || getProfileFor('inline'), 'inline');
    // Preserve the historical throw for a missing inline profile; callers use
    // modelStatus before constructing requests.
    const connection = connectionForProfile(profile, 'inline') as AiConnectionDto;
    const policy = settings.inline.context;
    const parameters = settings.inline.parameters;
    const before = String(inlineContext.codeBefore || '').slice(-policy.prefixChars);
    const after = String(inlineContext.codeAfter || '').slice(0, policy.suffixChars);
    const base: MutableRecord = {
      requestId,
      mode: connection.mode,
      modelConfig: connection,
      stream: false,
      maxTokens: parameters.maxTokens,
      temperature: parameters.temperature,
      topP: parameters.topP,
      stop: parameters.stop
    };
    if (connection.mode === 'fim') {
      base.prompt = before;
      base.suffix = after;
      return base as AiInlineRequestDto;
    }
    base.messages = [{
      role: 'user',
      content: promptBuilder().buildInlineChatMessage(settings, {
        codeBefore: before,
        codeAfter: after,
        language: inlineContext.language,
        fileName: inlineContext.fileName
      })
    }];
    return base as AiInlineRequestDto;
  }

  function extractInlineText(response: unknown): string {
    const outer = isRecord(response) ? response : {};
    const data = outer.data ? outer.data : response;
    if (!isRecord(data)) return '';
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : null;
    if (first) {
      if (typeof first.text === 'string') return first.text;
      const message = isRecord(first.message) ? first.message : null;
      if (message && typeof message.content === 'string') return message.content;
    }
    const content = Array.isArray(data.content) ? data.content : [];
    const firstContent = isRecord(content[0]) ? content[0] : null;
    if (firstContent && typeof firstContent.text === 'string') return firstContent.text;
    return '';
  }

  function extractChatText(response: unknown): string {
    const outer = isRecord(response) ? response : {};
    const data = outer.data ? outer.data : response;
    if (!isRecord(data)) return '';
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const first = isRecord(choices[0]) ? choices[0] : null;
    if (first) {
      const message = isRecord(first.message) ? first.message : null;
      if (message && typeof message.content === 'string') return message.content;
      if (typeof first.text === 'string') return first.text;
    }
    const content = Array.isArray(data.content) ? data.content : [];
    for (const item of content) {
      if (isRecord(item) && typeof item.text === 'string' && item.text.trim()) return item.text;
    }
    return '';
  }

  function hasProviderResponseShape(response: unknown, purpose: AiPurpose): boolean {
    const outer = isRecord(response) ? response : {};
    const data = outer.data ? outer.data : response;
    if (!isRecord(data) || (isRecord(response) && response.success === false) ||
        (isRecord(response) && response.error)) return false;
    const choices = Array.isArray(data.choices) ? data.choices : [];
    if (choices.length) {
      const choice = isRecord(choices[0]) ? choices[0] : {};
      if (purpose === 'inline') {
        return Object.prototype.hasOwnProperty.call(choice, 'text') ||
          Boolean(isRecord(choice.message) && Object.prototype.hasOwnProperty.call(choice.message, 'content'));
      }
      return Boolean(isRecord(choice.message) && Object.prototype.hasOwnProperty.call(choice.message, 'content')) ||
        Object.prototype.hasOwnProperty.call(choice, 'text');
    }
    return Array.isArray(data.content);
  }

  function inlineCacheKey(profile: unknown, context: AiInlineContextDto): string {
    const settings = settingsFromState();
    const connection = connectionForProfile(profile, 'inline');
    return [
      connection?.id,
      connection?.modelId,
      connection?.endpoint,
      connection?.mode,
      JSON.stringify(connection?.options),
      JSON.stringify(settings.inline),
      settings.globalInstructions,
      context.language,
      context.fileName,
      context.codeBefore,
      context.codeAfter
    ].join('\u0000');
  }

  function rememberInline(key: string, value: string): void {
    if (inlineCache.has(key)) inlineCache.delete(key);
    inlineCache.set(key, value);
    while (inlineCache.size > INLINE_CACHE_LIMIT) {
      const oldest = inlineCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      inlineCache.delete(oldest);
    }
  }

  async function getInlineCompletion(context: AiInlineContextDto): Promise<AiInlineCompletionResultDto> {
    const requestGeneration = lifecycleGeneration;
    if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
    const settings = settingsFromState();
    if (!settings.inline.enabled || !settings.inlineProfileId) return resultError('ai.error.inlineDisabled');
    const profile = getProfileFor('inline');
    const status = modelStatus(profile, 'inline');
    if (status.state !== 'ready') return resultError(status.code);
    const key = inlineCacheKey(profile, context);
    if (inlineCache.has(key)) {
      return { success: true, text: inlineCache.get(key), cached: true };
    }
    const previousRequestId = activeInlineRequestId;
    const requestId = 'inline-' + (++inlineNonce);
    activeInlineRequestId = requestId;
    if (previousRequestId) {
      try {
        void Promise.resolve(host.aiCancelInline(previousRequestId)).catch(() => {});
      } catch (_) {
        // Cancellation is best effort and must not delay the replacement.
      }
    }
    ai.inlineStatus = 'requesting';
    try {
      const response = await host.aiInlineRequest(buildInlineRequest(profile, context, requestId));
      if (!isCurrentGeneration(requestGeneration) || requestId !== 'inline-' + inlineNonce) {
        return resultError('ai.error.cancelled');
      }
      activeInlineRequestId = '';
      let text = extractInlineText(response).trim();
      ai.inlineStatus = 'idle';
      if (!response || response.success === false || !text) {
        return resultError(response && response.code || 'ai.error.noSuggestion');
      }
      const maxChars = Math.min(16000, Math.max(256, settings.inline.parameters.maxTokens * 8));
      text = text.replace(/^```[^\n]*\n?|```$/g, '').slice(0, maxChars);
      rememberInline(key, text);
      return { success: true, text, cached: false };
    } catch (error) {
      if (!isCurrentGeneration(requestGeneration) || requestId !== 'inline-' + inlineNonce) {
        return resultError('ai.error.cancelled');
      }
      activeInlineRequestId = '';
      ai.inlineStatus = 'degraded';
      return resultError('ai.error.requestFailed', errorMessage(error));
    }
  }

  function cancelInline(): void {
    if (disposed) return;
    inlineNonce += 1;
    ai.inlineStatus = 'idle';
    const requestId = activeInlineRequestId;
    activeInlineRequestId = '';
    if (!requestId) return;
    try {
      void Promise.resolve(host.aiCancelInline(requestId)).catch(() => {});
    } catch (_) {
      // Best-effort cancellation preserves the old non-blocking behavior.
    }
  }

  function clearInlineCache(): void { inlineCache.clear(); }

  async function testProfileConnection(
    candidate: unknown,
    purpose?: AiPurpose,
    expectedGeneration = lifecycleGeneration
  ): Promise<AiOperationResultDto> {
    const requestGeneration = expectedGeneration;
    if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
    const selectedPurpose = normalizePurpose(purpose);
    const profile = normalizeCandidate(candidate, selectedPurpose);
    const structural = structuralStatus(profile, selectedPurpose);
    if (structural.state !== 'complete') return resultError(structural.code);
    const currentFingerprint = fingerprint(profile, selectedPurpose);
    const currentProfile = profile ? getProfileById(profile.id, selectedPurpose) : null;
    const publishesHealth = Boolean(currentProfile && fingerprint(currentProfile, selectedPurpose) === currentFingerprint);
    const testKey = (profile?.id || '') + '\u0000' + currentFingerprint;
    const testNonce = (connectionTestNonce[selectedPurpose][testKey] || 0) + 1;
    connectionTestNonce[selectedPurpose][testKey] = testNonce;
    if (publishesHealth && profile) {
      ensureHealthState()[selectedPurpose][profile.id] = {
        state: 'testing', code: 'ai.status.testing', fingerprint: currentFingerprint, testNonce
      };
      updateOverallStatus();
    }

    function isLatestTest(): boolean {
      return isCurrentGeneration(requestGeneration) &&
        connectionTestNonce[selectedPurpose][testKey] === testNonce;
    }

    function canPublish(): boolean {
      if (!publishesHealth || !isLatestTest() || !profile) return false;
      const latestProfile = getProfileById(profile.id, selectedPurpose);
      const health = ensureHealthState()[selectedPurpose][profile.id];
      return Boolean(latestProfile && fingerprint(latestProfile, selectedPurpose) === currentFingerprint &&
        health && health.fingerprint === currentFingerprint && health.testNonce === testNonce);
    }

    function publish(record: AiHealthDto): boolean {
      if (!canPublish()) return false;
      if (profile) ensureHealthState()[selectedPurpose][profile.id] = record;
      updateOverallStatus();
      return true;
    }

    try {
      // Connection probes are context-free and intentionally deterministic.
      const payload: AiInlineRequestDto | AiChatPayloadDto = selectedPurpose === 'inline'
        ? {
            requestId: 'test-inline-' + Date.now(),
            mode: profile?.mode === 'fim' ? 'fim' : 'chat',
            modelConfig: connectionForProfile(profile, 'inline'),
            stream: false,
            maxTokens: 8,
            temperature: 0,
            topP: 1,
            stop: [],
            prompt: 'function connectionProbe() {\n  return ',
            suffix: ';\n}',
            messages: profile?.mode === 'fim' ? undefined : [{
              role: 'user', content: 'Complete this JavaScript expression: const connectionProbe = '
            }]
          } as AiInlineRequestDto
        : buildChatPayload(profile, 'Reply with the single word OK.', {}, 'test-chat-' + Date.now(), false);
      const response = await host.aiTestConnection(payload);
      if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
      const success = hasProviderResponseShape(response, selectedPurpose);
      const record: AiHealthDto = success
        ? { state: 'ready', code: 'ai.status.connected', fingerprint: currentFingerprint, checkedAt: Date.now() }
        : {
            state: 'error',
            code: response && response.code || 'ai.error.connectionFailed',
            // Keep the raw provider detail on the trusted internal record. The
            // public DTO describes the usual string shape, but older providers
            // occasionally return structured errors and the legacy service
            // preserved those values verbatim.
            detail: (response && response.error || '') as string,
            fingerprint: currentFingerprint,
            checkedAt: Date.now()
          };
      if (!isLatestTest()) return resultError('ai.error.cancelled');
      if (publishesHealth && !publish(record)) return resultError('ai.error.cancelled');
      return success ? { success: true, health: clone(record) } : resultError(record.code, record.detail);
    } catch (error) {
      if (!isCurrentGeneration(requestGeneration)) return resultError('ai.error.cancelled');
      const failed: AiHealthDto = {
        state: 'error',
        code: 'ai.error.connectionFailed',
        detail: errorMessage(error),
        fingerprint: currentFingerprint,
        checkedAt: Date.now()
      };
      if (!isLatestTest()) return resultError('ai.error.cancelled');
      if (publishesHealth && !publish(failed)) return resultError('ai.error.cancelled');
      return resultError(failed.code, failed.detail);
    }
  }

  async function testActiveConnections(
    expectedGeneration = lifecycleGeneration
  ): Promise<AiActiveConnectionsResultDto> {
    const requestGeneration = expectedGeneration;
    if (!isCurrentGeneration(requestGeneration)) return cancelledActiveConnections();
    const tasks: Array<Promise<AiOperationResultDto>> = [];
    const chatProfile = getProfileFor('chat');
    const inlineProfile = ai.inline && ai.inline.enabled ? getProfileFor('inline') : null;
    if (chatProfile) tasks.push(testProfileConnection(chatProfile, 'chat', requestGeneration));
    if (inlineProfile) tasks.push(testProfileConnection(inlineProfile, 'inline', requestGeneration));
    if (!tasks.length) updateOverallStatus();
    await Promise.all(tasks);
    if (!isCurrentGeneration(requestGeneration)) return cancelledActiveConnections();
    return {
      chat: modelStatus(chatProfile, 'chat'),
      inline: inlineProfile ? modelStatus(inlineProfile, 'inline') : { state: 'disabled', code: 'ai.control.status.disabled' }
    };
  }

  function setupStreamListeners(): void {
    if (streamListenersBound) return;
    const listenerGeneration = lifecycleGeneration;
    streamListenersBound = true;
    lifecycle.add(subscriptionDisposable(host.onAiChunk((data: AiStreamChunkDto) => {
      if (!isCurrentGeneration(listenerGeneration) || !activeChatRequestId || !data || data.requestId !== activeChatRequestId) return;
      if (chatListeners.chunk) chatListeners.chunk(data);
    })));
    lifecycle.add(subscriptionDisposable(host.onAiStreamEnd((data: AiStreamEndDto) => {
      if (!isCurrentGeneration(listenerGeneration) || !activeChatRequestId || !data || data.requestId !== activeChatRequestId) return;
      activeChatRequestId = '';
      ai.chatStreaming = false;
      updateOverallStatus();
      if (chatListeners.end) chatListeners.end(data);
    })));
    lifecycle.add(subscriptionDisposable(host.onAiStreamError((data: AiStreamErrorDto) => {
      if (!isCurrentGeneration(listenerGeneration) || !activeChatRequestId || !data || data.requestId !== activeChatRequestId) return;
      activeChatRequestId = '';
      ai.chatStreaming = false;
      updateStatus('error');
      if (chatListeners.error) {
        chatListeners.error(data.code ? data : { code: 'ai.error.requestFailed', detail: data.message });
      }
    })));
  }

  async function init(): Promise<AiSettingsDto | AiResultErrorDto> {
    if (disposed) return resultError('ai.error.cancelled');
    requireSchema();
    promptBuilder();
    setupStreamListeners();
    return loadSettings();
  }

  function legacyToProfile(model: unknown, purpose: AiPurpose): AiProfileDto {
    return requireSchema().normalizeProfile(model || {}, 0, purpose);
  }

  function addModel(
    modelOrName: unknown,
    provider?: unknown,
    endpoint?: unknown,
    modelId?: unknown,
    apiKey?: unknown
  ): Promise<AiOperationResultDto> {
    const value = isRecord(modelOrName)
      ? modelOrName
      : { id: 'chat-agent-' + Date.now(), name: modelOrName, provider, endpoint, modelId, apiKey };
    return addProfile(legacyToProfile(value, 'chat'), 'chat');
  }

  function updateModel(id: string, updates: unknown): Promise<AiOperationResultDto> {
    return updateProfile(id, updates, 'chat');
  }

  function removeModel(id: string): Promise<AiOperationResultDto> {
    return removeProfile(id, 'chat');
  }

  function setModelFor(purpose: AiPurpose, id?: string): Promise<AiOperationResultDto> {
    return setProfileFor(purpose, id);
  }

  function setCurrentModel(id?: string): Promise<AiOperationResultDto> {
    return setProfileFor('chat', id);
  }

  function dispose(): void {
    if (disposed) return;
    lifecycleGeneration += 1;
    disposed = true;
    activeChatNonce += 1;
    activeChatRequestId = '';
    inlineNonce += 1;
    activeInlineRequestId = '';
    chatListeners.chunk = null;
    chatListeners.end = null;
    chatListeners.error = null;
    inlineCache.clear();
    lifecycle.dispose();
  }

  const facade: AiServiceFacade = {
    init,
    loadSettings,
    saveSettings,
    getSettings,
    updateSettings,
    applySettings,
    sendChat,
    cancelStream,
    getInlineCompletion,
    cancelInline,
    clearInlineCache,
    updateStatus,
    onStreamChunk: (callback) => { chatListeners.chunk = callback; },
    onStreamEnd: (callback) => { chatListeners.end = callback; },
    onStreamError: (callback) => { chatListeners.error = callback; },
    getProfiles: (purpose) => clone(profilesFor(purpose)),
    getProfileFor,
    getProfileById,
    getConnectionFor,
    addProfile,
    updateProfile,
    removeProfile,
    setProfileFor,
    testProfileConnection,
    testActiveConnections,
    getConnectionHealth: (purpose, id) => (
      clone(ensureHealthState()[normalizePurpose(purpose)][id] || null)
    ),
    getModelFor: (purpose) => profileToLegacy(getProfileFor(purpose), purpose),
    getModelById: (id, purpose) => profileToLegacy(getProfileById(id, purpose), purpose),
    getCurrentModelConfig: () => profileToLegacy(getProfileFor('chat'), 'chat'),
    getCurrentModelName: () => {
      const profile = getProfileFor('chat');
      return profile ? profile.name : '';
    },
    getModelStatus: modelStatus,
    addModel,
    updateModel,
    removeModel,
    setCurrentModel,
    setModelFor,
    testModelConnection: testProfileConnection,
    buildChatPayload,
    buildInlineRequest,
    buildMessages,
    extractInlineText,
    extractChatText,
    sanitizeModel: (model) => profileToLegacy(legacyToProfile(model, 'chat'), 'chat'),
    fingerprint
  };

  const service: AiService = {
    ...facade,
    get disposed(): boolean { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
