import type { Disposable } from '../../types/lifecycle';
import type {
  DocumentViewDescriptorDto,
  DocumentViewDescriptorRegistrationDto,
  SourceControlDescriptorDto,
  SourceControlDescriptorRegistrationDto
} from '../../types/contributions';
import { toDisposable } from './disposable.js';
import { validateDocumentViewDescriptor } from './document-view.js';
import { validateFileDecorationProvider } from './file-decoration';
import { validateSourceControlDescriptor } from './source-control.js';

export const ContributionPoint = Object.freeze({
  MENUS: 'menus',
  FILE_DECORATIONS_SYNC: 'fileDecorations.sync',
  FILE_DECORATIONS_SCM: 'fileDecorations.scm',
  FILE_DECORATIONS_DIAGNOSTIC: 'fileDecorations.diagnostic',
  TASKS: 'tasks',
  DEBUG_CONFIGURATION_PROVIDERS: 'debug.configurationProviders',
  SETTINGS: 'settings',
  LANGUAGES: 'languages',
  AI_TOOLS: 'ai.tools',
  MCP_PROVIDERS: 'mcp.providers',
  SKILL_PROVIDERS: 'skills.providers',
  AGENTS: 'agents',
  // This is a data-only descriptor for a future trusted SCM sidebar. It is
  // intentionally distinct from file-decoration SCM state and from generic
  // webview-style contributions.
  SOURCE_CONTROL: 'sourceControl',
  DOCUMENT_VIEWS: 'documentViews'
} as const);

export type ContributionPointId = typeof ContributionPoint[keyof typeof ContributionPoint];

/** Erased callback boundary used by legacy and runtime-installed contributions. */
export type DynamicContributionMethod = (...args: any[]) => unknown;

export interface ContributionRegistrationOptions {
  readonly id?: string;
  readonly owner?: string;
}

export interface ContributionEntry<
  Point extends string = string,
  Contribution extends object = object
> {
  readonly point: Point;
  readonly id: string;
  readonly owner: string;
  readonly contribution: Contribution;
}

export interface ContributionDescription<Point extends string = string> {
  readonly point: Point;
  readonly id: string;
  readonly owner: string;
}

export type ContributionChangeType = 'added' | 'removed';

export interface ContributionChangeEvent<
  Point extends string = string,
  Contribution extends object = object
> extends ContributionEntry<Point, Contribution> {
  readonly type: ContributionChangeType;
}

export interface ContributionCollectionError {
  readonly id: string;
  readonly owner: string;
  readonly error: unknown;
}

export interface ContributionCollectionResult<Value> {
  readonly values: Value[];
  readonly errors: ContributionCollectionError[];
}

export interface ContributionRegistryErrorEvent<Point extends string = string> {
  readonly source: 'contribution' | 'contribution-listener';
  readonly point: Point;
  readonly id: string;
  readonly owner: string;
  readonly error: unknown;
}

export interface ContributionRegistryOptions<Point extends string = string> {
  readonly onError?: (event: ContributionRegistryErrorEvent<Point>) => void;
}

type ContributionValueConstraint<Value> =
  [Extract<Value, DynamicContributionMethod>] extends [never]
    ? Value extends object ? object : never
    : never;

type NormalizedContributionValueConstraint<Point, Value> =
  Point extends typeof ContributionPoint.SOURCE_CONTROL
    ? [Value] extends [SourceControlDescriptorDto]
      ? [SourceControlDescriptorDto] extends [Value] ? object : never
      : never
    : Point extends typeof ContributionPoint.DOCUMENT_VIEWS
      ? [Value] extends [DocumentViewDescriptorDto]
        ? [DocumentViewDescriptorDto] extends [Value] ? object : never
        : never
      : ContributionValueConstraint<Value>;

type ContributionMapConstraint<Contributions extends object> = {
  readonly [Point in keyof Contributions]-?:
    NormalizedContributionValueConstraint<Point, Contributions[Point]>;
};

type ContributionPointFor<Contributions extends object> = Extract<keyof Contributions, string>;
type ContributionFor<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = Extract<Contributions[Point], object>;

