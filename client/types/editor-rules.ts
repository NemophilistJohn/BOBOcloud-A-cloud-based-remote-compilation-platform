import type {
  DiagnosticsCheckId,
  DiagnosticsCheckOn,
  DiagnosticsSettings,
  DiagnosticsSeverity
} from './diagnostics';
import type { Disposable } from './lifecycle';

/** Languages with first-party editor-rule plug-ins. */
export type EditorRuleLanguageId =
  | 'c'
  | 'cpp'
  | 'java'
  | 'go'
  | 'python'
  | 'rust'
  | (string & {});

export type EditorRuleSymbolKind =
  | 'variable'
  | 'field'
  | 'property'
  | 'constant'
  | 'function'
  | 'method'
  | 'class'
  | 'struct'
  | 'interface'
  | 'enum'
  | 'typedef'
  | 'module'
  | 'namespace'
  | 'macro'
  | (string & {});

/** Normalized symbol emitted by the lightweight document extractor. */
export interface EditorRuleSymbolDto {
  readonly name: string;
  readonly kind: EditorRuleSymbolKind;
  readonly detail: string;
  readonly priority: number;
  readonly insertText: string;
}

export interface EditorRulePositionDto {
  readonly lineNumber: number;
  readonly column: number;
}

export interface EditorRuleRangeDto {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface EditorRuleWordDto {
  readonly word: string;
  readonly startColumn: number;
  readonly endColumn: number;
}

/**
 * Text-model surface used by completion and symbol extraction.  Monaco stays
 * in its AMD realm, so this is intentionally structural rather than an import
 * of Monaco's concrete declarations.
 */
export interface EditorRuleTextModelPort {
  getValue(): string;
  getLineCount(): number;
  getLanguageId?(): string;
  getLineContent?(lineNumber: number): string;
  getValueLength?(): number;
  getValueInRange?(range: EditorRuleRangeDto): string;
  getOffsetAt?(position: EditorRulePositionDto): number;
  getWordUntilPosition?(position: EditorRulePositionDto): EditorRuleWordDto | null | undefined;
}

export interface EditorRuleCancellationToken {
  readonly isCancellationRequested?: boolean;
}

export type EditorRuleCompletionLabel =
  | string
  | {
      readonly label: string;
      readonly [key: string]: unknown;
    };

export interface EditorRuleCompletionItemDto {
  readonly label: EditorRuleCompletionLabel;
  readonly kind?: number;
  readonly detail?: string;
  readonly insertText?: string;
  readonly insertTextRules?: number;
  readonly range?: EditorRuleRangeDto;
  readonly filterText?: string;
  readonly sortText?: string;
  readonly commitCharacters?: readonly string[];
  readonly [key: string]: unknown;
}

export interface EditorRuleCompletionListDto {
  readonly suggestions: readonly EditorRuleCompletionItemDto[];
  readonly [key: string]: unknown;
}

export interface EditorRuleCompletionContextDto {
  readonly triggerCharacter?: string;
  readonly [key: string]: unknown;
}

/** Context produced after the completion engine has inspected the model. */
export interface EditorRuleAnalyzedContextDto extends EditorRuleCompletionContextDto {
  readonly language: EditorRuleLanguageId;
  readonly linePrefix: string;
  readonly word: string;
  readonly memberAccess: { readonly expression: string; readonly operator: string } | null;
  readonly preprocessor: boolean;
  readonly lexicalState: 'code' | 'line-comment' | 'block-comment' | 'string' | 'triple-string';
  readonly invalidTrigger: boolean;
  readonly range: EditorRuleRangeDto;
}

export type EditorRuleCompletionResult =
  | EditorRuleCompletionListDto
  | null
  | undefined
  | Promise<EditorRuleCompletionListDto | null | undefined>;

export interface EditorRuleCompletionProvider {
  readonly triggerCharacters?: readonly string[];
  provideCompletionItems(
    model?: EditorRuleTextModelPort,
    position?: EditorRulePositionDto,
    context?: EditorRuleCompletionContextDto,
    token?: EditorRuleCancellationToken
  ): EditorRuleCompletionResult;
}

export interface EditorRuleProviderRegistration extends Disposable {}

export interface EditorRuleCompletionItemKindPort {
  readonly [key: string]: number;
}

export interface EditorRuleCompletionInsertTextRulePort {
  readonly InsertAsSnippet: number;
  readonly [key: string]: number;
}

export interface EditorRuleLanguagesPort {
  readonly CompletionItemKind: EditorRuleCompletionItemKindPort;
  readonly CompletionItemInsertTextRule: EditorRuleCompletionInsertTextRulePort;
  registerCompletionItemProvider(
    language: EditorRuleLanguageId,
    provider: EditorRuleCompletionProvider
  ): EditorRuleProviderRegistration;
}

export interface EditorRuleMarkerSeverityPort {
  readonly Error: number;
  readonly Warning: number;
  readonly Info: number;
  readonly Hint?: number;
  readonly [key: string]: number | undefined;
}

export interface EditorRuleMonacoPort {
  readonly languages: EditorRuleLanguagesPort;
  readonly MarkerSeverity: EditorRuleMarkerSeverityPort;
}

export interface EditorRuleMarkerDto {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
  readonly startColumn: number;
  readonly endColumn: number;
  readonly message: string;
  readonly severity: number;
  readonly [key: string]: unknown;
}

export interface EditorRuleBlockCommentDto {
  readonly start: string;
  readonly end: string;
}

export interface EditorRuleDiagnosticEmit {
  (
    severity: DiagnosticsSeverity,
    line: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void;
}

export interface EditorRuleBalancedPairOptions {
  readonly lines?: readonly string[];
  readonly pairs?: Readonly<Record<string, string>>;
  readonly lineComment?: string | null;
  readonly blockComments?: readonly EditorRuleBlockCommentDto[];
  readonly quoteChars?: readonly string[];
  readonly ignoreRustLifetime?: boolean;
  readonly emit?: EditorRuleDiagnosticEmit;
}

export interface EditorRuleCommonDiagnosticOptions {
  readonly lines?: readonly string[];
  readonly maxLineLength?: number;
  readonly checkTrailingWS?: boolean;
  readonly checkMixedIndent?: boolean;
  readonly checkLongLines?: boolean;
  readonly checkTodo?: boolean;
  readonly lineComment?: string | null;
}

export interface EditorRuleUnclosedStringOptions {
  readonly lines?: readonly string[];
  readonly lineComment?: string | null;
  readonly blockComments?: readonly EditorRuleBlockCommentDto[];
  readonly quoteChars?: readonly string[];
  readonly emit?: EditorRuleDiagnosticEmit;
}

export interface EditorRuleCheckConfigDto {
  readonly enabled: boolean;
  readonly severity: DiagnosticsSeverity;
  readonly maxLineLength?: number;
}

export interface EditorRuleDiagnosticsSettingsDto {
  readonly enabled: boolean;
  readonly checkOn: DiagnosticsCheckOn;
  readonly debounceMs: number;
  readonly checks: Readonly<Partial<Record<DiagnosticsCheckId, EditorRuleCheckConfigDto>>>;
  readonly [key: string]: unknown;
}

export interface EditorRuleHelpers {
  createSnippet(
    label: string,
    insertText: string,
    kind: number,
    monaco: EditorRuleMonacoPort,
    extra?: Readonly<Record<string, unknown>>
  ): EditorRuleCompletionItemDto;
  createPlain(
    label: string,
    insertText: string,
    kind: number,
    extra?: Readonly<Record<string, unknown>>
  ): EditorRuleCompletionItemDto;
  pushMarker(
    markers: EditorRuleMarkerDto[],
    monaco: EditorRuleMonacoPort,
    line: number,
    startColumn: number,
    endColumn: number,
    message: string,
    severity?: number
  ): void;
  pushError(
    markers: EditorRuleMarkerDto[],
    monaco: EditorRuleMonacoPort,
    line: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void;
  pushWarning(
    markers: EditorRuleMarkerDto[],
    monaco: EditorRuleMonacoPort,
    line: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void;
  pushInfo(
    markers: EditorRuleMarkerDto[],
    monaco: EditorRuleMonacoPort,
    line: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void;
  createBalancedPairDiagnostics(
    content: string,
    monaco: EditorRuleMonacoPort,
    options?: EditorRuleBalancedPairOptions
  ): readonly EditorRuleMarkerDto[];
  createCommonDiagnostics(
    content: string,
    monaco: EditorRuleMonacoPort,
    options?: EditorRuleCommonDiagnosticOptions
  ): readonly EditorRuleMarkerDto[];
  checkUnclosedStrings(
    content: string,
    monaco: EditorRuleMonacoPort,
    options?: EditorRuleUnclosedStringOptions
  ): readonly EditorRuleMarkerDto[];
  getCheck(
    settings: unknown,
    id: DiagnosticsCheckId | string,
    defaultSeverity?: DiagnosticsSeverity
  ): EditorRuleCheckConfigDto;
  resolveSeverity(monaco: EditorRuleMonacoPort, severity: DiagnosticsSeverity): number;
  pushChecked(
    markers: EditorRuleMarkerDto[],
    monaco: EditorRuleMonacoPort,
    settings: unknown,
    checkId: DiagnosticsCheckId | string,
    defaultSeverity: DiagnosticsSeverity,
    line: number,
    startColumn: number,
    endColumn: number,
    message: string
  ): void;
}

export interface EditorRuleCompletionProviderOptions {
  readonly monaco: EditorRuleMonacoPort;
  readonly language: EditorRuleLanguageId;
  readonly staticProvider?: EditorRuleCompletionProvider | null;
  readonly symbolProvider?: (
    model: EditorRuleTextModelPort,
    position: EditorRulePositionDto,
    context: EditorRuleCompletionContextDto,
    token?: EditorRuleCancellationToken
  ) => readonly EditorRuleCompletionItemDto[];
}

export interface EditorRuleCompletionEnginePort {
  analyzeContext(
    model: EditorRuleTextModelPort,
    position: EditorRulePositionDto,
    language: EditorRuleLanguageId,
    requestContext?: EditorRuleCompletionContextDto
  ): EditorRuleAnalyzedContextDto;
  combineSuggestions(
    staticSuggestions: readonly EditorRuleCompletionItemDto[],
    symbolSuggestions: readonly EditorRuleCompletionItemDto[],
    context: EditorRuleAnalyzedContextDto,
    monaco: EditorRuleMonacoPort
  ): EditorRuleCompletionListDto;
  createProvider(options: EditorRuleCompletionProviderOptions): EditorRuleCompletionProvider;
  dedupeSuggestions(
    suggestions: readonly EditorRuleCompletionItemDto[]
  ): readonly EditorRuleCompletionItemDto[];
  lexicalStateAt(
    model: EditorRuleTextModelPort,
    position: EditorRulePositionDto,
    language: EditorRuleLanguageId
  ): string;
  safeTriggerCharacters(
    language: EditorRuleLanguageId,
    declared?: readonly string[]
  ): readonly string[];
}

export interface EditorRuleSymbolExtractorPort {
  extract(
    content: string,
    language: EditorRuleLanguageId,
    cursorLine?: number
  ): readonly EditorRuleSymbolDto[];
  extractMembers?(
    content: string,
    language: EditorRuleLanguageId,
    receiver: string,
    cursorLine?: number
  ): readonly EditorRuleSymbolDto[];
}

export interface EditorRuleCFamilyDiagnosticsOptions {
  readonly monaco: EditorRuleMonacoPort;
  readonly content: string;
  readonly lines?: readonly string[];
  readonly settings: unknown;
  readonly helpers: EditorRuleHelpers;
  readonly lang: EditorRuleLanguageId;
}

export interface EditorRuleTokenDto {
  readonly type: string;
  readonly value: string;
  readonly line: number;
  readonly col: number;
}

export interface EditorRuleCFamilyCheckerPort {
  runCFamilyDiagnostics(
    options: EditorRuleCFamilyDiagnosticsOptions
  ): readonly EditorRuleMarkerDto[];
  tokenize(source: string): readonly EditorRuleTokenDto[];
}

export interface EditorRulePluginDiagnosticsOptions {
  readonly monaco: EditorRuleMonacoPort;
  readonly model: EditorRuleTextModelPort;
  readonly content: string;
  readonly lines: readonly string[];
  readonly helpers: EditorRuleHelpers;
  readonly settings: EditorRuleDiagnosticsSettingsDto;
  readonly largeFile: boolean;
  readonly lang?: EditorRuleLanguageId;
}

export interface EditorRuleLanguagePlugin {
  readonly language: EditorRuleLanguageId;
  readonly createCompletionProvider?: (
    monaco: EditorRuleMonacoPort,
    helpers: EditorRuleHelpers
  ) => EditorRuleCompletionProvider | null | undefined;
  readonly provideDiagnostics?: (
    options: EditorRulePluginDiagnosticsOptions
  ) => readonly EditorRuleMarkerDto[] | null | undefined;
}

export interface EditorRuleDiagnosticsPort {
  readonly DEFAULT_DIAGNOSTICS_SETTINGS: unknown;
  setDiagnosticsSettings(settings: DiagnosticsSettings): void;
  getDiagnosticsSettings?(): DiagnosticsSettings | EditorRuleDiagnosticsSettingsDto;
  mergeSettings?(settings: unknown): DiagnosticsSettings | EditorRuleDiagnosticsSettingsDto;
}

/** Registry contract used by the future typed editor-rules service. */
export interface EditorRuleRegistryPort extends EditorRuleDiagnosticsPort {
  registerLanguageRulePlugin(plugin: EditorRuleLanguagePlugin): void;
  listLanguageRulePlugins(): readonly EditorRuleLanguagePlugin[];
  getLanguageRulePlugin(language: EditorRuleLanguageId): EditorRuleLanguagePlugin | null;
  registerCompletionProviders(monaco: EditorRuleMonacoPort): void;
  getSyntaxMarkers(
    model: EditorRuleTextModelPort,
    monaco: EditorRuleMonacoPort,
    options?: { readonly largeFile?: boolean }
  ): readonly EditorRuleMarkerDto[];
  readonly helpers: EditorRuleHelpers;
}

/** Global projections retained while the registry is migrated in a later slice. */
export interface EditorRuleGlobals {
  editorRuleRegistry?: EditorRuleRegistryPort;
  completionEngine?: EditorRuleCompletionEnginePort;
  symbolExtractor?: EditorRuleSymbolExtractorPort;
  cFamilyChecker?: EditorRuleCFamilyCheckerPort;
  registerCompletionProviders?: (monaco: EditorRuleMonacoPort) => void;
}
