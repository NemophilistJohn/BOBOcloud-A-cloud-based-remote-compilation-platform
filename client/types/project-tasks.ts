import type { Disposable } from './lifecycle';

export type ProjectTaskSource = 'vscode' | 'bobocloud';
export type ProjectTaskKind = 'build' | 'test' | 'run' | 'custom';
export type ProjectTaskDependsOrder = 'sequence' | 'parallel';
export type ProjectTaskReveal = 'always' | 'silent' | 'never';
export type ProjectTaskRunOn = 'default' | 'folderOpen';
export type ProjectTaskInputKind = 'promptString' | 'pickString' | 'command';
export type ProjectTaskPromptInputKind = Exclude<ProjectTaskInputKind, 'command'>;

export type ProjectTaskWarningCode =
  | 'TASKS_JSON_PARSE_ERROR'
  | 'TASKS_INVALID_ROOT'
  | 'TASKS_VERSION_UNSUPPORTED'
  | 'TASKS_ARRAY_MISSING'
  | 'TASK_INPUT_DEFINITION_INVALID'
  | 'TASK_INPUT_TYPE_UNSUPPORTED'
  | 'TASK_INPUT_COMMAND_NOT_ALLOWED'
  | 'TASK_INPUT_DUPLICATE'
  | 'TASK_INPUT_CONFLICT'
  | 'TASK_INPUT_UNAVAILABLE'
  | 'TASK_COMMAND_NOT_ALLOWED'
  | 'TASK_CONFIG_NOT_ALLOWED'
  | 'TASK_LABEL_MISSING'
  | 'TASK_TYPE_UNSUPPORTED'
  | 'TASK_BACKGROUND_UNSUPPORTED'
  | 'TASK_DEPENDS_ORDER_UNSUPPORTED'
  | 'TASK_COMMAND_MISSING'
  | 'TASK_PRESENTATION_VALUE_INVALID'
  | 'TASK_PRESENTATION_FIELD_UNSUPPORTED'
  | 'TASK_RUN_ON_MANUAL_ONLY'
  | 'TASK_RUN_OPTION_UNSUPPORTED'
  | 'TASK_PLATFORM_CLOUD_LINUX'
  | 'TASK_LABEL_CONFLICT'
  | 'TASKS_LOAD_FAILED';

export interface ProjectTaskWarningDto {
  readonly code: string;
  readonly message: string;
  readonly source?: ProjectTaskSource;
  readonly path?: string;
  readonly sourcePath?: string;
  readonly overriddenSource?: ProjectTaskSource;
  readonly overriddenSourcePath?: string;
  readonly offset?: number;
  readonly length?: number;
  readonly line?: number;
  readonly column?: number;
  readonly reason?: string;
  readonly version?: string;
  readonly field?: string;
  readonly task?: string;
  readonly taskIndex?: number;
  readonly taskType?: string;
  readonly dependsOrder?: string;
  readonly inputId?: string;
  readonly inputType?: string;
  readonly inputIndex?: number;
  readonly command?: string;
  readonly configKey?: string;
}

export interface ProjectTaskInputOptionDto {
  readonly label: string;
  readonly value: string;
}

/**
 * A catalog input retains unsupported types so the renderer can explain why
 * a task is not executable. Only ProjectTaskInputRequestDto is closed to the
 * two input kinds that the renderer can prompt for.
 */
export interface ProjectTaskInputDefinitionDto {
  readonly id: string;
  readonly type: string;
  readonly description: string;
  readonly default?: string;
  readonly password: boolean;
  readonly options: readonly ProjectTaskInputOptionDto[];
  readonly command: string;
  readonly args: unknown;
  readonly valid: boolean;
  readonly source: ProjectTaskSource;
  readonly sourcePath: string;
}

export interface ProjectTaskPresentationDto {
  readonly reveal: ProjectTaskReveal;
  readonly echo: boolean;
  readonly focus: boolean;
  readonly clear: boolean;
}

