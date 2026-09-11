import type {
  AiMarkdownDependencies,
  AiMarkdownFacade,
  AiMarkdownRenderOptions,
  AiMarkdownRenderer
} from '../types/ai-markdown';

function createAiMarkdownRenderer(
  dependencies: AiMarkdownDependencies
): AiMarkdownRenderer {
  const { document } = dependencies;

  function translate(key: string): string {
    return dependencies.getI18n()?.t(key) ?? key;
  }

  function appendText(parent: Node, value: string): void {
    parent.appendChild(document.createTextNode(value));
  }

  function safeLink(value: string): string {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function renderMath(tex: string, displayMode: boolean): HTMLElement {
    const node = document.createElement(displayMode ? 'div' : 'span');
    node.className = displayMode ? 'ai-math-block' : 'ai-math-inline';
    node.setAttribute('role', 'math');
    try {
      const temml = dependencies.getTemml();
      if (!temml || typeof temml.renderToString !== 'function') throw new Error('Temml unavailable');
      node.innerHTML = temml.renderToString(String(tex || ''), {
        displayMode,
        throwOnError: false,
        trust: false,
        maxExpand: 1000,
        strict: false
      });
    } catch (_) {
      node.textContent = (displayMode ? '$$' : '$') + tex + (displayMode ? '$$' : '$');
    }
    return node;
  }

  function renderInline(parent: Node, source: unknown): void {
    const text = String(source || '');
    const pattern = /(`[^`\n]+`|\\\([^\n]*?\\\)|\$[^$\n]+\$|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) appendText(parent, text.slice(cursor, match.index));
      const token = match[0];
      if (token[0] === '`') {
        const code = document.createElement('code');
        code.className = 'ai-inline-code';
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.slice(0, 2) === '\\(') {
        parent.appendChild(renderMath(token.slice(2, -2), false));
      } else if (token[0] === '$') {
        parent.appendChild(renderMath(token.slice(1, -1), false));
      } else if (token.slice(0, 2) === '**') {
        const strong = document.createElement('strong');
        renderInline(strong, token.slice(2, -2));
        parent.appendChild(strong);
      } else if (token[0] === '*') {
        const emphasis = document.createElement('em');
        renderInline(emphasis, token.slice(1, -1));
        parent.appendChild(emphasis);
      } else {
        const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        const href = linkMatch ? safeLink(linkMatch[2] || '') : '';
        if (href && linkMatch) {
          const link = document.createElement('a');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = linkMatch[1] || '';
          parent.appendChild(link);
        } else {
          appendText(parent, token);
        }
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < text.length) appendText(parent, text.slice(cursor));
  }

  function copyCode(button: HTMLButtonElement, code: string): void {
    const clipboard = dependencies.getClipboard();
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    void clipboard.writeText(code).then(() => {
      button.classList.add('copied');
      const label = button.querySelector('span');
      if (label) label.textContent = translate('Copied');
      dependencies.setTimer(() => {
        if (!button.isConnected) return;
        button.classList.remove('copied');
        const resetLabel = button.querySelector('span');
        if (resetLabel) resetLabel.textContent = translate('Copy code');
      }, 1600);
    }).catch(() => undefined);
  }

  function codeBlock(language: string, code: string): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'ai-code-block';
    const head = document.createElement('div');
    head.className = 'ai-code-head';
    const label = document.createElement('span');
    label.className = 'ai-code-lang';
    label.textContent = language || translate('Code');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ai-code-copy';
    copy.title = translate('Copy code');
    copy.setAttribute('aria-label', translate('Copy code'));
    copy.innerHTML = (dependencies.getIcons()?.copy || '') + '<span></span>';
    const copyLabel = copy.querySelector('span');
    if (copyLabel) copyLabel.textContent = translate('Copy code');
    copy.addEventListener('click', () => copyCode(copy, code));
    head.append(label, copy);
    const pre = document.createElement('pre');
    const content = document.createElement('code');
    content.textContent = code;
    pre.appendChild(content);
    root.append(head, pre);
    return root;
  }

  function paragraph(lines: readonly string[]): HTMLParagraphElement {
    const node = document.createElement('p');
    lines.forEach((line, index) => {
      if (index) node.appendChild(document.createElement('br'));
      renderInline(node, line);
    });
    return node;
  }

  function render(
    container: HTMLElement,
    markdown: unknown,
    options: AiMarkdownRenderOptions = {}
  ): void {
    const renderOptions = options || {};
    container.replaceChildren();
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] || '';
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const fence = /^```\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const codeLines: string[] = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index] || '')) {
          codeLines.push(lines[index] || '');
          index += 1;
        }
        if (index < lines.length) index += 1;
        container.appendChild(codeBlock(fence[1] || '', codeLines.join('\n')));
        continue;
      }
      if (/^\$\$\s*$/.test(line) || /^\\\[\s*$/.test(line)) {
        const bracket = line.trim().slice(0, 2) === '\\[';
        const formula: string[] = [];
        index += 1;
        while (
          index < lines.length &&
          !(bracket ? /^\s*\\\]\s*$/.test(lines[index] || '') : /^\s*\$\$\s*$/.test(lines[index] || ''))
        ) {
          formula.push(lines[index] || '');
          index += 1;
        }
        if (index < lines.length) index += 1;
        container.appendChild(renderMath(formula.join('\n'), true));
        continue;
      }
      const oneLineMath = /^\$\$(.+)\$\$$/.exec(line.trim());
      if (oneLineMath) {
        container.appendChild(renderMath(oneLineMath[1] || '', true));
        index += 1;
        continue;
      }
      const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        const headingLevel = Math.min((heading[1] || '').length + 2, 6);
        const headingElement = document.createElement('h' + headingLevel) as HTMLHeadingElement;
        renderInline(headingElement, heading[2]);
        container.appendChild(headingElement);
        index += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = document.createElement('blockquote');
        const quoteLines: string[] = [];
        while (index < lines.length && /^>\s?/.test(lines[index] || '')) {
          quoteLines.push((lines[index] || '').replace(/^>\s?/, ''));
          index += 1;
        }
        quote.appendChild(paragraph(quoteLines));
        container.appendChild(quote);
        continue;
      }
      const listMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
      if (listMatch) {
        const ordered = Boolean(listMatch[2]);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (index < lines.length) {
          const itemMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index] || '');
          if (!itemMatch || Boolean(itemMatch[2]) !== ordered) break;
          const item = document.createElement('li');
          renderInline(item, itemMatch[3]);
          list.appendChild(item);
          index += 1;
        }
        container.appendChild(list);
        continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
        container.appendChild(document.createElement('hr'));
        index += 1;
        continue;
      }
      const paragraphLines: string[] = [line];
      index += 1;
      while (
        index < lines.length &&
        (lines[index] || '').trim() &&
        !/^```/.test(lines[index] || '') &&
        !/^\$\$\s*$/.test(lines[index] || '') &&
        !/^\\\[\s*$/.test(lines[index] || '') &&
        !/^(#{1,4})\s+/.test(lines[index] || '') &&
        !/^>\s?/.test(lines[index] || '') &&
        !/^\s*(?:([-+*])|(\d+)\.)\s+/.test(lines[index] || '')
      ) {
        paragraphLines.push(lines[index] || '');
        index += 1;
      }
      container.appendChild(paragraph(paragraphLines));
    }
    if (renderOptions.streaming) {
      const streamingCursor = document.createElement('span');
      streamingCursor.className = 'ai-cursor-blink';
      streamingCursor.textContent = '\u258c';
      container.appendChild(streamingCursor);
    }
  }

  const facade: AiMarkdownFacade = { render };
  return facade;
}

export { createAiMarkdownRenderer };
export default createAiMarkdownRenderer;
