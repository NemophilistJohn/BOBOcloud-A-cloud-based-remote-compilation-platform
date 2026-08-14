// editor-rules/symbol-extractor.js
//
// Lightweight document symbol extraction for IntelliSense-style completion.
// Scans the current document and collects variables, functions, classes,
// structs, typedefs, macros, etc. declared BEFORE the cursor, so typing a
// prefix suggests the user's own identifiers - the way VSCode does without a
// full language server.
//
// Heuristic (regex + line scanning). Prioritises few false positives over full
// coverage; Monaco's built-in word-based suggestions act as a safety net.
(function (global) {
  'use strict';

  function lineCommentFor(lang) {
    return lang === 'python' ? '#' : '//';
  }

  // Remove string/char/raw-string literals and comments so identifiers inside
  // them are not picked up as symbols.
  function sanitize(content, lang) {
    let s = content;
    if (lang === 'go') s = s.replace(/`[^`]*`/g, ' `` ');           // Go raw strings
    if (lang === 'rust') s = s.replace(/r#+"[\s\S]*?"#+/g, function (value) {
      return value.replace(/[^\n]/g, ' ');
    });
    if (lang === 'python') s = s.replace(/(?:"""[\s\S]*?"""|'''[\s\S]*?''')/g, function (value) {
      return value.replace(/[^\n]/g, ' ');
    });
    s = s.replace(/"(?:\\.|[^"\\\n])*"/g, ' "" ');
    s = s.replace(/'(?:\\.|[^'\\\n])*'/g, " '' ");
    s = s.replace(/\/\*[\s\S]*?\*\//g, function (value) {
      return value.replace(/[^\n]/g, ' ');
    });
    const lc = lineCommentFor(lang);
    if (lc === '#') s = s.replace(/#[^\n]*/g, ' ');
    else s = s.replace(/\/\/[^\n]*/g, ' ');
    return s;
  }

  // Join physical lines whose () / [] groups continue onto the next line, so
  // multi-line function signatures are seen as one logical segment. Returns
  // segments tagged with the 1-based line number where each segment starts.
  function joinContinuations(lines) {
    const out = [];
    let buf = '';
    let startLine = 0;
    let parens = 0, brackets = 0;
    let lineNo = 0;
    const flush = function () {
      if (buf !== '') out.push({ text: buf, line: startLine });
      buf = ''; parens = 0; brackets = 0; startLine = 0;
    };
    for (let i = 0; i < lines.length; i++) {
      lineNo = i + 1;
      const ln = lines[i];
      if (buf === '') startLine = lineNo;
      for (let k = 0; k < ln.length; k++) {
        const c = ln[k];
        if (c === '(') parens++;
        else if (c === ')') parens = Math.max(0, parens - 1);
        else if (c === '[') brackets++;
        else if (c === ']') brackets = Math.max(0, brackets - 1);
      }
      buf = buf ? buf + ' ' + ln : ln;
      if (parens === 0 && brackets === 0) flush();
    }
    flush();
    return out;
  }

  const KIND_PRIORITY = {
    variable: 1,
    field: 1,
    property: 1,
    constant: 2,
    function: 3,
    method: 3,
    class: 4,
    struct: 4,
    interface: 4,
    enum: 4,
    typedef: 4,
    module: 5,
    namespace: 5,
    macro: 5
  };

  function pushUnique(syms, seen, name, kind, detail, priority, insertText) {
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    syms.push({
      name: name,
      kind: kind,
      detail: detail || kind,
      priority: priority == null ? (KIND_PRIORITY[kind] || 6) : priority,
      insertText: insertText || name
    });
  }

  function contentIndexAtLine(content, line) {
    if (!line) return content.length;
    let idx = 0, l = 1;
    while (idx < content.length && l < line) {
      if (content[idx] === '\n') l++;
      idx++;
    }
    return idx;
  }

  function splitTopLevel(value) {
    const parts = [];
    let start = 0;
    let angle = 0, paren = 0, bracket = 0, brace = 0;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === '<') angle += 1;
      else if (ch === '>') angle = Math.max(0, angle - 1);
      else if (ch === '(') paren += 1;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '[') bracket += 1;
      else if (ch === ']') bracket = Math.max(0, bracket - 1);
      else if (ch === '{') brace += 1;
      else if (ch === '}') brace = Math.max(0, brace - 1);
      else if (ch === ',' && angle === 0 && paren === 0 && bracket === 0 && brace === 0) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(value.slice(start).trim());
    return parts.filter(Boolean);
  }

  function braceStillOpen(content, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < content.length; i += 1) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) return false;
      }
    }
    return depth > 0;
  }

  function enclosingBraceMatch(content, cursorLine, regex, nameGroup, paramsGroup, rejectName) {
    const clean = sanitize(content, regex.language || 'c');
    const before = clean.slice(0, contentIndexAtLine(clean, cursorLine));
    let match;
    let candidate = null;
    regex.lastIndex = 0;
    while ((match = regex.exec(before))) {
      const openOffset = match[0].lastIndexOf('{');
      const openIndex = match.index + openOffset;
      const name = nameGroup ? match[nameGroup] : '';
      if (openOffset >= 0 && braceStillOpen(before, openIndex) && !(rejectName && rejectName(name))) {
        candidate = {
          name: name,
          params: paramsGroup ? match[paramsGroup] : '',
          groups: Array.from(match),
          open: openIndex,
          start: match.index
        };
      }
      if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
    return candidate;
  }

  function parseCFamilyParams(params) {
    const result = [];
    splitTopLevel(params).forEach(function (raw) {
      const value = raw.replace(/\s*=.*$/, '').trim();
      if (!value || value === 'void' || value === '...') return;
      const functionPointer = /\(\s*[*&]+\s*(\w+)\s*\)/.exec(value);
      const match = functionPointer || /([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\]\s*)?$/.exec(value);
      if (match) result.push({ name: match[1], kind: 'variable', detail: 'parameter: ' + value, priority: 0 });
    });
    return result;
  }

  function parseRustParams(params) {
    const result = [];
    splitTopLevel(params).forEach(function (raw) {
      const value = raw.trim();
      if (!value) return;
      if (/^(?:&\s*(?:'\w+\s*)?)?(?:mut\s+)?self$/.test(value)) {
        result.push({ name: 'self', kind: 'variable', detail: 'method receiver', priority: 0 });
        return;
      }
      const match = /^(?:mut\s+)?(?:ref\s+)?([A-Za-z_][\w]*)\s*:\s*(.+)$/.exec(value);
      if (match) result.push({ name: match[1], kind: 'variable', detail: 'parameter: ' + match[2].trim(), priority: 0 });
    });
    return result;
  }

  function parseGoParams(params) {
    const parts = splitTopLevel(params);
    const result = [];
    let inheritedType = '';
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const value = parts[i].trim();
      const match = /^([A-Za-z_][\w]*)\s+(.+)$/.exec(value);
      if (match) {
        inheritedType = match[2].trim();
        if (match[1] !== '_') result.unshift({ name: match[1], kind: 'variable', detail: 'parameter: ' + inheritedType, priority: 0 });
      } else if (/^[A-Za-z_][\w]*$/.test(value) && inheritedType && value !== '_') {
        result.unshift({ name: value, kind: 'variable', detail: 'parameter: ' + inheritedType, priority: 0 });
      }
    }
    return result;
  }

  function parsePythonParams(params) {
    const result = [];
    splitTopLevel(params).forEach(function (raw) {
      const value = raw.trim();
      if (!value || value === '/' || value === '*') return;
      const match = /^\*{0,2}([A-Za-z_][\w]*)(?:\s*:\s*([^=]+))?/.exec(value);
      if (match) result.push({
        name: match[1],
        kind: 'variable',
        detail: match[2] ? 'parameter: ' + match[2].trim() : 'parameter',
        priority: 0
      });
    });
    return result;
  }

  function enclosingParameters(content, lang, cursorLine) {
    let match = null;
    if (lang === 'c' || lang === 'cpp' || lang === 'java') {
      const regex = /\b([A-Za-z_$~][\w$~]*)\s*\(([^()]*)\)\s*(?:const\s*)?(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:override\s*)?(?:final\s*)?(?:throws\s+[\w.,\s]+)?\s*\{/gm;
      regex.language = lang;
      match = enclosingBraceMatch(content, cursorLine, regex, 1, 2, function (name) { return C_CONTROL.has(name); });
      if (match) return parseCFamilyParams(match.params);
      return [];
    }
    if (lang === 'rust') {
      const regex = /\bfn\s+([A-Za-z_][\w]*)\s*(?:<[^>{}]*>\s*)?\(([^()]*)\)[^{;]*\{/gm;
      regex.language = lang;
      match = enclosingBraceMatch(content, cursorLine, regex, 1, 2);
      return match ? parseRustParams(match.params) : [];
    }
    if (lang === 'go') {
      const regex = /\bfunc\s+(?:\(\s*([^)]*)\)\s*)?([A-Za-z_][\w]*)\s*\(([^()]*)\)[^{]*\{/gm;
      regex.language = lang;
      match = enclosingBraceMatch(content, cursorLine, regex, 2, 3);
      if (!match) return [];
      const locals = parseGoParams(match.params);
      const receiver = match.groups && match.groups[1]
        ? /^([A-Za-z_][\w]*)\s+(.+)$/.exec(match.groups[1].trim())
        : null;
      if (receiver && receiver[1] !== '_') {
        locals.unshift({
          name: receiver[1],
          kind: 'variable',
          detail: 'method receiver: ' + receiver[2].trim(),
          priority: 0
        });
      }
      return locals;
    }
    if (lang === 'python') {
      const lines = sanitize(content, lang).split('\n');
      const end = Math.min(lines.length, Math.max(0, cursorLine - 1));
      let candidate = null;
      for (let i = 0; i < end; i += 1) {
        const functionMatch = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*:/.exec(lines[i]);
        if (functionMatch) {
          candidate = { indent: functionMatch[1].length, params: functionMatch[3] };
          continue;
        }
        if (candidate && lines[i].trim() && /^\s*/.exec(lines[i])[0].length <= candidate.indent) candidate = null;
      }
      return candidate ? parsePythonParams(candidate.params) : [];
    }
    return [];
  }

  function promoteLocals(syms, seen, locals) {
    for (let i = locals.length - 1; i >= 0; i -= 1) {
      const local = locals[i];
      const existing = syms.findIndex(function (symbol) { return symbol.name === local.name; });
      if (existing !== -1) syms.splice(existing, 1);
      seen.add(local.name);
      syms.unshift({
        name: local.name,
        kind: local.kind,
        detail: local.detail,
        priority: local.priority,
        insertText: local.name
      });
    }
  }

  function lineStartsFor(content) {
    const starts = [0];
    for (let i = 0; i < content.length; i += 1) {
      if (content[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  function lineForIndex(starts, index) {
    let low = 0;
    let high = starts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= index) low = middle + 1;
      else high = middle - 1;
    }
    return high + 1;
  }

  function braceFunctionBlocks(clean, lang, starts) {
    let regex;
    let nameGroup;
    if (lang === 'go') {
      regex = /\bfunc\s+(?:\(\s*([^)]*)\)\s*)?([A-Za-z_][\w]*)\s*\(([^()]*)\)[^{]*\{/gm;
      nameGroup = 2;
    } else if (lang === 'rust') {
      regex = /\bfn\s+([A-Za-z_][\w]*)\s*(?:<[^>{}]*>\s*)?\(([^()]*)\)[^{;]*\{/gm;
      nameGroup = 1;
    } else {
      regex = /\b([A-Za-z_$~][\w$~]*)\s*\(([^()]*)\)\s*(?:const\s*)?(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:override\s*)?(?:final\s*)?(?:throws\s+[\w.,\s]+)?\s*\{/gm;
      nameGroup = 1;
    }

    const blocks = [];
    let match;
    while ((match = regex.exec(clean))) {
      const name = match[nameGroup];
      if ((lang === 'c' || lang === 'cpp' || lang === 'java') && C_CONTROL.has(name)) continue;
      const open = match.index + match[0].lastIndexOf('{');
      const matchedEnd = matchingBrace(clean, open);
      const end = matchedEnd === -1 ? clean.length : matchedEnd;
      blocks.push({
        open: open,
        end: end,
        openLine: lineForIndex(starts, open),
        endLine: lineForIndex(starts, end)
      });
    }
    return blocks;
  }

  function pythonFunctionBlocks(clean) {
    const lines = clean.split('\n');
    const blocks = [];
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^(\s*)(?:async\s+)?def\s+[A-Za-z_][\w]*\s*\(/.exec(lines[i]);
      if (!match) continue;
      const indent = match[1].length;
      let endLine = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (!lines[j].trim()) continue;
        const nextIndent = /^\s*/.exec(lines[j])[0].length;
        if (nextIndent <= indent) {
          endLine = j;
          break;
        }
      }
      blocks.push({ openLine: i + 1, endLine: endLine, indent: indent });
    }
    return blocks;
  }

  // Returns whether a declaration on a given line is visible at the cursor.
  // Declarations outside functions remain available as globals/class fields.
  function createScopeFilter(content, lang, cursorLine) {
    const clean = sanitize(content, lang);
    if (lang === 'python') {
      const blocks = pythonFunctionBlocks(clean);
      return function (line) {
        const owners = blocks.filter(function (block) {
          return line > block.openLine && line <= block.endLine;
        }).sort(function (a, b) {
          return b.openLine - a.openLine || b.indent - a.indent;
        });
        if (!owners.length) return true;
        const owner = owners[0];
        return cursorLine > owner.openLine && cursorLine <= owner.endLine;
      };
    }

    const starts = lineStartsFor(clean);
    const blocks = braceFunctionBlocks(clean, lang, starts);
    const cursorIndex = contentIndexAtLine(clean, cursorLine);
    const scopeByLine = [];
    const stack = [];
    let line = 1;
    scopeByLine[line] = null;
    for (let i = 0; i < cursorIndex; i += 1) {
      const ch = clean[i];
      if (ch === '{') stack.push(i);
      else if (ch === '}') stack.pop();
      else if (ch === '\n') {
        line += 1;
        scopeByLine[line] = stack.length ? stack[stack.length - 1] : null;
      }
    }
    const visibleScopes = new Set(stack);

    return function (declarationLine) {
      const owners = blocks.filter(function (block) {
        return declarationLine > block.openLine && declarationLine <= block.endLine;
      }).sort(function (a, b) { return b.open - a.open; });
      if (!owners.length) return true;
      const owner = owners[0];
      if (!(owner.open < cursorIndex && cursorIndex <= owner.end)) return false;
      const declarationScope = scopeByLine[declarationLine];
      return declarationScope == null || visibleScopes.has(declarationScope);
    };
  }

  // ───────────────────────── C / C++ / Java ─────────────────────────
  const C_CONTROL = new Set(['if', 'for', 'while', 'switch', 'do', 'else', 'return',
    'break', 'continue', 'goto', 'case', 'default', 'sizeof', 'typeof', 'catch',
    'try', 'throw', 'new', 'delete', 'static_cast', 'dynamic_cast',
    'reinterpret_cast', 'const_cast']);

  const C_BUILTIN_TYPES = 'int|long|short|char|float|double|void|unsigned|signed|bool|auto|size_t|FILE|wchar_t|u?int\\d+_t|std::\\w+';
  const JAVA_BUILTIN_TYPES = 'int|long|short|byte|char|boolean|float|double|void|String|var';
  const C_MODIFIERS = '(?:static\\s+|inline\\s+|extern\\s+|virtual\\s+|explicit\\s+|friend\\s+|constexpr\\s+|final\\s+|override\\s+|public\\s+|private\\s+|protected\\s+|abstract\\s+|synchronized\\s+|native\\s+|default\\s+|const\\s+|volatile\\s+|register\\s+|mutable\\s+)*';

  function extractCFamily(content, lang, cursorLine) {
    const syms = [];
    const seen = new Set();
    const isJava = lang === 'java';
    const builtinTypes = isJava ? JAVA_BUILTIN_TYPES : C_BUILTIN_TYPES;
    const isVisibleDeclaration = createScopeFilter(content, lang, cursorLine);

    // macros (C/C++) - from original content (sanitize keeps # lines for C/C++)
    if (!isJava) {
      const upTo = cursorLine ? content.slice(0, contentIndexAtLine(content, cursorLine)) : content;
      const macroRe = /^\s*#\s*define\s+(\w+)/gm;
      let mm;
      while ((mm = macroRe.exec(upTo))) {
        pushUnique(syms, seen, mm[1], 'macro', 'preprocessor macro');
      }
    }

    const segments = joinContinuations(sanitize(content, lang).split('\n'));

    // Pass 1: collect user-defined type names (struct/union/enum/class/interface/typedef)
    // so pass 2 can recognise variables of those types (e.g. `Point p;`).
    const userTypes = new Set();
    for (let i = 0; i < segments.length; i++) {
      if (cursorLine && segments[i].line >= cursorLine) continue;
      const line = segments[i].text.trim();
      let m;
      if (isVisibleDeclaration(segments[i].line) && (m = /\b(?:struct|union|enum|class|interface)\s+(\w+)/.exec(line))) {
        userTypes.add(m[1]);
      }
      if (isVisibleDeclaration(segments[i].line) && /^\s*typedef\b/.test(line)) {
        const tm = line.match(/(\w+)\s*;\s*$/);
        if (tm) userTypes.add(tm[1]);
      }
    }
    const typeAlt = '(?:(?:struct|union|enum|class)\\s+\\w+|' + builtinTypes + (userTypes.size ? '|' + Array.from(userTypes).map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') : '') + ')';

    // Pass 2: extract symbols
    for (let i = 0; i < segments.length; i++) {
      if (cursorLine && segments[i].line >= cursorLine) break;
      const line = segments[i].text.trim();
      if (!line) continue;
      let m;

      // struct / union / enum / class / interface NAME
      if ((m = /\b(?:struct|union|enum|class|interface)\s+(\w+)/.exec(line))) {
        if (!isVisibleDeclaration(segments[i].line)) continue;
        const kw = (line.match(/\b(struct|union|enum|class|interface)\b/) || [])[1];
        let kind = 'struct';
        if (kw === 'class') kind = 'class';
        else if (kw === 'interface') kind = 'interface';
        else if (kw === 'enum') kind = 'enum';
        pushUnique(syms, seen, m[1], kind, kw + ' ' + m[1]);
        continue;
      }

      // typedef ... NAME ;
      if (/^\s*typedef\b/.test(line)) {
        if (!isVisibleDeclaration(segments[i].line)) continue;
        const tm = line.match(/(\w+)\s*;\s*$/);
        if (tm) pushUnique(syms, seen, tm[1], 'typedef', 'typedef ' + tm[1]);
        continue;
      }

      // function definition / declaration:  RETTYPE NAME(params)  followed by { or ;
      // (anchored to line start; the prefix before NAME must look like a return type,
      //  so plain function calls like printf(...) are not mistaken for definitions)
      const fm = new RegExp(
        '^' + C_MODIFIERS + '([\\w:<>*&\\s,]+?)\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*' +
        '(?:const\\s*)?(?:noexcept\\s*)?(?:override\\s*)?(?:final\\s*)?(?:throws?\\s+[\\w.,\\s]+\\s*)?' +
        '(\\{|;)'
      ).exec(line);
      if (fm && fm[2] && !C_CONTROL.has(fm[2]) && !/^(if|for|while|switch|return|sizeof)$/.test(fm[2])) {
        const retType = fm[1].trim();
        if (isVisibleDeclaration(segments[i].line) && retType && !/^[\s,;=+\-*/<>!&|^]+$/.test(retType) && !C_CONTROL.has(retType.split(/\s+/).pop())) {
          pushUnique(syms, seen, fm[2], 'function', retType + ' ' + fm[2] + '(' + fm[3].trim() + ')');
          continue;
        }
      }

      // variable declaration: [modifiers] TYPE name [= ...] [, name2 ...] ;
      let variableName = '';
      let typeName = '';
      if (isJava) {
        const javaType = '(?:' + JAVA_BUILTIN_TYPES + '|[A-Z_$][\\w$]*(?:\\s*<[^;=(){}]+>)?)(?:\\s*\\[\\s*\\])*';
        const javaVariable = new RegExp(
          '^' + C_MODIFIERS + '(' + javaType + ')\\s+([A-Za-z_$][\\w$]*)\\s*' +
          '(?:=[^;]*)?(?:\\s*,\\s*[A-Za-z_$][\\w$]*\\s*(?:=[^;,]*)?)*\\s*;\\s*$'
        ).exec(line);
        if (javaVariable) {
          typeName = javaVariable[1].trim();
          variableName = javaVariable[2];
        }
      } else {
        const vm = new RegExp(
          '^' + C_MODIFIERS + typeAlt + '\\b[\\w:<>*&\\s]*?\\b(\\w+)\\s*' +
          '(?:\\[[^\\]]*\\]\\s*)*(?:=[^;]*)?(?:\\s*,\\s*\\w+\\s*(?:\\[[^\\]]*\\]\\s*)*(?:=[^;,]*)?)*\\s*;\\s*$'
        ).exec(line);
        if (vm && vm[1]) {
          variableName = vm[1];
          const typeMatch = line.match(new RegExp(typeAlt));
          typeName = typeMatch ? typeMatch[0].trim() : 'var';
        }
      }
      if (variableName && isVisibleDeclaration(segments[i].line)) {
        pushUnique(syms, seen, variableName, 'variable', typeName + ' ' + variableName);
        // comma-separated declarators: int a, b, c;
        const tail = line.slice(line.indexOf(variableName) + variableName.length, line.lastIndexOf(';'));
        const extras = tail.match(/,\s*([A-Za-z_$][\w$]*)/g);
        if (extras) extras.forEach(function (e) {
          const em = e.match(/([A-Za-z_$][\w$]*)/);
          if (em) pushUnique(syms, seen, em[1], 'variable', typeName + ' ' + em[1]);
        });
      }
    }
    promoteLocals(syms, seen, enclosingParameters(content, lang, cursorLine));
    return syms;
  }

  // ───────────────────────── Python ─────────────────────────
  function extractPython(content, lang, cursorLine) {
    const syms = [];
    const seen = new Set();
    const lines = sanitize(content, lang).split('\n');
    const isVisibleDeclaration = createScopeFilter(content, lang, cursorLine);
    for (let i = 0; i < lines.length; i++) {
      if (cursorLine && i + 1 >= cursorLine) break;
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      let m;

      if ((m = /^\s*def\s+(\w+)/.exec(line))) {
        if (!isVisibleDeclaration(i + 1)) continue;
        pushUnique(syms, seen, m[1], 'function', 'def ' + m[1]); continue;
      }
      if ((m = /^\s*class\s+(\w+)/.exec(line))) {
        if (!isVisibleDeclaration(i + 1)) continue;
        pushUnique(syms, seen, m[1], 'class', 'class ' + m[1]); continue;
      }
      if ((m = /^\s*import\s+(.+)/.exec(line))) {
        if (!isVisibleDeclaration(i + 1)) continue;
        splitTopLevel(m[1]).forEach(function (entry) {
          const imported = /^([\w.]+)(?:\s+as\s+(\w+))?/.exec(entry);
          if (!imported) return;
          const name = imported[2] || imported[1].split('.')[0];
          pushUnique(syms, seen, name, 'module', 'import ' + imported[1], 2);
        });
        continue;
      }
      if ((m = /^\s*from\s+([\w.]+)\s+import\s+(.+)/.exec(line))) {
        if (!isVisibleDeclaration(i + 1)) continue;
        m[2].split(',').forEach(function (n) {
          const nm = n.trim().match(/^(\w+)(?:\s+as\s+(\w+))?/);
          if (nm) pushUnique(syms, seen, nm[2] || nm[1], 'module', 'from ' + m[1] + ' import ' + nm[1], 2);
        });
        continue;
      }
      // assignment: NAME = ...   (skip compound stmts / control keywords)
      if ((m = /^\s*([\w.,\s]+?)\s*(?::\s*[\w.\[\]]+\s*)?=(?!=)/.exec(line))) {
        if (isVisibleDeclaration(i + 1) && !/^\s*(def|class|import|from|if|while|for|elif|else|return|with)\b/.test(line)) {
          m[1].split(',').forEach(function (n) {
            const nm = n.trim().match(/^(\w+)/);
            if (nm && ['self', 'cls', 'True', 'False', 'None'].indexOf(nm[1]) === -1) {
              pushUnique(syms, seen, nm[1], 'variable', nm[1]);
            }
          });
        }
      }
      if ((m = /\bfor\s+(\w+)\s+in\b/.exec(line))) {
        if (isVisibleDeclaration(i + 1)) pushUnique(syms, seen, m[1], 'variable', m[1]);
      }
    }
    promoteLocals(syms, seen, enclosingParameters(content, lang, cursorLine));
    return syms;
  }

  // ───────────────────────── Go ─────────────────────────
  function extractGo(content, lang, cursorLine) {
    const syms = [];
    const seen = new Set();
    const segments = joinContinuations(sanitize(content, lang).split('\n'));
    const isVisibleDeclaration = createScopeFilter(content, lang, cursorLine);
    for (let i = 0; i < segments.length; i++) {
      if (cursorLine && segments[i].line >= cursorLine) break;
      const line = segments[i].text.trim();
      if (!line) continue;
      let m;
      if ((m = /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/.exec(line))) {
        pushUnique(syms, seen, m[1], 'function', 'func ' + m[1]); continue;
      }
      if ((m = /^\s*type\s+(\w+)\s+(struct|interface)/.exec(line))) {
        if (!isVisibleDeclaration(segments[i].line)) continue;
        pushUnique(syms, seen, m[1], m[2] === 'interface' ? 'interface' : 'struct', 'type ' + m[1] + ' ' + m[2]); continue;
      }
      if ((m = /^\s*type\s+(\w+)\b/.exec(line))) {
        if (!isVisibleDeclaration(segments[i].line)) continue;
        pushUnique(syms, seen, m[1], 'typedef', 'type ' + m[1]); continue;
      }
      if ((m = /^\s*var\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'variable', 'var ' + m[1]); continue; }
      if ((m = /^\s*const\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'constant', 'const ' + m[1]); continue; }
      if ((m = /^\s*([\w\s,]+?)\s*:=/.exec(line))) {
        if (isVisibleDeclaration(segments[i].line)) {
          m[1].split(',').forEach(function (name) {
            const cleanName = name.trim();
            if (cleanName !== '_') pushUnique(syms, seen, cleanName, 'variable', 'short variable declaration');
          });
        }
        continue;
      }
    }
    promoteLocals(syms, seen, enclosingParameters(content, lang, cursorLine));
    return syms;
  }

  // ───────────────────────── Rust ─────────────────────────
  function extractRust(content, lang, cursorLine) {
    const syms = [];
    const seen = new Set();
    const segments = joinContinuations(sanitize(content, lang).split('\n'));
    const isVisibleDeclaration = createScopeFilter(content, lang, cursorLine);
    for (let i = 0; i < segments.length; i++) {
      if (cursorLine && segments[i].line >= cursorLine) break;
      const line = segments[i].text.trim();
      if (!line) continue;
      let m;
      if ((m = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'function', 'fn ' + m[1]); continue; }
      if ((m = /^\s*(?:pub\s+)?struct\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'struct', 'struct ' + m[1]); continue; }
      if ((m = /^\s*(?:pub\s+)?enum\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'enum', 'enum ' + m[1]); continue; }
      if ((m = /^\s*(?:pub\s+)?trait\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'interface', 'trait ' + m[1]); continue; }
      if ((m = /^\s*(?:pub\s+)?type\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'typedef', 'type ' + m[1]); continue; }
      if ((m = /^\s*(?:pub\s+)?(?:const|static)\s+(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'constant', m[1]); continue; }
      if ((m = /^\s*let\s+(?:mut\s+)?(\w+)/.exec(line))) { if (isVisibleDeclaration(segments[i].line)) pushUnique(syms, seen, m[1], 'variable', 'let ' + m[1]); continue; }
    }
    promoteLocals(syms, seen, enclosingParameters(content, lang, cursorLine));
    return syms;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function matchingBrace(content, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < content.length; i += 1) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function collectBlocks(content, headerRegex) {
    const blocks = [];
    let match;
    headerRegex.lastIndex = 0;
    while ((match = headerRegex.exec(content))) {
      const openIndex = match.index + match[0].lastIndexOf('{');
      const closeIndex = matchingBrace(content, openIndex);
      if (closeIndex !== -1) {
        blocks.push({
          name: match[1] || '',
          body: content.slice(openIndex + 1, closeIndex),
          start: match.index,
          open: openIndex,
          end: closeIndex
        });
      }
      if (match.index === headerRegex.lastIndex) headerRegex.lastIndex += 1;
    }
    return blocks;
  }

  function depthAt(content, index) {
    let depth = 0;
    for (let i = 0; i < index; i += 1) {
      if (content[i] === '{') depth += 1;
      else if (content[i] === '}') depth = Math.max(0, depth - 1);
    }
    return depth;
  }

  function inferExpressionType(content, lang, expression, cursorLine) {
    const sanitized = sanitize(content, lang);
    const clean = sanitized.slice(0, contentIndexAtLine(sanitized, cursorLine));
    const name = escapeRegExp(expression);
    const candidates = [];
    let match;

    function collect(regex, group) {
      regex.lastIndex = 0;
      while ((match = regex.exec(clean))) {
        candidates.push({ index: match.index, type: match[group] });
        if (match.index === regex.lastIndex) regex.lastIndex += 1;
      }
    }

    if (lang === 'rust') {
      if (expression === 'self') {
        const impl = enclosingBraceMatch(content, cursorLine, /\bimpl(?:\s*<[^>{}]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)[^{}]*\{/gm, 1, 0);
        if (impl) return impl.name;
      }
      collect(new RegExp('\\blet\\s+(?:mut\\s+)?' + name + '\\s*:\\s*([A-Za-z_][\\w:]*(?:\\s*<[^;=]+>)?)', 'g'), 1);
      collect(new RegExp('\\blet\\s+(?:mut\\s+)?' + name + '\\s*=\\s*([A-Za-z_][\\w:]*)\\s*(?:::|\\{)', 'g'), 1);
      collect(new RegExp('\\b' + name + '\\s*:\\s*([A-Za-z_][\\w:]*(?:\\s*<[^,)=]+>)?)', 'g'), 1);
    } else if (lang === 'go') {
      collect(new RegExp('\\b(?:var\\s+)?' + name + '\\s+\\*?([A-Za-z_][\\w.]*)', 'g'), 1);
      collect(new RegExp('\\b' + name + '\\s*:=\\s*(?:&)?([A-Za-z_][\\w.]*)\\s*\\{', 'g'), 1);
    } else {
      if (expression === 'this' && (lang === 'cpp' || lang === 'java')) {
        const classMatch = enclosingBraceMatch(content, cursorLine, /\bclass\s+([A-Za-z_$][\w$]*)[^;{]*\{/gm, 1, 0);
        if (classMatch) return classMatch.name;
      }
      const typePattern = '((?:(?:struct|class)\\s+)?[A-Za-z_$][\\w$:]*(?:\\s*<[^;=(){}]+>)?)';
      collect(new RegExp('\\b' + typePattern + '\\s*[*&]*\\s+' + name + '\\b', 'g'), 1);
      collect(new RegExp('\\bauto\\s+' + name + '\\s*=\\s*(?:std::)?([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?)', 'g'), 1);
    }

    if (!candidates.length) return '';
    candidates.sort(function (a, b) { return b.index - a.index; });
    return candidates[0].type.trim().replace(/^(?:struct|class)\s+/, '');
  }

  function methodInsertText(name, params, lang) {
    let parsed = [];
    if (lang === 'rust') parsed = parseRustParams(params).filter(function (p) { return p.name !== 'self'; });
    else if (lang === 'go') parsed = parseGoParams(params);
    else parsed = parseCFamilyParams(params);
    const placeholders = parsed.map(function (param, index) {
      return '${' + (index + 1) + ':' + param.name + '}';
    });
    return name + '(' + placeholders.join(', ') + ')';
  }

  function addCFamilyMembers(result, seen, clean, typeName, lang) {
    const baseType = typeName.replace(/<[^>]*>/g, '').split('::').pop().trim();
    const typePattern = escapeRegExp(baseType);
    const namedBlocks = collectBlocks(clean, new RegExp('\\b(?:struct|class)\\s+(' + typePattern + ')\\b[^;{]*\\{', 'gm'));
    const typedefBlocks = collectBlocks(clean, /\btypedef\s+struct(?:\s+\w+)?\s*\{/gm).filter(function (block) {
      const tail = clean.slice(block.end + 1, block.end + 100);
      return new RegExp('^\\s*' + typePattern + '\\s*;').test(tail);
    });

    namedBlocks.concat(typedefBlocks).forEach(function (block) {
      let match;
      const methodRegex = /\b([A-Za-z_$~][\w$~]*)\s*\(([^()]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:;|\{)/g;
      while ((match = methodRegex.exec(block.body))) {
        if (depthAt(block.body, match.index) !== 0 || C_CONTROL.has(match[1])) continue;
        pushUnique(result, seen, match[1], 'method', 'method: ' + match[1] + '(' + match[2].trim() + ')', 0,
          methodInsertText(match[1], match[2], lang));
      }

      const fieldRegex = /(?:^|[;}]|\n)\s*(?:(?:public|private|protected)\s*:\s*)?(?:static\s+)?(?:const\s+)?([A-Za-z_$][\w$:<>,*&\s]*)\s+([A-Za-z_$][\w$]*)\s*(?:\[[^\]]*\])?\s*(?:=[^;]*)?;/gm;
      while ((match = fieldRegex.exec(block.body))) {
        if (depthAt(block.body, match.index) === 0) {
          pushUnique(result, seen, match[2], 'field', 'field: ' + match[1].trim(), 0);
        }
        // Keep the delimiter available as the start boundary of the next field
        // when declarations share one physical line (for example: int x; int y;).
        fieldRegex.lastIndex = Math.max(match.index + 1, fieldRegex.lastIndex - 1);
      }
    });
  }

  function addRustMembers(result, seen, clean, typeName) {
    const baseType = typeName.replace(/<[^>]*>/g, '').split('::').pop().trim();
    const typePattern = escapeRegExp(baseType);
    collectBlocks(clean, new RegExp('\\bstruct\\s+(' + typePattern + ')\\b[^;{]*\\{', 'gm')).forEach(function (block) {
      let match;
      const fieldRegex = /(?:^|,)\s*(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_][\w]*)\s*:\s*([^,}]+)/gm;
      while ((match = fieldRegex.exec(block.body))) {
        pushUnique(result, seen, match[1], 'field', 'field: ' + match[2].trim(), 0);
      }
    });

    collectBlocks(clean, /\bimpl(?:\s*<[^>{}]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:]*)[^{}]*\{/gm)
      .filter(function (block) { return block.name.split('::').pop() === baseType; })
      .forEach(function (block) {
        let match;
        const methodRegex = /\bfn\s+([A-Za-z_][\w]*)\s*(?:<[^>{}]*>)?\s*\(([^()]*)\)/gm;
        while ((match = methodRegex.exec(block.body))) {
          if (depthAt(block.body, match.index) !== 0) continue;
          pushUnique(result, seen, match[1], 'method', 'method: fn ' + match[1] + '(' + match[2].trim() + ')', 0,
            methodInsertText(match[1], match[2], 'rust'));
        }
      });
  }

  const STANDARD_MEMBERS = {
    cpp: {
      vector: [['size', 'size()', false], ['empty', 'empty()', false], ['push_back', 'push_back(value)', true], ['emplace_back', 'emplace_back(value)', true], ['begin', 'begin()', false], ['end', 'end()', false], ['clear', 'clear()', false], ['reserve', 'reserve(capacity)', true], ['at', 'at(index)', true], ['front', 'front()', false], ['back', 'back()', false], ['data', 'data()', false]],
      string: [['size', 'size()', false], ['empty', 'empty()', false], ['substr', 'substr(position, count)', true], ['find', 'find(value)', true], ['append', 'append(value)', true], ['c_str', 'c_str()', false], ['clear', 'clear()', false]],
      map: [['size', 'size()', false], ['empty', 'empty()', false], ['find', 'find(key)', true], ['contains', 'contains(key)', true], ['erase', 'erase(key)', true], ['begin', 'begin()', false], ['end', 'end()', false], ['clear', 'clear()', false]]
    },
    rust: {
      Vec: [['len', 'len()', false], ['is_empty', 'is_empty()', false], ['push', 'push(value)', true], ['pop', 'pop()', false], ['iter', 'iter()', false], ['iter_mut', 'iter_mut()', false], ['get', 'get(index)', true], ['sort', 'sort()', false], ['contains', 'contains(value)', true]],
      String: [['len', 'len()', false], ['is_empty', 'is_empty()', false], ['push_str', 'push_str(value)', true], ['as_str', 'as_str()', false], ['chars', 'chars()', false], ['clear', 'clear()', false]],
      Option: [['is_some', 'is_some()', false], ['is_none', 'is_none()', false], ['unwrap', 'unwrap()', false], ['expect', 'expect(message)', true], ['map', 'map(function)', true], ['and_then', 'and_then(function)', true], ['unwrap_or', 'unwrap_or(default)', true]],
      Result: [['is_ok', 'is_ok()', false], ['is_err', 'is_err()', false], ['unwrap', 'unwrap()', false], ['expect', 'expect(message)', true], ['map', 'map(function)', true], ['map_err', 'map_err(function)', true], ['and_then', 'and_then(function)', true]]
    }
  };

  function addStandardMembers(result, seen, lang, typeName) {
    const groups = STANDARD_MEMBERS[lang];
    if (!groups) return;
    Object.keys(groups).forEach(function (key) {
      const matches = lang === 'cpp'
        ? new RegExp('(?:^|::|_)' + key + '(?:\\s*<|$)', 'i').test(typeName)
        : new RegExp('(?:^|::)' + key + '(?:\\s*<|$)').test(typeName);
      if (!matches) return;
      groups[key].forEach(function (member) {
        const insertText = member[2] ? member[0] + '(${1:value})' : member[0] + '()';
        pushUnique(result, seen, member[0], 'method', key + '::' + member[1], 1, insertText);
      });
    });
  }

  function extractMembers(content, lang, expression, cursorLine) {
    try {
      const typeName = inferExpressionType(content, lang, expression, cursorLine || 0);
      if (!typeName) return [];
      const result = [];
      const seen = new Set();
      const clean = sanitize(content, lang);
      if (lang === 'rust') addRustMembers(result, seen, clean, typeName);
      else if (lang === 'c' || lang === 'cpp' || lang === 'java') addCFamilyMembers(result, seen, clean, typeName, lang);
      addStandardMembers(result, seen, lang, typeName);
      return result;
    } catch (_error) {
      return [];
    }
  }

  const EXTRACTORS = {
    c: extractCFamily,
    cpp: extractCFamily,
    java: extractCFamily,
    python: extractPython,
    go: extractGo,
    rust: extractRust
  };

  function extract(content, lang, cursorLine) {
    const fn = EXTRACTORS[lang];
    if (!fn) return [];
    try { return fn(content, lang, cursorLine || 0); } catch (e) { return []; }
  }

  global.symbolExtractor = { extract: extract, extractMembers: extractMembers };
})(typeof window !== 'undefined' ? window : globalThis);
