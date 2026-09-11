// Server HTTP communication and the bounded run-output transcript.
//
// The implementation is deliberately independent from the legacy BOBO object.
// renderer/compat/server-comm-adapter.ts supplies the host ports and projects
// the historical five-key facade back onto BOBO.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  ServerCommAbortController,
  ServerCommActionDto,
  ServerCommDependencies,
  ServerCommFacade,
  ServerCommFetchResponse,
  ServerCommOutputKind,
  ServerCommOutputUpdateOptionsDto,
  ServerCommRendererState,
  ServerCommRequestOptionsDto,
  ServerCommResponseEnvelopeDto,
  ServerCommService,
  ServerCommTimer
} from '../types/server-comm';

export const SERVER_COMM_SERVICE_ID = 'workbench.serverComm' as const;

const MAX_OUTPUT_LINES = 5000;
const MAX_DETAIL_LINES = 300;
const MAX_OUTPUT_RECORD_CHARS = 256 * 1024;
const MAX_OUTPUT_TRANSCRIPT_CHARS = 20 * 1024 * 1024;
const MAX_DETAIL_TRANSCRIPT_CHARS = 2 * 1024 * 1024;
const OUTPUT_FLUSH_THRESHOLD = 50;
const OUTPUT_FLUSH_DELAY_MS = 200;

interface OutputElement extends HTMLElement {
  _outputRecord?: OutputRecord;
  _errLinkBound?: boolean;
}

interface OutputRecord {
  text: string;
  timestampPrefix?: string;
  kind: ServerCommOutputKind;
  stage?: string;
  raw?: string;
  streamKey?: string;
  element: OutputElement | null;
  newlineNode: Text | null;
  truncated: boolean;
}

