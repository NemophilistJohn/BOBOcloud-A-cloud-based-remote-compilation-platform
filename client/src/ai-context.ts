// Context gathering for AI chat and inline completions.
//
// The service deliberately knows only about the renderer state projection,
// Monaco's structural model/editor contracts, and the file-tree DOM.  The
// compatibility adapter owns the legacy BOBO namespace; no host bridge is
// reachable from this module.

import { DisposableStore } from '../renderer/core/disposable.js';
import type {
  AiContextActiveTabDto,
  AiContextCurrentFileDto,
  AiContextDependencies,
  AiContextFacade,
  AiContextFullContextDto,
  AiContextInlineContextDto,
  AiContextModelPort,
  AiContextPolicyDto,
  AiContextPositionDto,
  AiContextPromptsPort,
  AiContextRendererState,
  AiContextSelectionDto,
  AiContextService,
  AiContextTabDto
} from '../types/ai-context';
import type { AiPromptKeep } from '../types/ai-prompts';

export const AI_CONTEXT_SERVICE_ID = 'workbench.aiContext' as const;

function aiState(state: AiContextRendererState): NonNullable<AiContextRendererState['ai']> {
  return state.ai || {};
}

function policyValue(value: unknown): AiContextPolicyDto {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as AiContextPolicyDto
    : {};
}

function chatContextPolicy(state: AiContextRendererState): AiContextPolicyDto {
  const ai = aiState(state);
  return policyValue(ai.chat && ai.chat.context);
}

function inlineContextPolicy(state: AiContextRendererState): AiContextPolicyDto {
  const ai = aiState(state);
  return policyValue(ai.inline && ai.inline.context);
}

function boundedText(
  dependencies: AiContextDependencies,
  value: unknown,
  limit: unknown,
  keep?: AiPromptKeep
): string {
  const text = String(value || '');
  const size = Math.max(0, Math.floor(Number(limit) || 0));
  const prompts: AiContextPromptsPort | null | undefined = dependencies.getAiPrompts();
  const selectedKeep = keep || 'middle';
  if (prompts && typeof prompts.truncate === 'function') {
    return prompts.truncate(text, size, selectedKeep);
  }
  if (text.length <= size) return text;
  if (!size) return '';
  return keep === 'tail' ? text.slice(-size) : text.slice(0, size);
}