export interface ProjectTaskRunOptionsDto {
  readonly reevaluateOnRerun: boolean;
  readonly runOn: ProjectTaskRunOn;
}

/** Catalog entries may retain extension-contributed task types for display. */
export interface ProjectTaskDto {
  readonly id: string;
  readonly label: string;
  readonly type: string;
  readonly kind: ProjectTaskKind;
  readonly command: unknown;
  readonly args: readonly unknown[];
  readonly options: Readonly<Record<string, unknown>>;
  readonly dependsOn: readonly string[];
  readonly dependsOrder: ProjectTaskDependsOrder;
  readonly isDefault: boolean;
  readonly hide: boolean;
  readonly executable: boolean;
  readonly source: ProjectTaskSource;
  readonly sourcePath: string;
  readonly problemMatcher?: unknown;
  readonly presentation: ProjectTaskPresentationDto;
  readonly runOptions: ProjectTaskRunOptionsDto;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly warnings: readonly ProjectTaskWarningDto[];
}

export interface ProjectTaskSourceDto {
  readonly id: ProjectTaskSource;
  readonly path: string;
  readonly raw: unknown;
}

export interface ProjectTaskConfigurationDto {
  readonly version: '2.0.0';
  readonly workspaceRoot: string;
  readonly tasks: readonly ProjectTaskDto[];
  readonly inputs: readonly ProjectTaskInputDefinitionDto[];
  readonly warnings: readonly ProjectTaskWarningDto[];
  readonly sources: readonly ProjectTaskSourceDto[];
}

export interface ProjectTaskEditorContext {
  readonly activeFile?: string;
  readonly languageId?: string;
  readonly selectedText?: string;
  readonly lineNumber?: string | number;
  readonly columnNumber?: string | number;
}

export type ProjectTaskInputValues = Readonly<Record<string, string>>;

export interface ProjectTaskResolveRequestDto {
  readonly label: string;
  readonly context: ProjectTaskEditorContext;
  readonly inputs?: ProjectTaskInputValues;
}

export interface ProjectTaskInputRequestDto {
  readonly id: string;
  readonly type: ProjectTaskPromptInputKind;
  readonly description: string;
  readonly default?: string;
  readonly password: boolean;
  readonly options: readonly ProjectTaskInputOptionDto[];
}

export interface ProjectTaskExecutionStepDto {
  readonly id: string;
  readonly label: string;
  readonly kind: ProjectTaskKind;
  readonly type: 'shell' | 'process';
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly dependsOn: readonly string[];
  readonly echo: boolean;
  readonly displayCommand: string;
}

export interface ProjectTaskExecutionDto {
  readonly schemaVersion: 1;
  readonly label: string;
  readonly kind: ProjectTaskKind;
  readonly steps: readonly ProjectTaskExecutionStepDto[];
  readonly source: ProjectTaskSource;
  readonly problemMatcher?: unknown;
  readonly presentation: ProjectTaskPresentationDto;
  readonly runOptions: ProjectTaskRunOptionsDto;
}

export interface ProjectTaskResolveErrorDto {
  readonly code: string;
  readonly message: string;
}

export interface ProjectTaskResolveSuccessDto {
  readonly success: true;
  readonly execution: ProjectTaskExecutionDto;
}

export interface ProjectTaskResolveInputRequiredDto {
  readonly success: false;
  readonly inputRequired: true;
  readonly inputRequests: readonly ProjectTaskInputRequestDto[];
  readonly error?: ProjectTaskResolveErrorDto;
}

export interface ProjectTaskResolveFailureDto {
  readonly success: false;
  readonly inputRequired?: false;
  readonly inputRequests?: undefined;
  readonly error: ProjectTaskResolveErrorDto;
}

export type ProjectTaskResolveResultDto =
  | ProjectTaskResolveSuccessDto
  | ProjectTaskResolveInputRequiredDto
  | ProjectTaskResolveFailureDto;