interface ErrorPattern {
  readonly pattern: RegExp;
  readonly fileGroup: number;
  readonly lineGroup: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringErrorMessage(error: unknown): string {
  if (isRecord(error) && error.message !== undefined) return String(error.message);
  if (error === null || error === undefined || error === '') return 'Unknown error';
  return String(error);
}

export function createServerCommService(
  dependencies: ServerCommDependencies
): ServerCommService {
  const documentRef = dependencies.document;
  const lifecycle = new DisposableStore();
  let disposed = false;

  // ──── Output logging (bounded, batched DOM appends + colored prefixes) ────
  let pendingOutputLines: OutputRecord[] = [];
  let outputFlushTimer: ServerCommTimer | null = null;
  let renderedOutputCount = 0;
  let renderedProgramCount = 0;
  let renderedDetailCount = 0;
  let omittedProgramCount = 0;
  let openOutputRecords: Record<string, OutputRecord> = Object.create(null) as Record<string, OutputRecord>;
  const dirtyOutputRecords = new Set<OutputRecord>();
  let cachedRunLogElement: OutputElement | null = null;
  let cachedOutputPanelElement: HTMLElement | null = null;
  let boundOutputElement: OutputElement | null = null;
  let boundOutputHandler: ((event: Event) => void) | null = null;

  function state(): ServerCommRendererState {
    const current = dependencies.getState();
    if (!current) throw new Error('Server communication requires renderer state.');
    return current;
  }

  function cachedElement<T extends HTMLElement>(
    current: T | null,
    id: string
  ): T | null {
    if (current && current.isConnected !== false) return current;
    return documentRef.getElementById(id) as T | null;
  }

  function runLogElement(): OutputElement | null {
    cachedRunLogElement = cachedElement(cachedRunLogElement, 'run-log');
    return cachedRunLogElement;
  }

  function outputPanelElement(): HTMLElement | null {
    cachedOutputPanelElement = cachedElement(cachedOutputPanelElement, 'panel-output');
    return cachedOutputPanelElement;
  }

  function localizeServerError(message: unknown): string {
    if (!message) return String(message || '');
    const i18n = dependencies.getI18n();
    return i18n && typeof i18n.t === 'function'
      ? i18n.t(String(message))
      : String(message);
  }

  function invalidResponseMessage(_response: ServerCommFetchResponse, body: unknown): string {
    if (/Client sent an HTTP request to an HTTPS server/i.test(String(body || ''))) {
      return localizeServerError(
        'The server requires HTTPS, but secure transport is disabled in Server Settings.'
      );
    }
    return localizeServerError(
      'The server returned an invalid response. Check the server address and transport setting.'
    );
  }

  function retryAfterSeconds(response: ServerCommFetchResponse): number {
    if (!response.headers || typeof response.headers.get !== 'function') return 0;
    const raw = response.headers.get('Retry-After');
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
  }

  function escHtml(value: unknown): string {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function colorSpan(text: string, cssVar: string): string {
    return '<span style="color:' + cssVar + ';font-weight:bold">' + text + '</span>';
  }

  // Compiler error location patterns for different languages.
  const ERROR_PATTERNS: readonly ErrorPattern[] = [
    // GCC/Clang/C/Cpp: file.c:10:5: error  or  file.c:10: error
    { pattern: /(^|[^\w/.])([\w][\w/.\-]*\.(?:c|cpp|cc|cxx|h|hpp)):(\d+)(?::\d+)?/g, fileGroup: 2, lineGroup: 3 },
    // Java: Main.java:10: error
    { pattern: /(^|[^\w/.])([\w][\w/.\-]*\.java):(\d+)(?::\d+)?/g, fileGroup: 2, lineGroup: 3 },
    // Rust: --> src/main.rs:10:5  (after escHtml, > becomes &gt;)
    { pattern: /--&gt;\s*([\w][\w/.\-]*\.rs):(\d+):(\d+)/g, fileGroup: 1, lineGroup: 2 },
    // Python: File "main.py", line 10 (quotes have already been escaped)
    { pattern: /File &quot;([\w][\w/.\-]*\.py)&quot;, line (\d+)/g, fileGroup: 1, lineGroup: 2 },
    // Go: main.go:10:5: error
    { pattern: /(^|[^\w/.])([\w][\w/.\-]*\.go):(\d+)(?::\d+)?/g, fileGroup: 2, lineGroup: 3 }
  ];

  function linkifyErrorPaths(html: string): string {
    let result = html;
    for (const entry of ERROR_PATTERNS) {
      result = result.replace(entry.pattern, (...args: unknown[]) => {
        const match = String(args[0]);
        const file = String(args[entry.fileGroup] || '');
        const line = String(args[entry.lineGroup] || '');
        if (!file || !line) return match;
        const cleanFile = file
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        const fileIndex = match.indexOf(file);
        const prefix = match.substring(0, fileIndex);
        const suffix = match.substring(fileIndex + file.length);
        // Keep the visible text escaped and escape the decoded value again for
        // the attribute. This closes the old quote-injection edge case while
        // preserving DOM getAttribute()'s decoded path.
        return prefix +
          '<a class="err-link" data-file="' + escHtml(cleanFile) + '" data-line="' + escHtml(line) + '" ' +
          'style="color:var(--blue);text-decoration:underline;cursor:pointer">' + file + '</a>' +
          suffix;
      });
    }
    return result;
  }

  // Colorize the prefix of a message line - only the keyword/tag, not the whole line.
  // Also detects compiler error file:line patterns and makes them clickable.
  function colorizeMessage(message: unknown): string {
    const raw = escHtml(message);
    const linkified = linkifyErrorPaths(raw);

    // Error: red
    if (/^\[(Error|Server Error)\]/.test(raw) || /^Error[: ]/.test(raw)) {
      const match = raw.match(/^(\[?(?:Error|Server Error)\]?:?)/);
      return match
        ? colorSpan(match[1] || '', 'var(--red)') + linkified.slice(match[0].length)
        : linkified;
    }
    // Warnings: yellow
    if (/^\[WARNING\]/.test(raw) || /^Warning[: ]/.test(raw)) {
      const match = raw.match(/^(\[WARNING\]|Warning:?)/);
      return match
        ? colorSpan(match[1] || '', 'var(--yellow)') + linkified.slice(match[0].length)
        : linkified;
    }
    // Setup / Docker stages: blue
    if (/^\[(setup|docker|docker:pull)\]/.test(raw)) {
      const match = raw.match(/^(\[(?:setup|docker|docker:pull)\]\s*)/);
      return match
        ? colorSpan(match[1] || '', 'var(--blue)') + linkified.slice(match[0].length)
        : linkified;
    }
    // Run stages: green
    if (/^\[run:/.test(raw)) {
      const match = raw.match(/^(\[run:[^\]]+\]\s*)/);
      return match
        ? colorSpan(match[1] || '', 'var(--green)') + linkified.slice(match[0].length)
        : linkified;
    }
    // Stderr: yellow prefix + linkified body
    if (/^\[stderr\]/.test(raw)) {
      const body = linkified.slice('[stderr] '.length);
      return colorSpan('[stderr] ', 'var(--yellow)') + body;
    }
    // Artifacts / saved: blue
    if (/^(Saved figure|Artifacts)/.test(raw)) {
      const match = raw.match(/^(Saved figure:|Artifacts)/);
      return match
        ? colorSpan(match[1] || '', 'var(--blue)') + linkified.slice(match[0].length)
        : linkified;
    }
    // Terminal prompt: blue
    if (/^\$ /.test(raw)) return colorSpan('$ ', 'var(--blue)') + linkified.slice(2);

    return linkified;
  }

  function normalizeOutputKind(options: ServerCommOutputUpdateOptionsDto | undefined): ServerCommOutputKind {
    return options && options.kind === 'detail' ? 'detail' : 'program';
  }

  function forgetOpenOutputRecord(record: OutputRecord | null | undefined): void {
    if (!record || !record.streamKey) return;
    if (openOutputRecords[record.streamKey] === record) delete openOutputRecords[record.streamKey];
    dirtyOutputRecords.delete(record);
  }

  function resetOpenOutputRecords(): void {
    openOutputRecords = Object.create(null) as Record<string, OutputRecord>;
    dirtyOutputRecords.clear();
  }

  function trimPendingKind(kind: ServerCommOutputKind, limit: number): number {
    let count = 0;
    let removed = 0;
    for (const record of pendingOutputLines) if (record.kind === kind) count += 1;
    for (let index = 0; count > limit && index < pendingOutputLines.length;) {
      const candidate = pendingOutputLines[index];
      if (!candidate) break;
      if (candidate.kind === kind) {
        const removedRecord = pendingOutputLines.splice(index, 1)[0];
        forgetOpenOutputRecord(removedRecord);
        count -= 1;
        removed += 1;
      } else {
        index += 1;
      }
    }
    return removed;
  }

  function removeOldestRendered(outputEl: OutputElement, kind: ServerCommOutputKind): boolean {
    for (let index = 0; index < outputEl.childNodes.length; index += 1) {
      const child = outputEl.childNodes[index] as OutputElement | undefined;
      if (child && child.getAttribute && child.getAttribute('data-output-kind') === kind) {
        forgetOpenOutputRecord(child._outputRecord);
        outputEl.removeChild(child);
        return true;
      }
    }
    return false;
  }

  function trimRenderedKindByCharacters(
    outputEl: OutputElement,
    kind: ServerCommOutputKind,
    limit: number
  ): number {
    const records: Array<{ child: OutputElement; record?: OutputRecord; characters: number }> = [];
    let retainedCharacters = 0;
    for (let index = 0; index < outputEl.childNodes.length; index += 1) {
      const child = outputEl.childNodes[index] as OutputElement | undefined;
      if (!child || !child.getAttribute || child.getAttribute('data-output-kind') !== kind) continue;
      const record = child._outputRecord;
      const characters = record
        ? String(record.text || '').length
        : String(child.textContent || '').length;
      retainedCharacters += characters;
      records.push({ child, record, characters });
    }
    let removed = 0;
    for (const candidate of records) {
      if (retainedCharacters <= limit) break;
      forgetOpenOutputRecord(candidate.record);
      if (candidate.child.parentNode === outputEl) outputEl.removeChild(candidate.child);
      retainedCharacters -= candidate.characters;
      removed += 1;
    }
    return removed;
  }

  function outputText(source: string, replacements?: Readonly<Record<string, unknown>>): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(source, replacements);
    return source.replace(/\{([^}]+)\}/g, (match: string, key: string) => (
      replacements && replacements[key] !== undefined ? String(replacements[key]) : match
    ));
  }