function createService(dependencies: AiContextDependencies): AiContextService {
  const { document, state } = dependencies;
  const lifecycle = new DisposableStore();
  let disposed = false;

  function getCurrentFileContext(): AiContextCurrentFileDto | null {
    if (disposed || Boolean(aiState(state).autoContextDisabled)) return null;
    const tab = state.tabs.find((candidate: AiContextTabDto) => (
      candidate.path === state.activeTabPath
    ));
    if (!tab) return null;
    const excluded = aiState(state).excludedAutoContextPaths || [];
    if (tab.path != null && excluded.indexOf(tab.path) >= 0) return null;

    let content = '';
    let totalLines = 0;

    if (tab.model && tab.language !== 'image') {
      const modelContent = tab.model.getValue();
      totalLines = tab.model.getLineCount();
      content = boundedText(
        dependencies,
        modelContent,
        chatContextPolicy(state).currentFileChars,
        'middle'
      );
    }

    return {
      path: tab.path,
      name: tab.name,
      language: tab.language || 'plaintext',
      content,
      totalLines,
      model: tab.model
    };
  }

  function getSelectionContext(): AiContextSelectionDto | null {
    if (disposed || Boolean(aiState(state).autoContextDisabled)) return null;
    let editor = state.editor || null;
    if (state.currentViewMode === 'split' && state.splitEditor) {
      editor = state.splitEditor.rightEditor || null;
    }
    if (!editor || typeof editor.getSelection !== 'function') return null;

    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) return null;
    const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
    if (!model) return null;

    const text = model.getValueInRange(selection);
    if (!text || text.trim().length === 0) return null;
    const trimmed = boundedText(
      dependencies,
      text,
      chatContextPolicy(state).selectionChars,
      'middle'
    );
    return {
      text: trimmed,
      startLine: selection.startLineNumber,
      endLine: selection.endLineNumber,
      totalChars: text.length
    };
  }

  function getProjectContext(): string | null {
    if (disposed || Boolean(aiState(state).autoContextDisabled)) return null;
    if (!state.workspaceRoot) return null;

    const parts: string[] = [];
    parts.push('Workspace: ' + String(state.workspaceRoot));

    // Gather file tree info from DOM.
    const treeElement = document.getElementById('file-tree');
    if (treeElement) {
      const allRows = treeElement.querySelectorAll<HTMLElement>('.tree-row[data-type="file"]');
      const fileCount = allRows.length;
      parts.push('Total files: ' + fileCount);

      const extensionCounts: Record<string, number> = Object.create(null) as Record<string, number>;
      for (let index = 0; index < allRows.length; index += 1) {
        const name = allRows[index]?.getAttribute('data-name');
        if (!name) continue;
        let extension = name.split('.').pop()?.toLowerCase() || '';
        if (extension === name) extension = '(no extension)';
        extensionCounts[extension] = (extensionCounts[extension] || 0) + 1;
      }

      const sorted = Object.keys(extensionCounts).sort((left, right) => (
        (extensionCounts[right] || 0) - (extensionCounts[left] || 0)
      ));
      if (sorted.length > 0) {
        parts.push('File types:');
        let shown = 0;
        for (let index = 0; index < sorted.length && shown < 15; index += 1) {
          const extension = sorted[index];
          if (extension === undefined) continue;
          parts.push('  - .' + extension + ': ' + extensionCounts[extension] + ' files');
          shown += 1;
        }
      }

      // List top-level folder structure (first 150 items).
      const rootList = treeElement.querySelector('ul');
      if (rootList) {
        const topItems = rootList.querySelectorAll<HTMLElement>(':scope > li > .tree-row');
        let itemsShown = 0;
        for (let index = 0; index < topItems.length && itemsShown < 150; index += 1) {
          const row = topItems[index];
          if (!row) continue;
          const itemName = row.getAttribute('data-name');
          const itemType = row.getAttribute('data-type');
          const prefix = itemType === 'folder' ? '[dir] ' : '[file] ';
          parts.push(prefix + itemName);
          itemsShown += 1;
        }
      }
    }

    return boundedText(dependencies, parts.join('\n'), chatContextPolicy(state).projectChars, 'middle');
  }

  function getActiveTabContexts(): AiContextActiveTabDto[] {
    if (disposed || Boolean(aiState(state).autoContextDisabled)) return [];
    const tabs: AiContextActiveTabDto[] = [];
    for (let index = 0; index < state.tabs.length; index += 1) {
      const tab = state.tabs[index];
      if (!tab) continue;
      let lines = 0;
      if (tab.model && tab.language !== 'image') {
        lines = tab.model.getLineCount();
      }
      const info: AiContextActiveTabDto = {
        name: tab.name,
        path: tab.path,
        language: tab.language || 'plaintext',
        lines
      };
      tabs.push(info);
    }
    return tabs;
  }

  function buildFullContext(): AiContextFullContextDto {
    if (disposed) {
      return {
        currentFile: null,
        selection: null,
        projectStructure: null,
        openTabs: [],
        referencedFiles: []
      };
    }
    const referencedFiles = (aiState(state).referencedFiles || []).map((file) => ({
      path: file.path,
      name: file.name
    }));
    return {
      currentFile: getCurrentFileContext(),
      selection: getSelectionContext(),
      projectStructure: getProjectContext(),
      openTabs: getActiveTabContexts(),
      referencedFiles
    };
  }

  function getInlineContext(
    requestModel?: AiContextModelPort | null,
    requestPosition?: AiContextPositionDto | null
  ): AiContextInlineContextDto | null {
    if (disposed) return null;
    const editor = state.editor || null;
    const model = requestModel || (
      editor && typeof editor.getModel === 'function' ? editor.getModel() : null
    );
    if (!model) return null;

    const position = requestPosition || (
      editor && typeof editor.getPosition === 'function' ? editor.getPosition() : null
    );
    if (!position) return null;

    const tab = state.tabs.find((candidate: AiContextTabDto) => (
      candidate.path === state.activeTabPath
    ));
    const fullValue = model.getValue();
    const offset = model.getOffsetAt(position);
    const codeBefore = fullValue.substring(0, offset);
    const codeAfter = fullValue.substring(offset);
    const policy = inlineContextPolicy(state);

    const rawPrefixChars = policy.prefixChars !== undefined
      ? policy.prefixChars
      : aiState(state).inlinePrefixChars;
    const parsedPrefixChars = Number(rawPrefixChars);
    const prefixChars = Math.max(
      500,
      Math.min(16000, Number.isFinite(parsedPrefixChars) ? parsedPrefixChars : 6000)
    );
    const rawSuffixChars = policy.suffixChars !== undefined
      ? policy.suffixChars
      : aiState(state).inlineSuffixChars;
    const parsedSuffixChars = rawSuffixChars === undefined || rawSuffixChars === null || rawSuffixChars === ''
      ? 2500
      : Number(rawSuffixChars);
    const suffixChars = Math.max(
      0,
      Math.min(8000, Number.isFinite(parsedSuffixChars) ? parsedSuffixChars : 2500)
    );
    const contextBefore = codeBefore.length > prefixChars
      ? codeBefore.substring(codeBefore.length - prefixChars)
      : codeBefore;
    const contextAfter = codeAfter.length > suffixChars
      ? codeAfter.substring(0, suffixChars)
      : codeAfter;

    return {
      codeBefore: contextBefore,
      codeAfter: contextAfter,
      language: tab ? tab.language : model.getLanguageId(),
      fileName: tab ? tab.name : 'untitled',
      position: { line: position.lineNumber, column: position.column },
      version: typeof model.getVersionId === 'function' ? model.getVersionId() : 0
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    lifecycle.dispose();
  }

  const facade: AiContextFacade = {
    getCurrentFileContext,
    getSelectionContext,
    getProjectContext,
    getActiveTabContexts,
    buildFullContext,
    getInlineContext
  };
  const service: AiContextService = {
    ...facade,
    get disposed(): boolean { return disposed; },
    dispose
  };
  return Object.freeze(service);
}

export function createAiContextService(dependencies: AiContextDependencies): AiContextService {
  return createService(dependencies);
}
