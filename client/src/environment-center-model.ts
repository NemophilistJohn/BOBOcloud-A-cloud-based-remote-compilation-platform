import type {
  EnvironmentCenterLocalizationPort,
  EnvironmentCenterMergePorts,
  EnvironmentCenterProblemDto,
  EnvironmentCenterRuntimeDefinitionDto,
  EnvironmentHealthDto,
  EnvironmentIssueStatusDto,
  EnvironmentTreeNodeDto,
  ProjectEnvironmentActivityDto,
  ProjectEnvironmentCheckDto,
  ProjectEnvironmentIssueDto,
  ProjectEnvironmentManifestDto,
  ProjectEnvironmentPackageDto,
  ProjectEnvironmentPackagesDto,
  ProjectEnvironmentSnapshotDto
} from '../types/environment-center';

interface ManifestRule {
  readonly pattern: RegExp;
  readonly kind: string;
  readonly manager: string;
  readonly language: string;
}

const MANIFEST_RULES: readonly ManifestRule[] = [
  { pattern: /(^|\/)requirements(?:[-_.][^/]*)?\.txt$/i, kind: 'requirements', manager: 'pip', language: 'python' },
  { pattern: /(^|\/)pyproject\.toml$/i, kind: 'project', manager: 'python', language: 'python' },
  { pattern: /(^|\/)(Pipfile|Pipfile\.lock|poetry\.lock|pdm\.lock|setup\.py|setup\.cfg)$/i, kind: 'dependency', manager: 'python', language: 'python' },
  { pattern: /(^|\/)environment\.ya?ml$/i, kind: 'environment', manager: 'conda', language: 'python' },
  { pattern: /(^|\/)package\.json$/i, kind: 'manifest', manager: 'npm', language: 'node' },
  { pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i, kind: 'lockfile', manager: 'node', language: 'node' },
  { pattern: /(^|\/)go\.(mod|sum|work)$/i, kind: 'module', manager: 'go', language: 'go' },
  { pattern: /(^|\/)Cargo\.(toml|lock)$/i, kind: 'manifest', manager: 'cargo', language: 'rust' },
  { pattern: /(^|\/)pom\.xml$/i, kind: 'manifest', manager: 'maven', language: 'java' },
  { pattern: /(^|\/)(build|settings)\.gradle(?:\.kts)?$/i, kind: 'manifest', manager: 'gradle', language: 'java' },
  { pattern: /(^|\/)gradle\.(properties|lockfile)$/i, kind: 'config', manager: 'gradle', language: 'java' },
  { pattern: /(^|\/)(CMakeLists\.txt|compile_commands\.json|vcpkg\.json|conanfile\.(?:txt|py)|meson\.build|Makefile)$/i, kind: 'manifest', manager: 'native', language: 'native' }
];

const IGNORED_SEGMENTS: Readonly<Record<string, true>> = Object.freeze({
  '.git': true,
  '.hg': true,
  '.svn': true,
  node_modules: true,
  __pycache__: true,
  '.venv': true,
  venv: true,
  vendor: true,
  target: true,
  dist: true,
  build: true
});

const PYTHON_IMPORT_DISTRIBUTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  bs4: 'beautifulsoup4',
  cv2: 'opencv-python',
  crypto: 'pycryptodome',
  dateutil: 'python-dateutil',
  pil: 'pillow',
  sklearn: 'scikit-learn',
  yaml: 'pyyaml'
});

export function environmentTranslate(
  localization: EnvironmentCenterLocalizationPort | null | undefined,
  source: string,
  replacements?: Readonly<Record<string, unknown>>
): string {
  if (localization && typeof localization.t === 'function') {
    return localization.t(source, replacements);
  }
  return String(source).replace(/\{([^}]+)\}/g, (match, key: string) => (
    replacements && replacements[key] !== undefined ? String(replacements[key]) : match
  ));
}

export function canonicalLanguage(language: unknown): string {
  const value = String(language || '').toLowerCase();
  if (value === 'javascript' || value === 'javascriptreact' || value === 'typescript' || value === 'typescriptreact') return 'node';
  if (value === 'c' || value === 'cpp' || value === 'objective-c') return 'native';
  if (value === 'plaintext' || value === 'text' || value === 'image') return '';
  return value;
}

export function environmentPathName(value: unknown): string {
  const parts = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] || '' : '';
}

