import { rendererPlatform } from '../core/bootstrap';
import type {
  ContributionChangeEventFor,
  ContributionEntryFor
} from '../core/contribution-registry';
import {
  FileDecorationLane,
  contributionPointForDecorationLane,
  decorationLaneForContributionPoint,
  normalizeFileDecoration
} from '../core/file-decoration';
import { toDisposable } from '../core/disposable';
import type {
  FileDecorationChangeEvent,
  FileDecorationChangeListener,
  FileDecorationPointId,
  FileDecorationProvider,
  FileDecorationService
} from '../../types/file-decoration';
import type { Disposable } from '../../types/lifecycle';
import type { RendererContributionMap } from '../../types/renderer-platform';

export const FILE_DECORATIONS_SERVICE_ID = 'workbench.fileDecorations' as const;

const FILE_DECORATION_LANES = Object.freeze([
  FileDecorationLane.SYNC,
  FileDecorationLane.SCM,
  FileDecorationLane.DIAGNOSTIC
] as const);

type DecorationEntry = ContributionEntryFor<RendererContributionMap, FileDecorationPointId>;
type DecorationChange = ContributionChangeEventFor<RendererContributionMap, FileDecorationPointId>;
type ErrorEntry = { readonly id?: unknown } | null;

interface ProviderSubscription {
  active: boolean;
  disposable: Disposable | null;
  readonly owner: string;
  readonly contribution: FileDecorationProvider;
}

