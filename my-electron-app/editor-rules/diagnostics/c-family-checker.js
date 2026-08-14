// editor-rules/diagnostics/c-family-checker.js
//
// Structural syntax checker for C-family languages (C / C++ / Java).
//
// This replaces the old line-regex "missing semicolon" heuristic which could not
// understand syntax: it flagged `for (...)` / `if (...)` headers as missing
// semicolons (false positive) and silently ignored stray garbage at file scope
// (false negative).
//
// Approach: a real tokenizer + a statement-boundary scanner that understands
//   - control-flow headers (if/for/while/switch/do) do NOT need a ';'
//   - function definitions (`int foo() { ... }`) do NOT need a ';'
//   - struct/enum/union/class bodies need a ';' (or declarators) in C/C++, not in Java
//   - blocks, labels, case/default, goto, do-while
//   - file-scope validation (a bare number / operator / 'return' at file scope is an error)
//
// The scanner is NOT a full C parser — it is a statement-boundary tracker. It is
// intentionally conservative: it only reports an error when it is confident, so it
// favours fewer false positives over catching every theoretical mistake.
(function (global) {
  'use strict';

  // ───────────────────────────── Keywords ─────────────────────────────
  const KEYWORDS = new Set([
    // C
    'int', 'char', 'float', 'double', 'long', 'short', 'void', 'unsigned', 'signed',
    'const', 'static', 'extern', 'volatile', 'register', 'auto', 'inline', 'restrict',
    'struct', 'union', 'enum', 'typedef', '_Bool', '_Complex', '_Atomic', '_Alignas', '_Alignof',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'goto', 'sizeof', '_Generic', '_Noreturn',
    // C++
    'bool', 'class', 'namespace', 'template', 'typename', 'constexpr', 'nullptr', 'decltype',
    'public', 'private', 'protected', 'virtual', 'override', 'final', 'new', 'delete',
    'using', 'this', 'throw', 'try', 'catch', 'operator', 'explicit', 'friend', 'mutable',
    'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast', 'co_await', 'co_return', 'co_yield',
    // Java
    'boolean', 'byte', 'abstract', 'interface', 'extends', 'implements', 'package', 'import',
    'instanceof', 'super', 'synchronized', 'transient', 'native', 'strictfp', 'assert',
    'true', 'false', 'null', 'var', 'record', 'sealed', 'permits', 'yield'
  ]);

  // Keywords that introduce a control-flow header whose `( ... )` is part of the
  // header (so the header itself does NOT end with a semicolon).
  const CONTROL_HEADERS = new Set(['if', 'for', 'while', 'switch']);

  // Clause / statement-starting keywords that can never appear inside an
  // expression. If the statement collector meets one at paren-depth 0, the
  // current statement should already have been terminated with ';'.
  const CLAUSE_KEYWORDS = new Set([
    'else', 'case', 'default', 'catch', 'finally',
    'return', 'break', 'continue', 'goto',
    'if', 'for', 'while', 'switch', 'do', 'try'
  ]);

  // Keywords that are invalid as the start of a file-scope construct.
  const FILESCOPE_INVALID_KEYWORDS = new Set([
    'return', 'break', 'continue', 'goto', 'case', 'default',
    'if', 'else', 'for', 'while', 'switch', 'do',
    'try', 'catch', 'finally', 'throw', 'this', 'super', 'new', 'delete',
    'sizeof', 'yield'
  ]);

  // Type / storage keywords that can validly begin a file-scope declaration.
  // (Used only for nicer messages; anything not in FILESCOPE_INVALID_KEYWORDS
  //  and not a literal/operator is allowed to attempt a declaration.)
  const DECL_START_KEYWORDS = new Set([
    'int', 'char', 'float', 'double', 'long', 'short', 'void', 'unsigned', 'signed',
    'const', 'static', 'extern', 'volatile', 'register', 'auto', 'inline', 'restrict',
    'struct', 'union', 'enum', 'typedef', '_Bool', '_Atomic', '_Alignas',
    'bool', 'class', 'namespace', 'template', 'typename', 'constexpr', 'decltype',
    'using', 'public', 'private', 'protected', 'virtual', 'friend', 'mutable', 'operator', 'explicit',
    'boolean', 'byte', 'abstract', 'interface', 'final', 'native', 'strictfp', 'synchronized', 'transient',
    'package', 'import', 'record', 'sealed', 'permits'
  ]);

  const PUNCT2 = new Set([
    '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '::', '->*', '.*'
  ]);
  const PUNCT3 = new Set(['...', '<<=', '>>=']);

  // ───────────────────────────── Tokenizer ─────────────────────────────
  // Produces tokens: { type, value, line, col }
  //   type ∈ 'ident' | 'keyword' | 'number' | 'string' | 'char' | 'punct' | 'preproc' | 'unknown'
  function tokenize(src) {
    const tokens = [];
    const n = src.length;
    let i = 0, line = 1, col = 1;
    let onlyWsSinceNewline = true; // for preprocessor detection

    function adv(count) {
      for (let k = 0; k < count; k++) {
        if (src[i] === '\n') { line++; col = 1; } else { col++; }
        i++;
      }
    }

    while (i < n) {
      const ch = src[i];

      // whitespace
      if (ch === ' ' || ch === '\t' || ch === '\r') { adv(1); continue; }
      if (ch === '\n') { adv(1); onlyWsSinceNewline = true; continue; }

      // line comment
      if (ch === '/' && src[i + 1] === '/') {
        while (i < n && src[i] !== '\n') adv(1);
        continue;
      }
      // block comment
      if (ch === '/' && src[i + 1] === '*') {
        onlyWsSinceNewline = false;
        adv(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv(1);
        if (i < n) adv(2);
        continue;
      }

      // preprocessor (C/C++): '#' as first non-ws char of a logical line
      if (ch === '#' && onlyWsSinceNewline) {
        onlyWsSinceNewline = false;
        // skip the whole logical line, honoring backslash line-continuation
        while (i < n) {
          if (src[i] === '\\' && src[i + 1] === '\n') { adv(2); continue; }
          if (src[i] === '\n') break;
          // skip string/char contents inside the directive so a '#' or ';' inside
          // a string doesn't confuse us (rare, but cheap to handle)
          if (src[i] === '"' || src[i] === "'") {
            const q = src[i]; adv(1);
            while (i < n && src[i] !== q && src[i] !== '\n') {
              if (src[i] === '\\') { adv(2); continue; }
              adv(1);
            }
            continue;
          }
          adv(1);
        }
        continue;
      }

      // string literal
      if (ch === '"') {
        const sl = line, sc = col;
        onlyWsSinceNewline = false;
        adv(1);
        while (i < n && src[i] !== '"') {
          if (src[i] === '\\') { adv(2); continue; }
          if (src[i] === '\n') break; // unterminated; let the unclosed-string helper report
          adv(1);
        }
        if (i < n && src[i] === '"') adv(1);
        tokens.push({ type: 'string', value: '"', line: sl, col: sc });
        continue;
      }
      // char literal
      if (ch === "'") {
        const sl = line, sc = col;
        onlyWsSinceNewline = false;
        adv(1);
        while (i < n && src[i] !== "'") {
          if (src[i] === '\\') { adv(2); continue; }
          if (src[i] === '\n') break;
          adv(1);
        }
        if (i < n && src[i] === "'") adv(1);
        tokens.push({ type: 'char', value: "'", line: sl, col: sc });
        continue;
      }

      // number
      if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        const sl = line, sc = col;
        onlyWsSinceNewline = false;
        if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          adv(2);
          while (i < n && /[0-9a-fA-F]/.test(src[i])) adv(1);
        } else {
          while (i < n && src[i] >= '0' && src[i] <= '9') adv(1);
          if (src[i] === '.') { adv(1); while (i < n && src[i] >= '0' && src[i] <= '9') adv(1); }
          if (src[i] === 'e' || src[i] === 'E') {
            adv(1); if (src[i] === '+' || src[i] === '-') adv(1);
            while (i < n && src[i] >= '0' && src[i] <= '9') adv(1);
          }
        }
        // numeric suffixes and digit separators
        while (i < n && /[uUlLfF]/.test(src[i])) adv(1);
        tokens.push({ type: 'number', value: '0', line: sl, col: sc });
        continue;
      }

      // identifier / keyword
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$') {
        const sl = line, sc = col;
        const start = i;
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) adv(1);
        const word = src.slice(start, i);
        tokens.push({ type: KEYWORDS.has(word) ? 'keyword' : 'ident', value: word, line: sl, col: sc });
        onlyWsSinceNewline = false;
        continue;
      }

      // multi-char punctuators (longest match first)
      const three = src.substr(i, 3);
      const two = src.substr(i, 2);
      if (PUNCT3.has(three)) {
        tokens.push({ type: 'punct', value: three, line: line, col: col });
        adv(3); onlyWsSinceNewline = false; continue;
      }
      if (PUNCT2.has(two)) {
        tokens.push({ type: 'punct', value: two, line: line, col: col });
        adv(2); onlyWsSinceNewline = false; continue;
      }
      if ('()[]{};:,?.&+-*/%=<>|^~!'.indexOf(ch) !== -1) {
        tokens.push({ type: 'punct', value: ch, line: line, col: col });
        adv(1); onlyWsSinceNewline = false; continue;
      }

      // unknown character (e.g. '@', '#', '`', '\\') — flagged later
      tokens.push({ type: 'unknown', value: ch, line: line, col: col });
      adv(1); onlyWsSinceNewline = false;
    }
    return tokens;
  }

  // ───────────────────────────── Header classifier ─────────────────────────────
  // Given tokens[startIdx .. endIdx-1] (the part of a statement BEFORE an
  // unmatched '{' at paren-depth 0), decide what kind of construct the '{'
  // opens.
  //   'function'      -> int foo() { ... }            (no ';' needed)
  //   'namespace'     -> namespace ns { ... }         (no ';' needed)
  //   'extern-block'  -> extern "C" { ... }           (no ';' needed)
  //   'aggregate'     -> struct/enum/union/class { }  (';' needed in C/C++, not Java)
  //   'initializer'   -> int x = { ... } / compound    (';' still needed)
  function classifyHeader(tokens, startIdx, endIdx) {
    let depth = 0;
    let hadParenGroup = false;
    let hasAssign = false;
    let hasComma = false;
    let hasStructish = false; // struct / union / enum / class
    let hasNamespace = false;
    let hasExtern = false;
    let externIsString = false;
    const reduced = []; // tokens at paren-depth 0 (groups reduced away)

    for (let k = startIdx; k < endIdx; k++) {
      const t = tokens[k];
      if (t.type === 'punct') {
        if (t.value === '(' || t.value === '[') { depth++; continue; }
        if (t.value === ')' || t.value === ']') {
          if (depth > 0) depth--;
          if (depth === 0 && t.value === ')') hadParenGroup = true;
          continue;
        }
        if (depth === 0) {
          if (t.value === '=') hasAssign = true;
          else if (t.value === ',') hasComma = true;
          // declarator modifiers / template angle brackets are not expression ops
          else if (t.value === '*' || t.value === '&' || t.value === '::' ||
                   t.value === '<' || t.value === '>') { /* ok, part of declarator */ }
          else reduced.push(t);
        }
      } else {
        if (depth === 0) reduced.push(t);
        if (t.type === 'keyword') {
          if (t.value === 'struct' || t.value === 'union' || t.value === 'enum' || t.value === 'class') hasStructish = true;
          if (t.value === 'namespace') hasNamespace = true;
          if (t.value === 'extern') hasExtern = true;
        } else if (t.type === 'string' && hasExtern) {
          externIsString = true;
        }
      }
    }

    if (hasAssign) return 'initializer';
    if (hasComma) return hasStructish ? 'aggregate' : 'initializer';
    if (hasNamespace) return 'namespace';
    if (hasExtern && externIsString) return 'extern-block';
    if (hasStructish) return 'aggregate';
    // any remaining top-level operator punct (not declarator modifier) => expression
    const hasExprOp = reduced.some(function (t) { return t.type === 'punct'; });
    if (hadParenGroup && !hasExprOp) return 'function';
    return 'initializer';
  }

  // ───────────────────────────── Scanner ─────────────────────────────
  function runCFamilyDiagnostics(opts) {
    const monaco = opts.monaco;
    const content = opts.content;
    const settings = opts.settings || {};
    const helpers = opts.helpers;
    const lang = opts.lang || 'c';
    const aggregateNeedsSemi = lang !== 'java';

    const markers = [];
    const tokens = tokenize(content);

    const push = function (id, defSev, line, c1, c2, msg) {
      helpers.pushChecked(markers, monaco, settings, id, defSev, line, c1, c2, msg);
    };
    const tokLen = function (t) {
      if (!t) return 1;
      if (t.value && t.value.length) return t.value.length;
      return 1;
    };

    let pos = 0;
    const peek = function (o) { o = o || 0; return tokens[pos + o]; };
    const isPunct = function (v, o) { const t = peek(o); return t && t.type === 'punct' && t.value === v; };
    const isKw = function (v, o) { const t = peek(o); return t && t.type === 'keyword' && t.value === v; };

    // consume a balanced ( ... ) or [ ... ] starting at current token; return inner tokens
    function consumeGroup() {
      const open = peek();
      if (!open || open.type !== 'punct') return [];
      const close = open.value === '(' ? ')' : (open.value === '[' ? ']' : null);
      if (!close) return [];
      const innerStart = pos + 1;
      pos++;
      let depth = 1;
      while (pos < tokens.length && depth > 0) {
        const t = tokens[pos];
        if (t.type === 'punct') {
          if (t.value === open.value) depth++;
          else if (t.value === close) depth--;
        }
        pos++;
      }
      return tokens.slice(innerStart, pos - 1);
    }

    // Skip a balanced { ... } block WITHOUT scanning its contents. Used for
    // initializer lists like {1, 2, 3} which are expressions, not statement blocks.
    function consumeBlock() {
      pos++; // {
      let depth = 1;
      while (pos < tokens.length && depth > 0) {
        const t = tokens[pos];
        if (t.type === 'punct') {
          if (t.value === '{') depth++;
          else if (t.value === '}') depth--;
        }
        pos++;
      }
    }

    // Consume a { ... } block AND scan its inner statements (function/aggregate
    // bodies, compound statements). Assumes current token is '{'.
    function scanBracedBlock() {
      pos++; // {
      scanBlock(false); // scans statements until the matching '}'
      if (isPunct('}')) pos++; // consume '}'
    }

    function skipToStatementEnd() {
      // skip until ';' or '}' at depth 0; consume ';' but not '}'
      let depth = 0;
      while (pos < tokens.length) {
        const t = tokens[pos];
        if (t.type === 'punct') {
          if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
          else if (t.value === ')' || t.value === ']' || t.value === '}') {
            if (depth > 0) depth--; else if (t.value === '}') return;
          } else if (t.value === ';' && depth === 0) { pos++; return; }
        }
        pos++;
      }
    }

    function isInvalidFileScopeStart(t) {
      if (!t) return false;
      if (t.type === 'number' || t.type === 'string' || t.type === 'char' || t.type === 'unknown') return true;
      if (t.type === 'punct') return true; // no valid file-scope construct starts with an operator
      if (t.type === 'keyword' && FILESCOPE_INVALID_KEYWORDS.has(t.value)) return true;
      return false;
    }

    function scanBlock(isFileScope) {
      while (pos < tokens.length) {
        const t = peek();
        if (!t) break;
        if (t.type === 'punct' && t.value === '}') {
          if (isFileScope) {
            push('strayTokens', 'error', t.line, t.col, t.col + 1, "Unexpected '}' at file scope");
            pos++;
            continue;
          }
          return; // caller consumes the '}'
        }
        scanStatement(isFileScope);
      }
    }

    function scanStatement(isFileScope) {
      const start = peek();
      if (!start) return;

      // File-scope guard: statement-introducing keywords (if/for/while/switch/do/
      // else/case/default/try/catch/finally/return/break/continue/goto/throw) are
      // not valid at file scope. Check this BEFORE the control-flow branches below
      // so they don't get silently accepted as a top-level construct.
      if (isFileScope && start.type === 'keyword' && FILESCOPE_INVALID_KEYWORDS.has(start.value)) {
        push('strayTokens', 'error', start.line, start.col, start.col + tokLen(start),
          "'" + start.value + "' is not valid at file scope - expected a declaration");
        skipToStatementEnd();
        return;
      }

      // label:  ident ':'   (but not '::')
      if (start.type === 'ident' && isPunct(':', 1) && !isPunct(':', 2) &&
          !(peek(2) && peek(2).type === 'punct' && peek(2).value === ':')) {
        pos += 2; // ident ':'
        return; // labeled statement body follows
      }

      // control-flow headers: if / for / while / switch
      if (start.type === 'keyword' && CONTROL_HEADERS.has(start.value)) {
        const kw = start.value;
        pos++;
        let condTokens = [];
        if (isPunct('(')) condTokens = consumeGroup();

        // assignment-in-condition (if / while only — for/switch legitimately use '=')
        if ((kw === 'if' || kw === 'while') && condTokens.length) {
          let d = 0;
          for (let k = 0; k < condTokens.length; k++) {
            const t = condTokens[k];
            if (t.type === 'punct') {
              if (t.value === '(' || t.value === '[') d++;
              else if (t.value === ')' || t.value === ']') d = Math.max(0, d - 1);
              else if (d === 0 && t.value === '=') {
                push('assignmentInCondition', 'warning', t.line, t.col, t.col + 1,
                  "Assignment in " + kw + " condition — did you mean '=='?");
                break;
              }
            }
          }
        }

        // body: block, nested header, or single statement
        const body = peek();
        if (body && body.type === 'punct' && body.value === '{') {
          scanBracedBlock();
        } else if (body) {
          scanStatement(isFileScope);
        }
        return;
      }

      // do ... while ( ... ) ;
      if (start.type === 'keyword' && start.value === 'do') {
        pos++;
        const body = peek();
        if (body && body.type === 'punct' && body.value === '{') scanBracedBlock();
        else if (body) scanStatement(isFileScope);
        if (isKw('while')) {
          pos++;
          if (isPunct('(')) consumeGroup();
          if (!isPunct(';')) {
            const t = peek();
            push('missingSemicolon', 'error', t ? t.line : 1, t ? t.col : 1, (t ? t.col : 1) + 1,
              "Expected ';' after do-while");
          } else { pos++; }
        }
        return;
      }

      // else / try / catch / finally  (body only; no ';' for the header)
      if (start.type === 'keyword' &&
          (start.value === 'else' || start.value === 'try' || start.value === 'catch' || start.value === 'finally')) {
        pos++;
        // catch may have a ( ... ) clause
        if (start.value === 'catch' && isPunct('(')) consumeGroup();
        const body = peek();
        if (body && body.type === 'punct' && body.value === '{') scanBracedBlock();
        else if (body) scanStatement(isFileScope);
        return;
      }

      // case / default
      if (start.type === 'keyword' && (start.value === 'case' || start.value === 'default')) {
        pos++;
        if (start.value === 'case') {
          let d = 0;
          while (pos < tokens.length) {
            const t = tokens[pos];
            if (t.type === 'punct') {
              if (t.value === '(' || t.value === '[') d++;
              else if (t.value === ')' || t.value === ']') d = Math.max(0, d - 1);
              else if (t.value === ':' && d === 0) { pos++; break; }
              else if ((t.value === ';' || t.value === '{' || t.value === '}') && d === 0) break;
            }
            pos++;
          }
        } else {
          if (isPunct(':')) pos++;
        }
        return; // body follows
      }

      // goto label ;
      if (start.type === 'keyword' && start.value === 'goto') {
        pos++;
        if (peek() && peek().type === 'ident') pos++;
        if (!isPunct(';')) {
          const t = peek();
          push('missingSemicolon', 'error', t ? t.line : 1, t ? t.col : 1, (t ? t.col : 1) + 1,
            "Expected ';' after goto");
        } else { pos++; }
        return;
      }

      // compound statement
      if (start.type === 'punct' && start.value === '{') {
        scanBracedBlock();
        return;
      }
      // empty statement
      if (start.type === 'punct' && start.value === ';') { pos++; return; }

      // file-scope validation
      if (isFileScope && isInvalidFileScopeStart(start)) {
        const label = start.type === 'keyword'
          ? "'" + start.value + "' is not valid at file scope"
          : "Unexpected '" + (start.value || start.type) + "' at file scope";
        push('strayTokens', 'error', start.line, start.col, start.col + tokLen(start),
          label + " — expected a declaration");
        skipToStatementEnd();
        return;
      }

      // general statement / expression / declaration
      const stmtStart = pos;
      let parenDepth = 0;
      let lastToken = start;
      let needSemi = true;

      while (pos < tokens.length) {
        const tk = tokens[pos];

        if (tk.type === 'unknown') {
          push('strayTokens', 'error', tk.line, tk.col, tk.col + 1,
            "Unexpected character '" + tk.value + "'");
          lastToken = tk; pos++; continue;
        }

        if (tk.type === 'keyword' && CLAUSE_KEYWORDS.has(tk.value) && parenDepth === 0 && pos > stmtStart) {
          // a statement-starting keyword met mid-statement: the current
          // statement should have ended with ';' before it. (pos > stmtStart
          // so a keyword that IS the statement start, e.g. `return`, is fine.)
          if (needSemi) {
            push('missingSemicolon', 'error', lastToken.line, lastToken.col,
              lastToken.col + tokLen(lastToken),
              "Expected ';' before '" + tk.value + "'");
          }
          return; // leave the clause keyword for the caller
        }

        if (tk.type === 'punct') {
          if (tk.value === '(' || tk.value === '[') { parenDepth++; lastToken = tk; pos++; continue; }
          if (tk.value === ')' || tk.value === ']') { parenDepth = Math.max(0, parenDepth - 1); lastToken = tk; pos++; continue; }
          if (parenDepth === 0) {
            if (tk.value === ';') { pos++; return; } // well-terminated
            if (tk.value === '{') {
              const kind = classifyHeader(tokens, stmtStart, pos);
              lastToken = tk;
              if (kind === 'initializer') {
                consumeBlock();
              } else {
                scanBracedBlock();
              }
              if (pos < tokens.length && tokens[pos - 1]) lastToken = tokens[pos - 1];
              if (kind === 'function' || kind === 'namespace' || kind === 'extern-block') {
                return; // no ';' needed
              }
              if (kind === 'aggregate') {
                needSemi = aggregateNeedsSemi;
                if (!aggregateNeedsSemi) return; // Java: class body is complete
                // C/C++: declarators may follow before ';'
                const nx = peek();
                if (!nx || nx.type === 'keyword' || (nx.type === 'punct' && nx.value === '}')) {
                  if (!isPunct(';')) {
                    push('missingSemicolon', 'error', lastToken.line, lastToken.col, lastToken.col + 1,
                      "Expected ';' after '}'");
                    return;
                  }
                }
                continue;
              }
              // initializer / compound literal — still need ';'
              continue;
            }
            if (tk.value === '}') {
              if (needSemi) {
                push('missingSemicolon', 'error', lastToken.line, lastToken.col,
                  lastToken.col + tokLen(lastToken),
                  isFileScope
                    ? "Expected declaration or ';' before '}'"
                    : "Expected ';' before '}'");
              }
              return; // leave '}' for caller
            }
          }
        }

        lastToken = tk;
        pos++;
      }

      // reached EOF
      if (needSemi && lastToken) {
        if (lastToken.type === 'punct' && lastToken.value === '}') {
          if (aggregateNeedsSemi) {
            push('missingSemicolon', 'error', lastToken.line, lastToken.col, lastToken.col + 1,
              "Expected ';' after '}'");
          }
        } else if (!(lastToken.type === 'punct' && (lastToken.value === ')' || lastToken.value === ']'))) {
          push('missingSemicolon', 'error', lastToken.line, lastToken.col,
            lastToken.col + tokLen(lastToken),
            isFileScope
              ? "Expected declaration or ';' at end of file"
              : "Expected ';' at end of statement");
        }
      }
    }

    scanBlock(true);
    return markers;
  }

  // expose
  global.cFamilyChecker = { runCFamilyDiagnostics: runCFamilyDiagnostics, tokenize: tokenize };
})(typeof window !== 'undefined' ? window : globalThis);
