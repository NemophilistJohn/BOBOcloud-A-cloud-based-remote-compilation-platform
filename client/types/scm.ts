import type {
  FileDecorationProvider,
  FileDecorationRegistrationDto
} from './file-decoration';
import type { Disposable } from './lifecycle';

export type ScmFileStatusDto =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'ignored';

export interface ScmDecorationEntryRegistrationDto {
  readonly path: string;
  readonly status: ScmFileStatusDto;
}

export interface ScmDecorationEntryDto {
  readonly path: string;
  readonly status: ScmFileStatusDto;
}

export interface ScmDecorationSetResultDto {
  readonly changedPaths: readonly string[];
  readonly entryCount: number;
}

export interface ScmDecorationClearResultDto {
  readonly clearedPaths: readonly string[];
  readonly entryCount: number;
}

export interface ScmFileDecorationProviderOptions {
  readonly id: string;
  readonly namespace: string;
  readonly priority?: number;
  readonly localize?: (key: string) => string;
}

export interface ScmFileDecorationProvider extends FileDecorationProvider<'scm'>, Disposable {
  readonly id: string;
  readonly lane: 'scm';
  getDecoration(path: string, node?: unknown): FileDecorationRegistrationDto | null;
  set(entries: readonly ScmDecorationEntryRegistrationDto[]): ScmDecorationSetResultDto;
  clear(paths?: readonly string[] | null): ScmDecorationClearResultDto;
}

export type ScmGitOperationDto =
  | 'detect'
  | 'status'
  | 'history'
  | 'diff'
  | 'branches'
  | 'remotes'
  | 'clone'
  | 'init'
  | 'setRemote'
  | 'stage'
  | 'stageAll'
  | 'unstage'
  | 'commit'
  | 'checkout'
  | 'createBranch'
  | 'deleteBranch'
  | 'fetch'
  | 'pull'
  | 'push';

export type ScmGitReadOperationDto =
  | 'detect'
  | 'status'
  | 'history'
  | 'diff'
  | 'branches'
  | 'remotes';

export type ScmGitWriteOperationDto = Exclude<ScmGitOperationDto, ScmGitReadOperationDto>;
export type ScmGitPermissionDto = 'scm.git.read' | 'scm.git.write';

interface ScmGitRepositoryArguments {
  readonly repositoryId: string;
}

interface ScmGitPagedArguments extends ScmGitRepositoryArguments {
  readonly offset?: number | null;
  readonly limit?: number | null;
}

export interface ScmGitArgumentsRegistrationMap {
  readonly detect: { readonly includeNested?: boolean };
  readonly status: ScmGitPagedArguments;
  readonly history: ScmGitPagedArguments & { readonly ref?: string | null };
  readonly diff: ScmGitRepositoryArguments & {
    readonly path?: string | null;
    readonly ref?: string | null;
    readonly staged?: boolean;
  };
  readonly branches: ScmGitRepositoryArguments;
  readonly remotes: ScmGitRepositoryArguments;
  readonly clone: { readonly url: string; readonly branch?: string | null };
  readonly init: Readonly<Record<string, never>>;
  readonly setRemote: ScmGitRepositoryArguments & { readonly name?: string | null; readonly url: string };
  readonly stage: ScmGitRepositoryArguments & { readonly paths: readonly string[] };
  readonly stageAll: ScmGitRepositoryArguments;
  readonly unstage: ScmGitRepositoryArguments & { readonly paths: readonly string[] };
  readonly commit: ScmGitRepositoryArguments & { readonly message: string };
  readonly checkout: ScmGitRepositoryArguments & { readonly branch: string; readonly force?: boolean };
  readonly createBranch: ScmGitRepositoryArguments & { readonly name: string; readonly checkout?: boolean };
  readonly deleteBranch: ScmGitRepositoryArguments & { readonly name: string; readonly force?: boolean };
  readonly fetch: ScmGitRepositoryArguments & { readonly remote?: string | null };
  readonly pull: ScmGitRepositoryArguments & {
    readonly remote?: string | null;
    readonly branch?: string | null;
  };
  readonly push: ScmGitRepositoryArguments & {
    readonly remote?: string | null;
    readonly branch?: string | null;
    readonly force?: boolean;
    readonly setUpstream?: boolean;
  };
}

export interface ScmGitArgumentsMap {
  readonly detect: { readonly includeNested?: boolean };
  readonly status: ScmGitRepositoryArguments & { readonly offset?: number; readonly limit?: number };
  readonly history: ScmGitRepositoryArguments & {
    readonly offset?: number;
    readonly limit?: number;
    readonly ref?: string;
  };
  readonly diff: ScmGitRepositoryArguments & {
    readonly path?: string;
    readonly ref?: string;
    readonly staged?: boolean;
  };
  readonly branches: ScmGitRepositoryArguments;
  readonly remotes: ScmGitRepositoryArguments;
  readonly clone: { readonly url: string; readonly branch?: string };
  readonly init: Readonly<Record<string, never>>;
  readonly setRemote: ScmGitRepositoryArguments & { readonly name: string; readonly url: string };
  readonly stage: ScmGitRepositoryArguments & { readonly paths: readonly string[] };
  readonly stageAll: ScmGitRepositoryArguments;
  readonly unstage: ScmGitRepositoryArguments & { readonly paths: readonly string[] };
  readonly commit: ScmGitRepositoryArguments & { readonly message: string };
  readonly checkout: ScmGitRepositoryArguments & { readonly branch: string; readonly force?: boolean };
  readonly createBranch: ScmGitRepositoryArguments & { readonly name: string; readonly checkout?: boolean };
  readonly deleteBranch: ScmGitRepositoryArguments & { readonly name: string; readonly force?: boolean };
  readonly fetch: ScmGitRepositoryArguments & { readonly remote?: string };
  readonly pull: ScmGitRepositoryArguments & { readonly remote?: string; readonly branch?: string };
  readonly push: ScmGitRepositoryArguments & {
    readonly remote?: string;
    readonly branch?: string;
    readonly force?: boolean;
    readonly setUpstream?: boolean;
  };
}

export type ScmGitPermissionFor<Operation extends ScmGitOperationDto> =
  Operation extends ScmGitReadOperationDto ? 'scm.git.read' : 'scm.git.write';

export type ScmGitRequestRegistrationDto<
  Operation extends ScmGitOperationDto = ScmGitOperationDto
> = Operation extends ScmGitOperationDto
  ? Readonly<{
      operation: Operation;
      args: ScmGitArgumentsRegistrationMap[Operation];
    }>
  : never;

export type ScmGitRequestDto<
  Operation extends ScmGitOperationDto = ScmGitOperationDto
> = Operation extends ScmGitOperationDto
  ? Readonly<{
      operation: Operation;
      permission: ScmGitPermissionFor<Operation>;
      args: ScmGitArgumentsMap[Operation];
    }>
  : never;