function relativePath(root: unknown, fullPath: unknown): string {
  const normalizedRoot = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFull = String(fullPath || '').replace(/\\/g, '/');
  if (!normalizedRoot || normalizedFull.toLowerCase().indexOf((normalizedRoot + '/').toLowerCase()) !== 0) {
    return normalizedFull.replace(/^\/+/, '');
  }
  return normalizedFull.slice(normalizedRoot.length + 1);
}

export function environmentManifestRule(relative: unknown): ManifestRule | null {
  const normalized = String(relative || '').replace(/\\/g, '/');
  for (const rule of MANIFEST_RULES) {
    if (rule.pattern.test(normalized)) return rule;
  }
  return null;
}

function isIgnored(relative: unknown): boolean {
  return String(relative || '').replace(/\\/g, '/').split('/').some((segment) => (
    IGNORED_SEGMENTS[String(segment || '').toLowerCase()] === true
  ));
}

function treeChildren(value: unknown): readonly EnvironmentTreeNodeDto[] {
  if (Array.isArray(value)) return value as readonly EnvironmentTreeNodeDto[];
  if (!value || typeof value !== 'object') return [];
  const node = value as EnvironmentTreeNodeDto;
  if (Array.isArray(node.children)) return node.children;
  if (Array.isArray(node.items)) return node.items;
  return [];
}

export function recognizeManifests(
  tree: unknown,
  workspaceRoot: unknown,
  maxEntries?: unknown
): ProjectEnvironmentManifestDto[] {
  const found: ProjectEnvironmentManifestDto[] = [];
  const seen = Object.create(null) as Record<string, true>;
  let visited = 0;
  const limit = Math.max(100, Math.min(20000, Number(maxEntries || 6000)));

  function visit(nodes: readonly EnvironmentTreeNodeDto[], depth: number): void {
    if (depth > 6 || visited >= limit) return;
    for (const source of nodes) {
      if (visited >= limit) break;
      const node = source || {};
      visited += 1;
      const fullPath = String(node.path || '');
      const relative = relativePath(workspaceRoot, fullPath || node.name || '');
      if (!relative || isIgnored(relative)) continue;
      const rawChildren = node.children || node.items;
      const children = Array.isArray(rawChildren) ? rawChildren : [];
      const isDirectory = node.type === 'directory'
        || node.isDirectory === true
        || Array.isArray(rawChildren);
      if (isDirectory) {
        visit(children, depth + 1);
        continue;
      }
      const rule = environmentManifestRule(relative);
      const key = relative.toLowerCase();
      if (!rule || seen[key]) continue;
      seen[key] = true;
      found.push({
        path: relative.replace(/\\/g, '/'),
        localPath: fullPath || '',
        kind: rule.kind,
        manager: rule.manager,
        language: rule.language,
        lockfile: rule.kind === 'lockfile' || /(?:\.lock|\.sum)$/i.test(relative),
        parsed: false,
        status: 'detected'
      });
    }
  }

  visit(Array.isArray(tree) ? tree as readonly EnvironmentTreeNodeDto[] : treeChildren(tree), 0);
  return found.sort((left, right) => left.path.localeCompare(right.path)).slice(0, 120);
}

export function languageMatchesRuntime(
  language: unknown,
  runtime: EnvironmentCenterRuntimeDefinitionDto | null | undefined
): boolean | null {
  const expected = canonicalLanguage(language);
  if (!expected || !runtime) return null;
  const actual = canonicalLanguage(runtime.language || String(runtime.runtimeId || '').split(':')[0]);
  return expected === actual || (expected === 'native' && (actual === 'c' || actual === 'cpp'));
}

export function normalizeHealth(value: unknown): EnvironmentHealthDto {
  const normalized = String(value || '').toLowerCase();
  if (['ready', 'healthy', 'aligned', 'ok', 'empty'].includes(normalized)) return 'ready';
  if (['warning', 'mixed', 'stale', 'degraded', 'unknown', 'unavailable'].includes(normalized)) return 'warning';
  if (['error', 'missing', 'mismatch', 'failed', 'invalid'].includes(normalized)) return 'error';
  if (['busy', 'loading', 'indexing', 'starting'].includes(normalized)) return 'busy';
  return 'unknown';
}

export function mergeEnvironmentActivity(
  value: ProjectEnvironmentActivityDto | null | undefined,
  localActivity: ProjectEnvironmentActivityDto | null | undefined
): ProjectEnvironmentActivityDto {
  const result: Record<string, string | number> = { ...(value || {}) };
  const local = localActivity || {};
  const keys = ['lastIndexedAt', 'lastInstalledAt', 'lastCompiledAt', 'lastRepairAt', 'lastRebuildAt'] as const;
  for (const key of keys) {
    const remoteTime = Date.parse(String(result[key] || '')) || Number(result[key] || 0) || 0;
    const localTime = Number(local[key] || 0) || 0;
    const latest = Math.max(remoteTime, localTime);
    if (latest > 0) result[key] = new Date(latest).toISOString();
  }
  return result;
}