  function updateOmissionMarker(outputEl: OutputElement | null): void {
    if (!outputEl) return;
    let marker: OutputElement | null = null;
    for (let index = 0; index < outputEl.childNodes.length; index += 1) {
      const child = outputEl.childNodes[index] as OutputElement | undefined;
      if (child && child.getAttribute && child.getAttribute('data-output-omission') === 'true') {
        marker = child;
        break;
      }
    }
    if (omittedProgramCount <= 0) {
      if (marker) outputEl.removeChild(marker);
      return;
    }
    if (!marker) {
      marker = documentRef.createElement('span') as OutputElement;
      marker.className = 'run-output-omission';
      marker.setAttribute('data-output-kind', 'notice');
      marker.setAttribute('data-output-omission', 'true');
      if (typeof outputEl.insertBefore === 'function') outputEl.insertBefore(marker, outputEl.firstChild);
      else outputEl.appendChild(marker);
    }
    marker.textContent = outputText(
      'Earlier output omitted: {count} lines (recent output kept within safety limits).',
      { count: omittedProgramCount }
    );
  }

  function renderOutputRecord(record: OutputRecord, line: OutputElement): void {
    dirtyOutputRecords.delete(record);
    line.innerHTML = colorizeMessage(record.text);
    if (!record.newlineNode) record.newlineNode = documentRef.createTextNode('\n');
    if (record.newlineNode.parentNode !== line) line.appendChild(record.newlineNode);
  }