type RegistrationContributionFor<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = Point extends typeof ContributionPoint.SOURCE_CONTROL
  ? ContributionFor<Contributions, Point> extends SourceControlDescriptorDto
    ? SourceControlDescriptorRegistrationDto
    : ContributionFor<Contributions, Point>
  : Point extends typeof ContributionPoint.DOCUMENT_VIEWS
    ? ContributionFor<Contributions, Point> extends DocumentViewDescriptorDto
      ? DocumentViewDescriptorRegistrationDto
      : ContributionFor<Contributions, Point>
    : ContributionFor<Contributions, Point>;

export type ContributionRegistrationMapFor<Contributions extends object> = {
  readonly [Point in keyof Contributions]: Point extends ContributionPointFor<Contributions>
    ? RegistrationContributionFor<Contributions, Point>
    : Contributions[Point];
};

type StrictMethod<Method> =
  Extract<Method, DynamicContributionMethod> extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : never;

type StrictMember<Value> =
  [Extract<Value, DynamicContributionMethod>] extends [never]
    ? Value
    : Exclude<Value, DynamicContributionMethod> | StrictMethod<Value>;

type StrictContribution<Contribution extends object> = {
  [Key in keyof Contribution]: StrictMember<Contribution[Key]>;
};

type InlineIdentifiedContribution<Contribution extends object> =
  StrictContribution<Contribution> & { readonly id: string };

type UsesOpenRegistration<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = string extends Point
  ? true
  : keyof RegistrationContributionFor<Contributions, Point> extends never ? true : false;

type ClosedRegistrationPoint<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = true extends UsesOpenRegistration<Contributions, Point> ? never : unknown;

type OpenRegistrationPoint<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = true extends UsesOpenRegistration<Contributions, Point> ? unknown : never;

type NonCallableContribution<Contribution extends object> =
  Contribution extends DynamicContributionMethod ? never : Contribution;

type UsesDynamicCollection<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = string extends Point
  ? true
  : string extends ContributionPointFor<Contributions>
    ? keyof ContributionFor<Contributions, Point> extends never ? true : false
    : false;

type CallableKey<Contribution extends object> = Extract<{
  [Key in keyof Contribution]-?:
    [Extract<Contribution[Key], DynamicContributionMethod>] extends [never] ? never : Key;
}[keyof Contribution], string>;

type IsUnion<Value, Whole = Value> =
  Value extends unknown ? ([Whole] extends [Value] ? false : true) : never;

type SingleStringId<Id extends string> =
  string extends Id ? Id : true extends IsUnion<Id> ? never : Id;

type ContributionMethodId<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>
> = true extends UsesDynamicCollection<Contributions, Point>
  ? string
  : CallableKey<ContributionFor<Contributions, Point>>;

type ContributionMethodValue<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>,
  Method extends string
> = Method extends keyof ContributionFor<Contributions, Point>
  ? ContributionFor<Contributions, Point>[Method]
  : never;

type ContributionMethodFor<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions>,
  Method extends string
> = true extends UsesDynamicCollection<Contributions, Point>
  ? DynamicContributionMethod
  : StrictMethod<ContributionMethodValue<Contributions, Point, Method>>;

export type ContributionEntryFor<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions> = ContributionPointFor<Contributions>
> = Point extends ContributionPointFor<Contributions>
  ? ContributionEntry<Point, ContributionFor<Contributions, Point>>
  : never;

export type ContributionDescriptionFor<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions> = ContributionPointFor<Contributions>
> = Point extends ContributionPointFor<Contributions>
  ? ContributionDescription<Point>
  : never;

export type ContributionChangeEventFor<
  Contributions extends object,
  Point extends ContributionPointFor<Contributions> = ContributionPointFor<Contributions>
> = Point extends ContributionPointFor<Contributions>
  ? ContributionChangeEvent<Point, ContributionFor<Contributions, Point>>
  : never;

interface ContributionRecord {
  readonly point: string;
  readonly id: string;
  readonly owner: string;
  readonly contribution: object;
}

function requireId(id: unknown, label: string): string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError(label + ' must be a non-empty string.');
  }
  return id.trim();
}

export class ContributionRegistry<
  Contributions extends ContributionMapConstraint<Contributions> = Record<string, object>