export function environmentHealthValue(value: unknown): ProjectEnvironmentCheckDto {
  if (value && typeof value === 'object') {
    const source = value as { readonly status?: unknown; readonly detail?: unknown; readonly reason?: unknown };
    return {
      status: normalizeHealth(source.status),
      detail: String(source.detail || source.reason || '')
    };
  }
  return { status: normalizeHealth(value), detail: '' };
}

export function mergeServerSnapshot(
  local: ProjectEnvironmentSnapshotDto,
  remoteValue: unknown,
  ports: EnvironmentCenterMergePorts = {}
): ProjectEnvironmentSnapshotDto {
  const remote = remoteValue && typeof remoteValue === 'object'
    ? remoteValue as Partial<ProjectEnvironmentSnapshotDto>
    : {};
  const consistency = { ...local.consistency, ...(remote.consistency || {}) };
  consistency.lspDependencies = local.consistency.lspDependencies;
  const localLsp = environmentHealthValue(local.consistency.lspDependencies).status;
  const remoteOverall = normalizeHealth(consistency.status);
  if (localLsp === 'error') consistency.status = 'error';
  else if (localLsp === 'busy' && remoteOverall !== 'error') consistency.status = 'busy';
  else if (localLsp === 'warning' && remoteOverall === 'ready') consistency.status = 'warning';

  const actions = { ...local.actions, ...(remote.actions || {}) };
  if (actions.refreshIndex && ports.lspStatus?.state !== 'ready') {
    actions.refreshIndex = {
      ...actions.refreshIndex,
      supported: false,
      reason: environmentTranslate(ports.localization, 'Remote analysis is not ready')
    };
  }

  return {
    ...local,
    ...remote,
    workspace: { ...local.workspace, ...(remote.workspace || {}) },
    language: { ...local.language, ...(remote.language || {}) },
    runtime: { ...local.runtime, ...(remote.runtime || {}) },
    packages: { ...local.packages, ...(remote.packages || {}) },
    dependencyCache: { ...local.dependencyCache, ...(remote.dependencyCache || {}) },
    consistency,
    actions,
    manifests: Array.isArray(remote.manifests) && remote.manifests.length ? remote.manifests : local.manifests,
    activity: mergeEnvironmentActivity(remote.activity, ports.localActivity),
    source: remote.schema === 'project-environment/v1' ? 'cloud' : local.source,
    schema: 'project-environment/v1'
  };
}

export function unresolvedPythonImport(problem: EnvironmentCenterProblemDto | null | undefined): string {
  if (!problem || !['error', 'warning'].includes(String(problem.severity || '').toLowerCase())) return '';
  const message = String(problem.message || '');
  const code = String(problem.code || '').toLowerCase();
  const match = message.match(/\bImport\s+["']([^"']+)["']\s+could not be resolved\b/i);
  if (!match && code !== 'reportmissingimports') return '';
  const imported = match ? String(match[1] || '').trim() : '';
  if (!imported || imported.charAt(0) === '.') return '';
  return imported.split('.')[0]?.trim() || '';
}

export function packageIdentity(name: unknown, language: unknown): string {
  let value = String(name || '').trim().toLowerCase();
  if (!value) return '';
  if (canonicalLanguage(language) !== 'python') return value;
  value = value.replace(/[-_.]+/g, '-');
  return PYTHON_IMPORT_DISTRIBUTION_ALIASES[value] || value;
}

export function dependencyIssueRows(
  packagesValue: Partial<ProjectEnvironmentPackagesDto> | null | undefined,
  language: unknown
): ProjectEnvironmentIssueDto[] {
  const packages = packagesValue || {};
  const rows: ProjectEnvironmentIssueDto[] = [];
  const rowIndexes = Object.create(null) as Record<string, number>;

  function append(values: readonly ProjectEnvironmentPackageDto[] | undefined, status: EnvironmentIssueStatusDto): void {
    for (const source of Array.isArray(values) ? values : []) {
      const item = source && typeof source === 'object' ? source : { name: '' };
      const key = packageIdentity(item.name, language);
      if (!key) continue;
      if (rowIndexes[key] !== undefined) {
        const existing = rows[rowIndexes[key]];
        if (!existing) continue;
        const merged: ProjectEnvironmentIssueDto = {
          ...existing,
          constraint: existing.constraint || item.constraint,
          reason: existing.reason || item.reason,
          source: existing.source || item.source
        };
        rows[rowIndexes[key]] = merged;
        continue;
      }
      rowIndexes[key] = rows.length;
      rows.push({ ...item, _status: status });
    }
  }

  append(packages.missing, 'missing');
  append(packages.unknown, 'warning');
  return rows;
}