export interface ProjectTasksWorkspaceTreeNodeDto {
  readonly name: string;
  readonly path: string;
  readonly type: 'file' | 'folder';
  readonly children?: readonly ProjectTasksWorkspaceTreeNodeDto[];
  readonly truncated?: boolean;
}

export interface ProjectTasksTeamMappingDto {
  readonly version: number;
  readonly teamId: string;
  readonly teamName: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly branch: string;
  readonly localPath: string;
}

export interface ProjectTasksWorkspaceOpenedEvent {
  readonly rootPath: string;
  readonly tree: ProjectTasksWorkspaceTreeNodeDto;
  readonly workspaceIdentity: number;
  readonly leaveToken: string | null;
  readonly teamMapping: ProjectTasksTeamMappingDto | null;
}

export interface ProjectTasksFileEvent {
  readonly event: 'file-created' | 'file-changed' | 'file-deleted';
  readonly path: string;
  readonly rootPath: string;
  readonly workspaceIdentity: number;
  readonly parentPath?: string;
  readonly name?: string;
  readonly nodeType?: 'file' | 'folder';
  readonly mutationId?: string;
}

export type ProjectTasksWorkspaceOpenedListener = (
  event: ProjectTasksWorkspaceOpenedEvent
) => void;

export type ProjectTasksFileEventListener = (event: ProjectTasksFileEvent) => void;

/** Narrow host capability consumed by the Project Tasks workbench controller. */
export interface ProjectTasksHost {
  list(): Promise<ProjectTaskConfigurationDto>;
  resolve(request: ProjectTaskResolveRequestDto): Promise<ProjectTaskResolveResultDto>;
  onWorkspaceOpened(listener: ProjectTasksWorkspaceOpenedListener): Disposable;
  onConfigurationChanged(listener: () => void): Disposable;
}

export type ProjectTaskSelection =
  | { readonly type: 'file'; readonly label: string }
  | { readonly type: 'task'; readonly label: string };

export interface ProjectTaskRunRequest {
  readonly label: string;
  readonly context: ProjectTaskEditorContext;
}

export type ProjectTaskRunResult = boolean | void;

/**
 * The controller delegates to this port. Task execution, cancellation,
 * Problems sessions and rerun snapshots remain owned by the legacy runner.
 */
export interface ProjectTasksRunnerPort {
  runActive(): Promise<ProjectTaskRunResult>;
  runProjectTask(request: ProjectTaskRunRequest): Promise<ProjectTaskRunResult>;
  canRerunLastProjectTask(): boolean;
  rerunLastProjectTask(
    context: ProjectTaskEditorContext
  ): false | Promise<ProjectTaskRunResult>;
  refreshControls(): void;
}

export interface ProjectTasksService extends Disposable {
  init(): void;
  refresh(): Promise<ProjectTaskConfigurationDto>;
  resolveTask(request: ProjectTaskResolveRequestDto): Promise<ProjectTaskResolveResultDto>;
  runSelected(): Promise<ProjectTaskRunResult>;
  rerunLast(): false | Promise<ProjectTaskRunResult>;
  resolveInputRequests(
    requests: readonly ProjectTaskInputRequestDto[]
  ): Promise<Record<string, string> | null>;
  cancelInput(): boolean;
  getSelected(): ProjectTaskSelection;
  getConfiguration(): ProjectTaskConfigurationDto;
}

export interface ProjectTaskPluginItemDto {
  readonly label: string;
  readonly kind: ProjectTaskKind;
  readonly type: string;
  readonly source: ProjectTaskSource;
  readonly executable: boolean;
  readonly warnings: readonly string[];
}

export interface ProjectTasksPluginView {
  list(): readonly ProjectTaskPluginItemDto[];
  getSelected(): Readonly<ProjectTaskSelection>;
}