> implements Disposable {
  declare private readonly _contributionMapBrand: (value: Contributions) => Contributions;
  private readonly _records = new Set<ContributionRecord>();
  private readonly _recordsByPoint = new Map<string, Map<string, ContributionRecord>>();
  private readonly _listeners = new Set<(event: ContributionChangeEvent) => void>();
  private readonly _onError: (event: ContributionRegistryErrorEvent) => void;
  private _disposed = false;

  constructor(options: ContributionRegistryOptions<ContributionPointFor<Contributions>> = {}) {
    this._onError = typeof options.onError === 'function'
      ? options.onError as (event: ContributionRegistryErrorEvent) => void
      : () => {};
  }

  register<Point extends ContributionPointFor<Contributions>>(
    point: Point & SingleStringId<Point> & ClosedRegistrationPoint<Contributions, Point>,
    contribution: InlineIdentifiedContribution<
      RegistrationContributionFor<Contributions, NoInfer<Point>>
    >,
    options?: ContributionRegistrationOptions
  ): Disposable;
  register<Point extends ContributionPointFor<Contributions>>(
    point: Point & SingleStringId<Point> & ClosedRegistrationPoint<Contributions, Point>,
    contribution: StrictContribution<
      RegistrationContributionFor<Contributions, NoInfer<Point>>
    >,
    options: ContributionRegistrationOptions & { readonly id: string }
  ): Disposable;
  register<
    Point extends ContributionPointFor<Contributions>,
    Contribution extends object
  >(
    point: Point & SingleStringId<Point> & OpenRegistrationPoint<Contributions, Point>,
    contribution: NonCallableContribution<Contribution> & { readonly id: string },
    options?: ContributionRegistrationOptions
  ): Disposable;
  register<
    Point extends ContributionPointFor<Contributions>,
    Contribution extends object
  >(
    point: Point & SingleStringId<Point> & OpenRegistrationPoint<Contributions, Point>,
    contribution: NonCallableContribution<Contribution>,
    options: ContributionRegistrationOptions & { readonly id: string }
  ): Disposable;
  register(
    point: string,
    contribution: object,
    options: ContributionRegistrationOptions = {}
  ): Disposable {
    return this._register(point, contribution, options);
  }

  /** Runtime boundary for contribution points supplied by a validated plugin descriptor. */
  registerDynamic(
    point: string,
    contribution: object,
    options: ContributionRegistrationOptions = {}
  ): Disposable {
    return this._register(point, contribution, options);
  }

  private _register(
    point: string,
    contribution: object,
    options: ContributionRegistrationOptions
  ): Disposable {
    if (this._disposed) throw new Error('ContributionRegistry has been disposed.');
    const contributionPoint = requireId(point, 'Contribution point');
    const owner = requireId(options.owner || 'core', 'Contribution owner');
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('Contribution at "' + contributionPoint + '" must be an object.');
    }

    let normalizedContribution = contribution as object;
    if (contributionPoint.startsWith('fileDecorations.')) {
      normalizedContribution = validateFileDecorationProvider(normalizedContribution, contributionPoint);
    } else if (contributionPoint === ContributionPoint.SOURCE_CONTROL) {
      normalizedContribution = validateSourceControlDescriptor(normalizedContribution);
    } else if (contributionPoint === ContributionPoint.DOCUMENT_VIEWS) {
      normalizedContribution = validateDocumentViewDescriptor(normalizedContribution, owner);
    }

    const normalizedId = (normalizedContribution as { readonly id?: unknown }).id;
    const id = requireId(options.id || normalizedId, 'Contribution id');
    if (
      contributionPoint === ContributionPoint.SOURCE_CONTROL &&
      normalizedId !== id
    ) {
      throw new TypeError('Source-control descriptor id must match the contribution id.');
    }

    let pointRecords = this._recordsByPoint.get(contributionPoint);
    if (pointRecords?.has(id)) {
      throw new Error('Contribution already registered: ' + contributionPoint + '/' + id);
    }
    if (!pointRecords) {
      pointRecords = new Map<string, ContributionRecord>();
      this._recordsByPoint.set(contributionPoint, pointRecords);
    }

    const record: ContributionRecord = {
      point: contributionPoint,
      id,
      owner,
      contribution: normalizedContribution
    };
    this._records.add(record);
    pointRecords.set(id, record);
    this._emitChange('added', record);
    return toDisposable(() => this._removeRecord(record)) as Disposable;
  }

  list<Point extends ContributionPointFor<Contributions>>(
    point: Point
  ): Array<ContributionFor<Contributions, Point>> {
    const records = this._recordsByPoint.get(point);
    if (!records) return [];
    return Array.from(
      records.values(),
      record => record.contribution as ContributionFor<Contributions, Point>
    );
  }

  listEntries(): Array<ContributionEntryFor<Contributions>>;
  listEntries<Point extends ContributionPointFor<Contributions>>(
    point: Point
  ): Array<ContributionEntryFor<Contributions, Point>>;
  listEntries(point?: ContributionPointFor<Contributions>): ContributionEntry[] {
    const records = point ? this._recordsByPoint.get(point)?.values() : this._records.values();
    if (!records) return [];
    return Array.from(records, record => Object.freeze({
      point: record.point,
      id: record.id,
      owner: record.owner,
      contribution: record.contribution
    }));
  }

  describe(): Array<ContributionDescriptionFor<Contributions>>;
  describe<Point extends ContributionPointFor<Contributions>>(
    point: Point
  ): Array<ContributionDescriptionFor<Contributions, Point>>;
  describe(point?: ContributionPointFor<Contributions>): ContributionDescription[] {
    const records = point ? this._recordsByPoint.get(point)?.values() : this._records.values();
    if (!records) return [];
    return Array.from(records, record => Object.freeze({
      point: record.point,
      id: record.id,
      owner: record.owner
    }));
  }

  async collect<
    Point extends ContributionPointFor<Contributions>,
    Method extends ContributionMethodId<Contributions, NoInfer<Point>>
  >(
    point: Point & SingleStringId<Point>,
    method: Method & SingleStringId<Method>,
    ...args: Parameters<ContributionMethodFor<Contributions, NoInfer<Point>, NoInfer<Method>>>
  ): Promise<ContributionCollectionResult<
    Awaited<ReturnType<ContributionMethodFor<Contributions, Point, Method>>>
  >>;
  async collect(
    point: string,
    method: string,
    ...args: any[]
  ): Promise<ContributionCollectionResult<unknown>> {
    const values: unknown[] = [];
    const errors: ContributionCollectionError[] = [];
    const records = Array.from(this._recordsByPoint.get(point)?.values() || []);
    for (const record of records) {
      try {
        const handler = (record.contribution as Record<string, unknown>)[method];
        if (typeof handler !== 'function') continue;
        values.push(await handler.apply(record.contribution, args));
      } catch (error) {
        errors.push({ id: record.id, owner: record.owner, error });
        this._reportError({
          source: 'contribution',
          point,
          id: record.id,
          owner: record.owner,
          error
        });
      }
    }
    return { values, errors };
  }

  onDidChange(listener: (event: ContributionChangeEventFor<Contributions>) => void): Disposable {
    if (this._disposed) throw new Error('ContributionRegistry has been disposed.');
    if (typeof listener !== 'function') {
      throw new TypeError('Contribution change listener must be a function.');
    }
    const runtimeListener = listener as (event: ContributionChangeEvent) => void;
    this._listeners.add(runtimeListener);
    return toDisposable(() => this._listeners.delete(runtimeListener)) as Disposable;
  }

  disposeOwner(owner: string): void {
    for (const record of this._records) {
      if (record.owner === owner) this._removeRecord(record);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const records = Array.from(this._records).reverse();
    for (const record of records) this._removeRecord(record);
    this._listeners.clear();
  }

  private _removeRecord(record: ContributionRecord): void {
    const pointRecords = this._recordsByPoint.get(record.point);
    if (pointRecords?.get(record.id) !== record) return;
    pointRecords.delete(record.id);
    if (pointRecords.size === 0) this._recordsByPoint.delete(record.point);
    this._records.delete(record);
    this._emitChange('removed', record);
  }

  private _emitChange(type: ContributionChangeType, record: ContributionRecord): void {
    if (this._listeners.size === 0) return;
    const event = Object.freeze({
      type,
      point: record.point,
      id: record.id,
      owner: record.owner,
      contribution: record.contribution
    });
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(event);
      } catch (error) {
        this._reportError({
          source: 'contribution-listener',
          point: record.point,
          id: record.id,
          owner: record.owner,
          error
        });
      }
    }
  }

  private _reportError(event: ContributionRegistryErrorEvent): void {
    try {
      this._onError(event);
    } catch (_) {
      // Error observers cannot interrupt registry state changes or collection.
    }
  }
}
