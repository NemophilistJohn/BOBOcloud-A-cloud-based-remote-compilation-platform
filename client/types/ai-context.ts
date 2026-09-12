import type { AiPromptKeep } from './ai-prompts';
import type { Disposable } from './lifecycle';

/** Minimal Monaco position shape used by inline context requests. */
export interface AiContextPositionDto {
  readonly lineNumber: number;
  readonly column: number;
}

/** Structural selection shape; the AMD Monaco value stays outside this module. */
export interface AiContextSelectionPort {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  isEmpty(): boolean;
}

/** Structural model shape required for context extraction. */
export interface AiContextModelPort {
  getValue(): string;
  getLineCount(): number;
  getValueInRange(selection: AiContextSelectionPort): string;
  getOffsetAt(position: AiContextPositionDto): number;
  getLanguageId(): string;
  getVersionId?(): number;
}

/** Structural editor shape required for selection and inline context. */
export interface AiContextEditorPort {
  getSelection?(): AiContextSelectionPort | null;
  getModel?(): AiContextModelPort | null;
  getPosition?(): AiContextPositionDto | null;
}

export interface AiContextSplitEditorPort {
  readonly rightEditor?: AiContextEditorPort | null;
}

export interface AiContextTabDto {
  readonly path?: string | null;
  readonly name?: string;
  readonly language?: string;
  readonly model?: AiContextModelPort | null;
  readonly [key: string]: unknown;
}

export interface AiContextReferencedFileDto {
  readonly path?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface AiContextPolicyDto {
  readonly currentFileChars?: unknown;
  readonly selectionChars?: unknown;
  readonly projectChars?: unknown;
  readonly prefixChars?: unknown;
  readonly suffixChars?: unknown;
  readonly [key: string]: unknown;
}

export interface AiContextAiStateDto {
  readonly autoContextDisabled?: boolean;
  readonly excludedAutoContextPaths?: readonly string[];
  readonly referencedFiles?: readonly AiContextReferencedFileDto[];
  readonly chat?: { readonly context?: AiContextPolicyDto | null; [key: string]: unknown } | null;
  readonly inline?: { readonly context?: AiContextPolicyDto | null; [key: string]: unknown } | null;
  readonly inlinePrefixChars?: unknown;
  readonly inlineSuffixChars?: unknown;
  readonly [key: string]: unknown;
}

/** Mutable state projection consumed by the context service. */
export interface AiContextRendererState {
  readonly ai?: AiContextAiStateDto | null;
  readonly tabs: readonly AiContextTabDto[];
  readonly activeTabPath?: string | null;
  readonly currentViewMode?: string | null;
  readonly editor?: AiContextEditorPort | null;
  readonly splitEditor?: AiContextSplitEditorPort | null;
  readonly workspaceRoot?: unknown;
}

export interface AiContextPromptsPort {
  truncate?(
    value: unknown,
    limit: unknown,
    keep?: AiPromptKeep
  ): string;
}

export interface AiContextCurrentFileDto {
  readonly path?: string | null;
  readonly name?: string;
  readonly language: string;
  readonly content: string;
  readonly totalLines: number;
  readonly model?: AiContextModelPort | null;
}

export interface AiContextSelectionDto {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalChars: number;
}

export interface AiContextActiveTabDto {
  readonly name?: string;
  readonly path?: string | null;
  readonly language: string;
  readonly lines: number;
}

export interface AiContextFullContextDto {
  readonly currentFile: AiContextCurrentFileDto | null;
  readonly selection: AiContextSelectionDto | null;
  readonly projectStructure: string | null;
  readonly openTabs: AiContextActiveTabDto[];
  readonly referencedFiles: Array<{ readonly path?: string; readonly name?: string }>;
}

export interface AiContextInlineContextDto {
  readonly codeBefore: string;
  readonly codeAfter: string;
  readonly language?: string;
  readonly fileName?: string;
  readonly position: {
    readonly line: number;
    readonly column: number;
  };
  readonly version: number;
  /** Preserve forward-compatible metadata when passed to the AI transport. */
  readonly [key: string]: unknown;
}

export interface AiContextDependencies {
  readonly document: Document;
  readonly state: AiContextRendererState;
  readonly getAiPrompts: () => AiContextPromptsPort | null | undefined;
}

/** Historical six-method BOBO projection. */
export interface AiContextFacade {
  getCurrentFileContext(): AiContextCurrentFileDto | null;
  getSelectionContext(): AiContextSelectionDto | null;
  getProjectContext(): string | null;
  getActiveTabContexts(): AiContextActiveTabDto[];
  buildFullContext(): AiContextFullContextDto;
  getInlineContext(
    requestModel?: AiContextModelPort | null,
    requestPosition?: AiContextPositionDto | null
  ): AiContextInlineContextDto | null;
}

export interface AiContextService extends AiContextFacade, Disposable {
  readonly disposed: boolean;
}
