import type { Disposable } from '../../types/lifecycle';
import { toDisposable } from './disposable.js';

/** Erased command boundary used by runtime-installed plugins and legacy adapters. */
export type DynamicCommandHandler = (...args: any[]) => unknown;

export interface CommandRegistryErrorEvent {
  readonly source: 'command';
  readonly id: string;
  readonly owner: string;
  readonly error: unknown;
}

export interface CommandRegistryOptions {
  readonly onError?: (event: CommandRegistryErrorEvent) => void;
}

export interface CommandRegistrationMetadata {
  readonly owner?: string;
  readonly title?: string;
  readonly category?: string;
  readonly permissions?: readonly string[];
}

export interface CommandDescription {
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  readonly category: string;
  readonly permissions: readonly string[];
}

export interface CommandExecutionSuccess<Value> {
  readonly ok: true;
  readonly value: Value;
}

export interface CommandExecutionFailure {
  readonly ok: false;
  readonly error: unknown;
}

export type CommandExecutionResult<Value> =
  | CommandExecutionSuccess<Value>
  | CommandExecutionFailure;

type CommandId<Commands extends object> = Extract<keyof Commands, string>;
type CommandMapConstraint<Commands extends object> = {
  readonly [Id in keyof Commands]-?: DynamicCommandHandler;
};
type StrictCommandFor<Commands extends object, Id extends CommandId<Commands>> =
  Commands[Id] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result
    : never;
type IsUnion<Value, Whole = Value> =
  Value extends unknown ? ([Whole] extends [Value] ? false : true) : never;
type SingleCommandId<Id extends string> =
  string extends Id ? Id : true extends IsUnion<Id> ? never : Id;

interface CommandRecord {
  readonly id: string;
  readonly owner: string;
  readonly handler: DynamicCommandHandler;
  readonly title: string;
  readonly category: string;
  readonly permissions: readonly string[];
}

function requireId(id: unknown, label: string): string {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError(label + ' must be a non-empty string.');
  }
  return id.trim();
}

export class CommandRegistry<
  Commands extends CommandMapConstraint<Commands> = Record<string, DynamicCommandHandler>
> {
  private readonly _records = new Map<string, CommandRecord>();
  private readonly _onError: (event: CommandRegistryErrorEvent) => void;
  private _disposed = false;

  constructor(options: CommandRegistryOptions = {}) {
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
  }

  register<Id extends CommandId<Commands>>(
    id: Id & SingleCommandId<Id>,
    handler: StrictCommandFor<Commands, NoInfer<Id>>,
    metadata: CommandRegistrationMetadata = {}
  ): Disposable {
    if (this._disposed) throw new Error('CommandRegistry has been disposed.');
    const commandId = requireId(id, 'Command id');
    const owner = requireId(metadata.owner || 'core', 'Command owner');
    if (typeof handler !== 'function') {
      throw new TypeError('Command "' + commandId + '" requires a handler.');
    }
    if (this._records.has(commandId)) {
      throw new Error('Command already registered: ' + commandId);
    }

    const record: CommandRecord = {
      id: commandId,
      owner,
      handler,
      title: typeof metadata.title === 'string' ? metadata.title : commandId,
      category: typeof metadata.category === 'string' ? metadata.category : '',
      permissions: Object.freeze(Array.isArray(metadata.permissions) ? [...metadata.permissions] : [])
    };
    this._records.set(commandId, record);
    return toDisposable(() => {
      if (this._records.get(commandId) === record) this._records.delete(commandId);
    }) as Disposable;
  }

  has(id: string): boolean {
    return this._records.has(id);
  }

  async execute<Id extends CommandId<Commands>>(
    id: Id & SingleCommandId<Id>,
    ...args: Parameters<StrictCommandFor<Commands, NoInfer<Id>>>
  ): Promise<Awaited<ReturnType<StrictCommandFor<Commands, Id>>>> {
    const record = this._records.get(id);
    if (!record) throw new Error('Unknown command: ' + id);
    try {
      return await record.handler(...args) as Awaited<ReturnType<StrictCommandFor<Commands, Id>>>;
    } catch (error) {
      try {
        this._onError({ source: 'command', id: record.id, owner: record.owner, error });
      } catch (_) {
        // Error observers cannot replace the command failure reported to the caller.
      }
      throw error;
    }
  }

  async executeIsolated<Id extends CommandId<Commands>>(
    id: Id & SingleCommandId<Id>,
    ...args: Parameters<StrictCommandFor<Commands, NoInfer<Id>>>
  ): Promise<CommandExecutionResult<Awaited<ReturnType<StrictCommandFor<Commands, Id>>>>> {
    try {
      return { ok: true, value: await this.execute<Id>(id, ...args) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  describe(): readonly CommandDescription[] {
    return Array.from(this._records.values(), (record) => Object.freeze({
      id: record.id,
      owner: record.owner,
      title: record.title,
      category: record.category,
      permissions: record.permissions
    }));
  }

  disposeOwner(owner: string): void {
    for (const [id, record] of this._records) {
      if (record.owner === owner) this._records.delete(id);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._records.clear();
  }
}