  function enforceRenderedOutputLimits(outputEl: OutputElement): void {
    while (renderedProgramCount > MAX_OUTPUT_LINES && removeOldestRendered(outputEl, 'program')) {
      renderedProgramCount -= 1;
      omittedProgramCount += 1;
    }
    while (renderedDetailCount > MAX_DETAIL_LINES && removeOldestRendered(outputEl, 'detail')) {
      renderedDetailCount -= 1;
    }
    const removedProgramForSize = trimRenderedKindByCharacters(
      outputEl,
      'program',
      MAX_OUTPUT_TRANSCRIPT_CHARS
    );
    renderedProgramCount = Math.max(0, renderedProgramCount - removedProgramForSize);
    omittedProgramCount += removedProgramForSize;
    renderedDetailCount = Math.max(
      0,
      renderedDetailCount - trimRenderedKindByCharacters(
        outputEl,
        'detail',
        MAX_DETAIL_TRANSCRIPT_CHARS
      )
    );
    updateOmissionMarker(outputEl);
    renderedOutputCount = outputEl.childNodes.length;
  }

  function onOutputClick(event: Event): void {
    const target = event.target as Element | null;
    const link = target && typeof target.closest === 'function'
      ? target.closest('.err-link') as HTMLElement | null
      : null;
    if (!link) return;
    event.preventDefault();
    const file = link.getAttribute('data-file');
    const line = Number.parseInt(link.getAttribute('data-line') || '', 10);
    if (!file) return;
    const currentState = state();
    const separator = dependencies.getLocalPathSeparator(currentState.workspaceRoot);
    let fullPath = file;
    if (currentState.workspaceRoot && file.indexOf(':') !== 1) {
      fullPath = String(currentState.workspaceRoot) + separator + file.replace(/\//g, separator);
    }
    const name = file.split(/[/\\]/).pop() || file;
    const workspace = dependencies.getWorkspace();
    if (!workspace || typeof workspace.openFile !== 'function') return;
    Promise.resolve(workspace.openFile(fullPath, name)).then(() => {
      const currentEditor = currentState.editor;
      if (currentEditor && line > 0) {
        currentEditor.revealLineInCenter(line);
        currentEditor.setPosition({ lineNumber: line, column: 1 });
      }
    });
  }

  function bindOutputClickDelegation(outputEl: OutputElement): void {
    if (boundOutputElement === outputEl) return;
    if (boundOutputElement && boundOutputHandler) {
      boundOutputElement.removeEventListener('click', boundOutputHandler);
    }
    boundOutputHandler = onOutputClick;
    boundOutputElement = outputEl;
    outputEl._errLinkBound = true;
    outputEl.addEventListener('click', boundOutputHandler);
    lifecycle.add(toDisposable(() => {
      if (boundOutputElement === outputEl && boundOutputHandler) {
        outputEl.removeEventListener('click', boundOutputHandler);
        boundOutputElement = null;
        boundOutputHandler = null;
      }
    }));
  }

  function flushOutputLines(): void {
    const outputEl = runLogElement();
    const containerEl = outputPanelElement();
    outputFlushTimer = null;
    if (outputEl && renderedOutputCount > 0 && outputEl.childNodes.length === 0) {
      pendingOutputLines = [];
      renderedOutputCount = 0;
      renderedProgramCount = 0;
      renderedDetailCount = 0;
      omittedProgramCount = 0;
      resetOpenOutputRecords();
      return;
    }
    if (!outputEl) {
      dirtyOutputRecords.clear();
      return;
    }

    const wasAtBottom = !containerEl ||
      containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < 50;
    dirtyOutputRecords.forEach((record) => {
      if (record.element) renderOutputRecord(record, record.element);
    });
    dirtyOutputRecords.clear();
    if (pendingOutputLines.length === 0) {
      enforceRenderedOutputLimits(outputEl);
      if (containerEl && (wasAtBottom || state().autoScrollEnabled)) {
        containerEl.scrollTop = containerEl.scrollHeight;
      }
      return;
    }
    const batch = pendingOutputLines;
    pendingOutputLines = [];
    const fragment = documentRef.createDocumentFragment();
    for (const record of batch) {
      const line = documentRef.createElement('span') as OutputElement;
      line.className = 'run-output-line' + (record.kind === 'detail' ? ' run-output-detail' : '');
      line.setAttribute('data-output-kind', record.kind);
      if (record.stage) line.setAttribute('data-output-stage', record.stage);
      if (record.raw && record.raw !== record.text) {
        line.setAttribute('title', record.raw);
        line.setAttribute('aria-label', record.raw);
        line.setAttribute('tabindex', '0');
      }
      record.element = line;
      line._outputRecord = record;
      renderOutputRecord(record, line);
      fragment.appendChild(line);
      if (record.kind === 'detail') renderedDetailCount += 1;
      else renderedProgramCount += 1;
    }
    outputEl.appendChild(fragment);

    enforceRenderedOutputLimits(outputEl);
    bindOutputClickDelegation(outputEl);

    if (containerEl && (wasAtBottom || state().autoScrollEnabled)) {
      containerEl.scrollTop = containerEl.scrollHeight;
    }
  }

  function scheduleOutputFlush(): void {
    if (outputFlushTimer !== null) return;
    outputFlushTimer = dependencies.setTimeout(flushOutputLines, OUTPUT_FLUSH_DELAY_MS);
  }

  function setStreamRecordText(
    record: OutputRecord,
    prefix: string,
    fragmentText: string,
    replace: boolean
  ): boolean {
    const next = replace ? prefix + fragmentText : record.text + fragmentText;
    if (next.length <= MAX_OUTPUT_RECORD_CHARS) {
      const changed = record.text !== next || record.truncated;
      record.text = next;
      record.truncated = false;
      return changed;
    }
    if (record.truncated && !replace) return false;
    record.text = next.slice(0, MAX_OUTPUT_RECORD_CHARS) + ' ' + outputText(
      '[bobocloud] Live output line truncated at {limit} characters.',
      { limit: MAX_OUTPUT_RECORD_CHARS }
    );
    record.truncated = true;
    return true;
  }

  function updateRunOutput(
    message: unknown,
    options?: ServerCommOutputUpdateOptionsDto
  ): void {
    if (disposed) return;
    const currentState = state();
    const outputEl = runLogElement();
    if (outputEl && renderedOutputCount > 0 && outputEl.childNodes.length === 0) {
      pendingOutputLines = [];
      renderedOutputCount = 0;
      renderedProgramCount = 0;
      renderedDetailCount = 0;
      resetOpenOutputRecords();
    }
    if (!currentState.runSessionTimestamp) {
      currentState.runSessionTimestamp = new Date().toLocaleTimeString();
    }
    if (!currentState.runLogInitialized) {
      pendingOutputLines = [];
      const initialOutput = runLogElement();
      if (initialOutput) initialOutput.textContent = '';
      renderedOutputCount = 0;
      resetOpenOutputRecords();
      currentState.runLogInitialized = true;
    }

    const kind = normalizeOutputKind(options);
    const stage = options && options.stage ? String(options.stage) : '';
    const raw = options && options.raw ? String(options.raw) : '';
    if (options && options.streamFragment === true) {
      const streamKey = String(options.streamKey || kind + ':' + stage);
      const existing = openOutputRecords[streamKey];
      const append = options.append === true;
      const replace = options.replace === true;
      const outputPrefix = String(options.outputPrefix || '');
      const fragmentText = String(message);
      const record = (append || replace) && existing ? existing : null;
      if (record) {
        const changed = setStreamRecordText(
          record,
          String(record.timestampPrefix || '') + outputPrefix,
          fragmentText,
          replace
        );
        if (raw) record.raw = raw;
        if (changed && record.element) dirtyOutputRecords.add(record);
      } else {
        const fragmentTimestamp = currentState.showTimestampNextLine
          ? '[' + String(currentState.runSessionTimestamp) + '] '
          : '';
        currentState.showTimestampNextLine = false;
        const nextRecord: OutputRecord = {
          text: fragmentTimestamp + outputPrefix + fragmentText,
          timestampPrefix: fragmentTimestamp,
          kind,
          stage,
          raw,
          streamKey,
          element: null,
          newlineNode: null,
          truncated: false
        };
        setStreamRecordText(nextRecord, '', '', false);
        pendingOutputLines.push(nextRecord);
        openOutputRecords[streamKey] = nextRecord;
        omittedProgramCount += trimPendingKind('program', MAX_OUTPUT_LINES);
        trimPendingKind('detail', MAX_DETAIL_LINES);
        // Keep the const name out of the public surface while allowing the
        // subsequent newline/flush logic to use the same record.
        if (options.newline === true && openOutputRecords[streamKey] === nextRecord) {
          delete openOutputRecords[streamKey];
        }
        if (nextRecord.element) {
          if (options.newline === true) {
            if (outputFlushTimer !== null) {
              dependencies.clearTimeout(outputFlushTimer);
              outputFlushTimer = null;
            }
            flushOutputLines();
          } else {
            scheduleOutputFlush();
          }
        } else if (renderedOutputCount === 0 || pendingOutputLines.length >= OUTPUT_FLUSH_THRESHOLD) {
          if (outputFlushTimer !== null) {
            dependencies.clearTimeout(outputFlushTimer);
            outputFlushTimer = null;
          }
          flushOutputLines();
        } else {
          scheduleOutputFlush();
        }
        return;
      }
      if (options.newline === true && openOutputRecords[streamKey] === record) {
        delete openOutputRecords[streamKey];
      }
      if (record.element) {
        if (options.newline === true) {
          if (outputFlushTimer !== null) {
            dependencies.clearTimeout(outputFlushTimer);
            outputFlushTimer = null;
          }
          flushOutputLines();
        } else {
          scheduleOutputFlush();
        }
      } else if (renderedOutputCount === 0 || pendingOutputLines.length >= OUTPUT_FLUSH_THRESHOLD) {
        if (outputFlushTimer !== null) {
          dependencies.clearTimeout(outputFlushTimer);
          outputFlushTimer = null;
        }
        flushOutputLines();
      } else {
        scheduleOutputFlush();
      }
      return;
    }

    const prefix = currentState.showTimestampNextLine
      ? '[' + String(currentState.runSessionTimestamp) + '] '
      : '';
    currentState.showTimestampNextLine = false;
    const messageLines = String(message).replace(/\r\n?/g, '\n').split('\n');
    for (let index = 0; index < messageLines.length; index += 1) {
      pendingOutputLines.push({
        text: (index === 0 ? prefix : '') + messageLines[index],
        kind,
        stage,
        raw,
        element: null,
        newlineNode: null,
        truncated: false
      });
    }
    omittedProgramCount += trimPendingKind('program', MAX_OUTPUT_LINES);
    trimPendingKind('detail', MAX_DETAIL_LINES);

    // Render the first line immediately so an external clear cannot race an
    // invisible initial batch; subsequent high-volume output stays batched.
    if (renderedOutputCount === 0 || pendingOutputLines.length >= OUTPUT_FLUSH_THRESHOLD) {
      if (outputFlushTimer !== null) {
        dependencies.clearTimeout(outputFlushTimer);
        outputFlushTimer = null;
      }
      flushOutputLines();
    } else {
      scheduleOutputFlush();
    }
  }

  function clearRunOutput(): void {
    if (disposed) return;
    const currentState = state();
    pendingOutputLines = [];
    if (outputFlushTimer !== null) {
      dependencies.clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
    }
    const outputEl = runLogElement();
    if (outputEl) outputEl.textContent = '';
    renderedOutputCount = 0;
    renderedProgramCount = 0;
    renderedDetailCount = 0;
    omittedProgramCount = 0;
    resetOpenOutputRecords();
    currentState.runLogInitialized = true;
    currentState.runSessionTimestamp = new Date().toLocaleTimeString();
    currentState.showTimestampNextLine = true;
    dependencies.getRunOutput()?.clearTranscript?.();
  }

  function clearRunOutputDetails(): void {
    if (disposed) return;
    pendingOutputLines = pendingOutputLines.filter((record) => {
      if (record.kind !== 'detail') return true;
      forgetOpenOutputRecord(record);
      return false;
    });
    const outputEl = runLogElement();
    if (outputEl) {
      for (let index = outputEl.childNodes.length - 1; index >= 0; index -= 1) {
        const child = outputEl.childNodes[index] as OutputElement | undefined;
        if (child && child.getAttribute && child.getAttribute('data-output-kind') === 'detail') {
          forgetOpenOutputRecord(child._outputRecord);
          outputEl.removeChild(child);
        }
      }
      renderedOutputCount = outputEl.childNodes.length;
    }
    renderedDetailCount = 0;
  }

  function refreshRunOutputOmission(): void {
    if (disposed) return;
    updateOmissionMarker(runLogElement());
  }

  // ──── HTTP communication ────
  // opts.quiet: do not write errors to the output panel; return {success:false,
  // error} instead of null (used by login and other UI flows).
  async function sendToServer(
    action: ServerCommActionDto,
    data: Readonly<Record<string, unknown>> = {},
    options: ServerCommRequestOptionsDto = {}
  ): Promise<ServerCommResponseEnvelopeDto | null> {
    if (disposed) return null;
    const currentState = state();
    const opts = options || {};
    const requestData = data || {};
    if (!currentState.serverSettings || !currentState.serverSettings.ip) {
      if (opts.quiet) return { success: false, error: 'Server IP not configured' };
      updateRunOutput('Error: Server IP not configured');
      return null;
    }

    const transport = dependencies.getTransport();
    const url = transport && typeof transport.endpoint === 'function'
      ? transport.endpoint(currentState.serverSettings, 'http')
      : 'http://' + String(currentState.serverSettings.ip) + ':3100';
    const payload: Record<string, unknown> = { action };
    // Merge own enumerable data properties into the action payload. Use the
    // intrinsic helper so null-prototype and user-supplied objects are safe.
    for (const key in requestData) {
      if (Object.prototype.hasOwnProperty.call(requestData, key)) payload[key] = requestData[key];
    }

    const timeoutMs = Number(opts.timeoutMs || 0);
    const externalSignal = opts.signal && typeof opts.signal === 'object'
      ? opts.signal
      : null;
    let abortController: ServerCommAbortController | null = null;
    if ((timeoutMs > 0 || externalSignal) && typeof dependencies.createAbortController === 'function') {
      abortController = dependencies.createAbortController();
    }
    let timeoutHandle: ServerCommTimer | null = null;
    let didTimeout = false;
    let didCancel = false;
    let externalAbortHandler: (() => void) | null = null;
    if (externalSignal && abortController) {
      externalAbortHandler = () => {
        didCancel = true;
        abortController?.abort();
      };
      if (externalSignal.aborted) externalAbortHandler();
      else if (typeof externalSignal.addEventListener === 'function') {
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
      }
    }
    // A caller-provided signal without a deadline must not schedule a zero-ms
    // timeout. The old implementation did so accidentally, racing cancellation.
    if (timeoutMs > 0 && abortController) {
      timeoutHandle = dependencies.setTimeout(() => {
        didTimeout = true;
        abortController?.abort();
      }, timeoutMs);
    }

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // Multi-user sessions take precedence over the API key in settings.
      if (currentState.auth && currentState.auth.token) {
        headers.Authorization = 'Bearer ' + String(currentState.auth.token);
      } else if (currentState.serverSettings.apiKey) {
        headers.Authorization = 'Bearer ' + String(currentState.serverSettings.apiKey);
      }
      const response = await dependencies.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: abortController ? abortController.signal : externalSignal || undefined
      });