export function mergeLiveDependencyDiagnostics(
  value: ProjectEnvironmentSnapshotDto | null | undefined,
  problems: readonly EnvironmentCenterProblemDto[] | null | undefined,
  localization?: EnvironmentCenterLocalizationPort | null
): ProjectEnvironmentSnapshotDto | null | undefined {
  if (!value || canonicalLanguage(value.language?.id) !== 'python') return value;
  const names: string[] = [];
  const seen = Object.create(null) as Record<string, true>;
  for (const problem of Array.isArray(problems) ? problems : []) {
    const name = unresolvedPythonImport(problem);
    const key = packageIdentity(name, 'python');
    if (!name || seen[key]) continue;
    seen[key] = true;
    names.push(name);
  }
  if (!names.length) return value;

  const packages: ProjectEnvironmentPackagesDto = {
    ...value.packages,
    missing: [...(value.packages.missing || [])]
  };
  const snapshotPackages = Object.create(null) as Record<string, true>;
  for (const items of [packages.declared, packages.installed, packages.missing, packages.unknown]) {
    for (const item of items) {
      const key = packageIdentity(item?.name, 'python');
      if (key) snapshotPackages[key] = true;
    }
  }
  let supplementalCount = 0;
  const missing = [...packages.missing];
  for (const name of names) {
    const key = packageIdentity(name, 'python');
    if (!key || snapshotPackages[key]) continue;
    missing.push({
      name,
      constraint: '',
      source: 'language-service',
      reason: environmentTranslate(localization, 'Import could not be resolved')
    });
    snapshotPackages[key] = true;
    supplementalCount += 1;
  }
  if (!supplementalCount) return value;

  return {
    ...value,
    packages: { ...packages, missing },
    consistency: {
      ...value.consistency,
      status: 'mismatch',
      lspDependencies: {
        status: 'mixed',
        detail: environmentTranslate(
          localization,
          '{count} unresolved dependency imports were reported by the language service.',
          { count: supplementalCount }
        )
      }
    }
  };
}

function activeLocale(localization?: EnvironmentCenterLocalizationPort | null): string {
  return localization && typeof localization.getActive === 'function'
    ? String(localization.getActive() || 'en')
    : 'en';
}

export function localizedDynamicText(
  value: unknown,
  fallback?: string,
  localization?: EnvironmentCenterLocalizationPort | null
): string {
  const raw = String(value || '').trim();
  if (!raw) return fallback || '';
  if (activeLocale(localization).toLowerCase().indexOf('en') === 0 || !/^[\x00-\x7f]*[A-Za-z][\x00-\x7f]*$/.test(raw)) return raw;
  const translated = environmentTranslate(localization, raw);
  return translated !== raw ? translated : (fallback || '');
}

export function healthFallbackDetail(
  id: string,
  status: string,
  fallbackDetail?: string,
  localization?: EnvironmentCenterLocalizationPort | null
): string {
  const keys: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    lsp: {
      ready: 'Language service dependency view is ready.',
      warning: 'Language service reported unresolved dependency imports.',
      error: 'Language service reported unresolved dependency imports.'
    },
    runtime: {
      ready: 'Selected runtime matches the project language.',
      warning: 'Selected runtime does not match the project language.',
      error: 'Selected runtime does not match the project language.'
    },
    dependencies: {
      ready: 'Installed libraries match the project dependency declarations.',
      warning: 'Installed library state still needs verification.',
      error: 'Installed libraries do not match the project dependency declarations.'
    }
  };
  return environmentTranslate(localization, keys[id]?.[status] || fallbackDetail || '');
}

export function localizedDependencyReason(
  item: Partial<ProjectEnvironmentIssueDto> | null | undefined,
  localization?: EnvironmentCenterLocalizationPort | null
): string {
  const source = item || {};
  const raw = String(source.reason || '').trim();
  if (!raw) return source.source || '';
  const fallback = source._status === 'warning'
    ? environmentTranslate(localization, 'Installed library state still needs verification.')
    : environmentTranslate(localization, 'Missing from the verified project environment.');
  return localizedDynamicText(raw, fallback, localization);
}