function reportDecorationError(phase: string, entry: ErrorEntry, error: unknown): void {
  try {
    console.error('[renderer-platform:file-decoration:' + phase + ']', entry && entry.id || '', error);
  } catch (_) {
    // A provider failure must not escape through host logging.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && value !== undefined &&
    typeof (value as { readonly then?: unknown }).then === 'function';
}

function freezeProviderPaths(paths: unknown): readonly string[] | undefined {
  if (!Array.isArray(paths)) return undefined;
  const snapshot = [...paths];
  for (const path of snapshot) {
    if (typeof path !== 'string') return undefined;
  }
  return Object.freeze(snapshot);
}

export function createFileDecorationService(): FileDecorationService {
  const listeners = new Set<FileDecorationChangeListener>();
  const providerSubscriptions = new Map<string, ProviderSubscription>();
  let disposed = false;

  function entryKey(entry: DecorationEntry): string {
    return entry.point + '\u0000' + entry.id;
  }

  function emit(event: FileDecorationChangeEvent): void {
    if (disposed) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (error) {
        reportDecorationError(
          'listener',
          { id: 'providerId' in event ? event.providerId : undefined },
          error
        );
      }
    }
  }

  function providerEvent(
    entry: DecorationEntry,
    paths: unknown,
    reason: 'provider' | 'registry'
  ): void {
    const lane = decorationLaneForContributionPoint(entry.point);
    if (!lane) return;
    const event = reason === 'provider'
      ? Object.freeze({
          lane,
          paths: freezeProviderPaths(paths),
          reason: 'provider' as const,
          providerId: entry.id
        })
      : Object.freeze({
          lane,
          paths: undefined,
          reason: 'registry' as const,
          providerId: entry.id
        });
    emit(event);
  }

  function unsubscribeProvider(
    entry: DecorationEntry,
    expected?: ProviderSubscription
  ): void {
    const key = entryKey(entry);
    const subscription = providerSubscriptions.get(key);
    if (expected && subscription !== expected) return;
    providerSubscriptions.delete(key);
    if (!subscription) return;
    subscription.active = false;
    const disposable = subscription.disposable;
    subscription.disposable = null;
    if (!disposable) return;
    try {
      disposable.dispose();
    } catch (error) {
      reportDecorationError('unsubscribe', entry, error);
    }
  }

  function subscribeProvider(entry: DecorationEntry): void {
    if (disposed) return;
    const provider: FileDecorationProvider = entry.contribution;
    if (typeof provider.onDidChange !== 'function') return;
    const key = entryKey(entry);
    const subscription: ProviderSubscription = {
      active: true,
      disposable: null,
      owner: entry.owner,
      contribution: provider
    };
    providerSubscriptions.set(key, subscription);
    try {
      const disposable = provider.onDidChange((paths) => {
        if (
          disposed ||
          !subscription.active ||
          providerSubscriptions.get(key) !== subscription
        ) return;
        providerEvent(entry, paths, 'provider');
      });
      if (disposable && typeof disposable.dispose === 'function') {
        if (subscription.active && providerSubscriptions.get(key) === subscription) {
          subscription.disposable = disposable;
        } else {
          try {
            disposable.dispose();
          } catch (error) {
            reportDecorationError('unsubscribe', entry, error);
          }
        }
      } else if (disposable != null) {
        throw new TypeError('File decoration provider onDidChange must return a disposable.');
      }
    } catch (error) {
      if (providerSubscriptions.get(key) === subscription) {
        providerSubscriptions.delete(key);
      }
      subscription.active = false;
      reportDecorationError('subscribe', entry, error);
    }
  }

  function currentEntry(entry: DecorationEntry): DecorationEntry | null {
    return rendererPlatform.contributions
      .listEntries(entry.point)
      .find((candidate) => candidate.id === entry.id) || null;
  }

  function reconcileProvider(entry: DecorationEntry): void {
    if (disposed) return;
    const key = entryKey(entry);
    const subscription = providerSubscriptions.get(key);
    const current = currentEntry(entry);
    if (!current) {
      if (subscription) unsubscribeProvider(entry, subscription);
      return;
    }
    if (
      subscription?.active &&
      subscription.owner === current.owner &&
      subscription.contribution === current.contribution
    ) return;
    if (subscription) {
      unsubscribeProvider(current, subscription);
      // Provider disposal is arbitrary synchronous code. It may replace the
      // contribution and install a new token, so never reuse `current` here.
      reconcileProvider(entry);
      return;
    }
    subscribeProvider(current);
  }

  function onRegistryChange(event: ContributionChangeEventFor<RendererContributionMap>): void {
    if (disposed || !decorationLaneForContributionPoint(event.point)) return;
    const decorationEvent = event as DecorationChange;
    reconcileProvider(decorationEvent);
    if (!disposed) providerEvent(decorationEvent, undefined, 'registry');
  }

  const registrySubscription = rendererPlatform.contributions.onDidChange(onRegistryChange);
  const languageChangeListener = (): void => {
    // Decoration providers return localized tooltip text lazily. Request a
    // lane redraw without exposing locale or DOM authority to installed code.
    for (const lane of FILE_DECORATION_LANES) {
      emit(Object.freeze({ lane, reason: 'language' as const }));
    }
  };
  if (window && typeof window.addEventListener === 'function') {
    window.addEventListener('bobo:language-changed', languageChangeListener);
  }
  for (const lane of FILE_DECORATION_LANES) {
    const point = contributionPointForDecorationLane(lane);
    for (const entry of rendererPlatform.contributions.listEntries(point)) {
      reconcileProvider(entry);
    }
  }

  function get(
    lane: Parameters<FileDecorationService['get']>[0],
    resourcePath: string,
    node: unknown
  ): ReturnType<FileDecorationService['get']> {
    const point = contributionPointForDecorationLane(lane);
    const entries = rendererPlatform.contributions.listEntries(point);
    if (entries.length > 1) {
      entries.sort((left, right) => {
        const priorityDifference =
          (right.contribution.priority || 0) - (left.contribution.priority || 0);
        return priorityDifference || left.id.localeCompare(right.id);
      });
    }
    for (const entry of entries) {
      try {
        const value: unknown = entry.contribution.getDecoration(resourcePath, node);
        if (isThenable(value)) {
          Promise.resolve(value).catch(() => {});
          throw new TypeError('File decoration providers must return synchronously.');
        }
        const decoration = normalizeFileDecoration(value);
        if (decoration) return decoration;
      } catch (error) {
        reportDecorationError('get', entry, error);
      }
    }
    return null;
  }

  function onDidChange(listener: FileDecorationChangeListener): Disposable {
    if (typeof listener !== 'function') {
      throw new TypeError('File decoration listener must be a function.');
    }
    listeners.add(listener);
    return toDisposable(() => listeners.delete(listener));
  }

  return Object.freeze({
    get,
    onDidChange,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      registrySubscription.dispose();
      if (window && typeof window.removeEventListener === 'function') {
        window.removeEventListener('bobo:language-changed', languageChangeListener);
      }
      const subscriptions = Array.from(providerSubscriptions.values()).reverse();
      providerSubscriptions.clear();
      for (const subscription of subscriptions) {
        subscription.active = false;
        const disposable = subscription.disposable;
        subscription.disposable = null;
        if (!disposable) continue;
        try {
          disposable.dispose();
        } catch (error) {
          reportDecorationError('unsubscribe', null, error);
        }
      }
      listeners.clear();
    }
  });
}

export const fileDecorationService = createFileDecorationService();

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  FILE_DECORATIONS_SERVICE_ID,
  fileDecorationService,
  {
    owner: 'core.file-decorations',
    exposeToPlugins: false
  }
));
