import type {
  CloudFeatureDecision,
  CloudFeatureEvaluationOptions,
  CloudFeatureName,
  CloudFeaturePolicyDependencies,
  CloudFeaturePolicyService,
  ServerCapabilitySnapshot
} from '../types/server-runtime';

export const KNOWN_CLOUD_FEATURES: readonly CloudFeatureName[] = Object.freeze([
  'run',
  'tasks',
  'terminal',
  'projectEnvironment',
  'collaboration',
  'lsp',
  'dap'
]);

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isKnownFeature(value: string): value is CloudFeatureName {
  return (KNOWN_CLOUD_FEATURES as readonly string[]).includes(value);
}

export function canonicalLanguage(value: unknown): string {
  const language = String(value || '').trim().toLowerCase();
  if (['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'js', 'ts', 'node'].includes(language)) {
    return 'node';
  }
  if (language === 'c++') return 'cpp';
  if (language === 'py') return 'python';
  return language;
}

function decision(
  feature: string,
  available: unknown,
  state: string | undefined,
  reason: string | undefined,
  language: string
): CloudFeatureDecision {
  const result: {
    feature: string;
    available: boolean;
    state: string;
    reason: string;
    language?: string;
  } = {
    feature,
    available: available === true,
    state: state || 'unknown',
    reason: reason || ''
  };
  if (language) result.language = language;
  return result;
}

export function createCloudFeaturePolicy(
  dependencies: CloudFeaturePolicyDependencies
): Readonly<CloudFeaturePolicyService> {
  if (!dependencies || typeof dependencies.getSnapshot !== 'function') {
    throw new TypeError('Cloud feature policy requires getSnapshot().');
  }

  function currentSnapshot(
    options?: CloudFeatureEvaluationOptions | null
  ): ServerCapabilitySnapshot | null | undefined {
    if (options && hasOwn(options, 'snapshot')) return options.snapshot;
    return dependencies.getSnapshot();
  }

  function evaluate(
    feature: unknown,
    options?: CloudFeatureEvaluationOptions | null
  ): CloudFeatureDecision {
    const name = String(feature || '');
    const snapshot = currentSnapshot(options);
    const language = canonicalLanguage(options && options.language);

    if (!isKnownFeature(name)) return decision(name, false, 'unknown', 'unknown_feature', language);
    if (!snapshot) return decision(name, false, 'unknown', 'not_negotiated', language);
    if (snapshot.state === 'legacy') return decision(name, true, 'legacy', '', language);
    if (snapshot.state !== 'compatible' || snapshot.compatible !== true || !snapshot.capabilities) {
      return decision(
        name,
        false,
        snapshot.state || 'incompatible',
        snapshot.reason || 'incompatible_server',
        language
      );
    }

    const capability = snapshot.capabilities[name];
    const enabled = name === 'lsp' || name === 'dap'
      ? capability !== null && typeof capability === 'object' && capability.enabled === true
      : capability === true;
    if (!enabled) return decision(name, false, 'compatible', 'feature_disabled', language);

    if (name === 'lsp' && language) {
      const languages = Array.isArray(snapshot.capabilities.lsp?.languages)
        ? snapshot.capabilities.lsp.languages
        : [];
      const supported = languages.some((item) => canonicalLanguage(item) === language);
      if (!supported) return decision(name, false, 'compatible', 'unsupported_language', language);
    }
    return decision(name, true, 'compatible', '', language);
  }

  function allows(
    feature: unknown,
    options?: CloudFeatureEvaluationOptions | null
  ): boolean {
    return evaluate(feature, options).available;
  }

  function languages(snapshot?: ServerCapabilitySnapshot | null): string[] {
    const current = snapshot === undefined ? currentSnapshot() : snapshot;
    if (!current || current.state !== 'compatible' || !current.capabilities || !current.capabilities.lsp) return [];
    const values = Array.isArray(current.capabilities.lsp.languages) ? current.capabilities.lsp.languages : [];
    return values
      .map((language) => String(language || '').trim().toLowerCase())
      .filter((language, index, values) => Boolean(language) && values.indexOf(language) === index);
  }

  return { evaluate, allows, canonicalLanguage, languages };
}