      // Reverse proxies and TLS listeners can return plain text or HTML. Never
      // leak a JSON parser exception into workspace/sync workflows.
      let result: unknown;
      if (typeof response.text === 'function') {
        const body = await response.text();
        try {
          result = JSON.parse(body);
        } catch (_parseError) {
          const responseError = invalidResponseMessage(response, body);
          if (opts.quiet) {
            return {
              success: false,
              error: responseError,
              status: response.status,
              errorCode: 'invalid_server_response'
            };
          }
          throw new Error(responseError);
        }
      } else if (typeof response.json === 'function') {
        // Compatibility with lightweight test doubles and older fetch shims.
        result = await response.json();
      } else {
        result = null;
      }

      if (!response.ok) {
        if (response.status === 429 && !opts.quiet) {
          updateRunOutput('Rate limit exceeded - please slow down');
        }
        // Existing token rejected by the server -> credential expired/revoked.
        const auth = dependencies.getAuth();
        if (response.status === 401 && currentState.auth && currentState.auth.token && auth) {
          auth.handleAuthExpired?.();
        }
        const resultRecord = isRecord(result) ? result : null;
        const errMsg = localizeServerError(
          resultRecord && resultRecord.error ? resultRecord.error : 'HTTP ' + response.status
        );
        if (opts.quiet) {
          const failure: Record<string, unknown> = Object.assign(
            {},
            result || {},
            { success: false, error: errMsg, status: response.status }
          );
          const retrySeconds = retryAfterSeconds(response);
          if (retrySeconds) failure.retryAfterSeconds = retrySeconds;
          return failure;
        }
        throw new Error(errMsg);
      }

