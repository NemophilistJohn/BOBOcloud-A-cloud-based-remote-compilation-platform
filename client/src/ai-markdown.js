// Safe, lightweight Markdown and TeX renderer for AI responses.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};

  function t(key) {
    return BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(key) : key;
  }

  function appendText(parent, value) {
    parent.appendChild(document.createTextNode(value));
  }

  function safeLink(value) {
    try {
      var url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (_) { return ''; }
  }

  function renderMath(tex, displayMode) {
    var node = document.createElement(displayMode ? 'div' : 'span');
    node.className = displayMode ? 'ai-math-block' : 'ai-math-inline';
    node.setAttribute('role', 'math');
    try {
      if (!global.temml || typeof global.temml.renderToString !== 'function') throw new Error('Temml unavailable');
      node.innerHTML = global.temml.renderToString(String(tex || ''), {
        displayMode: displayMode, throwOnError: false, trust: false,
        maxExpand: 1000, strict: false
      });
    } catch (_) {
      node.textContent = (displayMode ? '$$' : '$') + tex + (displayMode ? '$$' : '$');
    }
    return node;
  }

  function renderInline(parent, source) {
    source = String(source || '');
    var pattern = /(`[^`\n]+`|\\\([^\n]*?\\\)|\$[^$\n]+\$|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    var cursor = 0;
    var match;
    while ((match = pattern.exec(source))) {
      if (match.index > cursor) appendText(parent, source.slice(cursor, match.index));
      var token = match[0];
      if (token[0] === '`') {
        var code = document.createElement('code');
        code.className = 'ai-inline-code';
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.slice(0, 2) === '\\(') {
        parent.appendChild(renderMath(token.slice(2, -2), false));
      } else if (token[0] === '$') {
        parent.appendChild(renderMath(token.slice(1, -1), false));
      } else if (token.slice(0, 2) === '**') {
        var strong = document.createElement('strong');
        renderInline(strong, token.slice(2, -2));
        parent.appendChild(strong);
      } else if (token[0] === '*') {
        var em = document.createElement('em');
        renderInline(em, token.slice(1, -1));
        parent.appendChild(em);
      } else {
        var linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        var href = linkMatch && safeLink(linkMatch[2]);
        if (href) {
          var link = document.createElement('a');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = linkMatch[1];
          parent.appendChild(link);
        } else appendText(parent, token);
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < source.length) appendText(parent, source.slice(cursor));
  }

  function copyCode(button, code) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(code).then(function() {
      button.classList.add('copied');
      button.querySelector('span').textContent = t('Copied');
      setTimeout(function() {
        if (!button.isConnected) return;
        button.classList.remove('copied');
        button.querySelector('span').textContent = t('Copy code');
      }, 1600);
    }).catch(function() {});
  }

  function codeBlock(language, code) {
    var root = document.createElement('div');
    root.className = 'ai-code-block';
    var head = document.createElement('div');
    head.className = 'ai-code-head';
    var label = document.createElement('span');
    label.className = 'ai-code-lang';
    label.textContent = language || t('Code');
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ai-code-copy';
    copy.title = t('Copy code');
    copy.setAttribute('aria-label', t('Copy code'));
    copy.innerHTML = (BOBO.icons && BOBO.icons.copy || '') + '<span></span>';
    copy.querySelector('span').textContent = t('Copy code');
    copy.addEventListener('click', function() { copyCode(copy, code); });
    head.append(label, copy);
    var pre = document.createElement('pre');
    var content = document.createElement('code');
    content.textContent = code;
    pre.appendChild(content);
    root.append(head, pre);
    return root;
  }

  function paragraph(lines) {
    var node = document.createElement('p');
    lines.forEach(function(line, index) {
      if (index) node.appendChild(document.createElement('br'));
      renderInline(node, line);
    });
    return node;
  }

  function render(container, markdown, options) {
    options = options || {};
    container.replaceChildren();
    var lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    var index = 0;
    while (index < lines.length) {
      var line = lines[index];
      if (!line.trim()) { index++; continue; }
      var fence = /^```\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        var codeLines = [];
        index++;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index++;
        container.appendChild(codeBlock(fence[1], codeLines.join('\n')));
        continue;
      }
      if (/^\$\$\s*$/.test(line) || /^\\\[\s*$/.test(line)) {
        var bracket = line.trim().slice(0, 2) === '\\[';
        var formula = [];
        index++;
        while (index < lines.length && !(bracket ? /^\s*\\\]\s*$/.test(lines[index]) : /^\s*\$\$\s*$/.test(lines[index]))) formula.push(lines[index++]);
        if (index < lines.length) index++;
        container.appendChild(renderMath(formula.join('\n'), true));
        continue;
      }
      var oneLineMath = /^\$\$(.+)\$\$$/.exec(line.trim());
      if (oneLineMath) { container.appendChild(renderMath(oneLineMath[1], true)); index++; continue; }
      var heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) {
        var h = document.createElement('h' + Math.min(heading[1].length + 2, 6));
        renderInline(h, heading[2]);
        container.appendChild(h);
        index++;
        continue;
      }
      if (/^>\s?/.test(line)) {
        var quote = document.createElement('blockquote');
        var quoteLines = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) quoteLines.push(lines[index++].replace(/^>\s?/, ''));
        quote.appendChild(paragraph(quoteLines));
        container.appendChild(quote);
        continue;
      }
      var listMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(line);
      if (listMatch) {
        var ordered = Boolean(listMatch[2]);
        var list = document.createElement(ordered ? 'ol' : 'ul');
        while (index < lines.length) {
          var itemMatch = /^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/.exec(lines[index]);
          if (!itemMatch || Boolean(itemMatch[2]) !== ordered) break;
          var item = document.createElement('li');
          renderInline(item, itemMatch[3]);
          list.appendChild(item);
          index++;
        }
        container.appendChild(list);
        continue;
      }
      if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { container.appendChild(document.createElement('hr')); index++; continue; }
      var paragraphLines = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !/^```/.test(lines[index]) &&
        !/^\$\$\s*$/.test(lines[index]) && !/^\\\[\s*$/.test(lines[index]) &&
        !/^(#{1,4})\s+/.test(lines[index]) && !/^>\s?/.test(lines[index]) &&
        !/^\s*(?:([-+*])|(\d+)\.)\s+/.test(lines[index])) paragraphLines.push(lines[index++]);
      container.appendChild(paragraph(paragraphLines));
    }
    if (options.streaming) {
      var streamingCursor = document.createElement('span');
      streamingCursor.className = 'ai-cursor-blink';
      streamingCursor.textContent = '\u258c';
      container.appendChild(streamingCursor);
    }
  }

  BOBO.aiMarkdown = { render: render };
})(window);