      if (isRecord(result) && result.error) {
        return Object.assign({}, result, { error: localizeServerError(result.error) });
      }
      // Server actions historically return the decoded JSON value verbatim;
      // retain that open response shape for forward-compatible endpoints.
      return result as ServerCommResponseEnvelopeDto | null;
    } catch (error) {
      if (didTimeout) {
        const timeoutError = localizeServerError('The server request timed out.');
        if (opts.quiet) return { success: false, error: timeoutError, errorCode: 'transport_timeout' };
        updateRunOutput('Error communicating with server: ' + timeoutError);
        return null;
      }
      if (didCancel || Boolean(externalSignal && externalSignal.aborted)) {
        const cancelError = localizeServerError('The server request was cancelled.');
        if (opts.quiet) return { success: false, error: cancelError, errorCode: 'transport_cancelled' };
        return null;
      }
      const localizedError = localizeServerError(stringErrorMessage(error));
      if (opts.quiet) return { success: false, error: localizedError };
      updateRunOutput('Error communicating with server: ' + localizedError);
      return null;
    } finally {
      if (timeoutHandle !== null) dependencies.clearTimeout(timeoutHandle);
      if (externalSignal && externalAbortHandler && typeof externalSignal.removeEventListener === 'function') {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (outputFlushTimer !== null) {
      dependencies.clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
    }
    pendingOutputLines = [];
    dirtyOutputRecords.clear();
    resetOpenOutputRecords();
    lifecycle.dispose();
    cachedRunLogElement = null;
    cachedOutputPanelElement = null;
  }

  const facade: ServerCommFacade = {
    updateRunOutput,
    clearRunOutput,
    clearRunOutputDetails,
    refreshRunOutputOmission,
    sendToServer
  };
  const service: ServerCommService = {
    ...facade,
    get disposed(): boolean { return disposed; },
    dispose
  };
  return Object.freeze(service);
}
