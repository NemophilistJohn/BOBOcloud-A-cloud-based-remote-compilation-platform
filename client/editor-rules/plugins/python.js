(function registerPythonRules(globalScope) {
  const registry = globalScope.editorRuleRegistry;
  if (!registry) {
    throw new Error('editorRuleRegistry must be loaded before python.js');
  }

  registry.registerLanguageRulePlugin({
    language: 'python',
    createCompletionProvider(monaco, helpers) {
      const kind = monaco.languages.CompletionItemKind;
      return {
        triggerCharacters: ['.', '_', '('],
        provideCompletionItems() {
          return {
            suggestions: [
              // ── Control flow ──
              helpers.createSnippet('def', 'def ${1:name}(${2:args}):\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('class', 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('if', 'if ${1:condition}:\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('elif', 'elif ${1:condition}:\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('else', 'else:\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('for', 'for ${1:item} in ${2:iterable}:\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('while', 'while ${1:condition}:\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('try', 'try:\n\t${0}\nexcept ${1:Exception} as ${2:e}:\n\tpass', kind.Keyword, monaco),
              helpers.createSnippet('try/except/finally', 'try:\n\t${0}\nexcept ${1:Exception} as ${2:e}:\n\t${3:pass}\nfinally:\n\t${4:pass}', kind.Snippet, monaco),
              helpers.createSnippet('with', 'with ${1:expr} as ${2:name}:\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('match', 'match ${1:value}:\n\tcase ${2:pattern}:\n\t\t${0}', kind.Keyword, monaco),

              // ── Imports ──
              helpers.createSnippet('import', 'import ${1:module}', kind.Keyword, monaco),
              helpers.createSnippet('from', 'from ${1:module} import ${2:name}', kind.Keyword, monaco),
              helpers.createSnippet('from...as', 'from ${1:module} import ${2:name} as ${3:alias}', kind.Snippet, monaco),

              // ── Builtins ──
              helpers.createSnippet('print', 'print(${1:value})', kind.Function, monaco),
              helpers.createSnippet('len', 'len(${1:obj})', kind.Function, monaco),
              helpers.createSnippet('range', 'range(${1:start}, ${2:stop})', kind.Function, monaco),
              helpers.createSnippet('range step', 'range(${1:start}, ${2:stop}, ${3:step})', kind.Function, monaco),
              helpers.createSnippet('enumerate', 'enumerate(${1:iterable}, start=${2:0})', kind.Function, monaco),
              helpers.createSnippet('zip', 'zip(${1:iter1}, ${2:iter2})', kind.Function, monaco),
              helpers.createSnippet('sorted', 'sorted(${1:iterable}, key=${2:lambda x: x})', kind.Function, monaco),
              helpers.createSnippet('filter', 'filter(${1:lambda x: x}, ${2:iterable})', kind.Function, monaco),
              helpers.createSnippet('map', 'map(${1:lambda x: x}, ${2:iterable})', kind.Function, monaco),
              helpers.createSnippet('isinstance', 'isinstance(${1:obj}, ${2:type})', kind.Function, monaco),
              helpers.createSnippet('type', 'type(${1:obj})', kind.Function, monaco),
              helpers.createSnippet('int', 'int(${1:value})', kind.Function, monaco),
              helpers.createSnippet('str', 'str(${1:value})', kind.Function, monaco),
              helpers.createSnippet('list', 'list(${1:iterable})', kind.Function, monaco),
              helpers.createSnippet('dict', 'dict(${1:iterable})', kind.Function, monaco),
              helpers.createSnippet('set', 'set(${1:iterable})', kind.Function, monaco),

              // ── Comprehensions ──
              helpers.createSnippet('listcomp', '[${1:expr} for ${2:item} in ${3:iterable}]', kind.Snippet, monaco),
              helpers.createSnippet('listcomp if', '[${1:expr} for ${2:item} in ${3:iterable} if ${4:cond}]', kind.Snippet, monaco),
              helpers.createSnippet('dictcomp', '{${1:key}: ${2:val} for ${3:item} in ${4:iterable}}', kind.Snippet, monaco),
              helpers.createSnippet('setcomp', '{${1:expr} for ${2:item} in ${3:iterable}}', kind.Snippet, monaco),

              // ── Functions & lambdas ──
              helpers.createSnippet('lambda', 'lambda ${1:x}: ${2:x}', kind.Keyword, monaco),
              helpers.createSnippet('return', 'return ${1:value}', kind.Keyword, monaco),
              helpers.createSnippet('yield', 'yield ${1:value}', kind.Keyword, monaco),
              helpers.createSnippet('@decorator', '@${1:decorator}\ndef ${2:name}(${3}):\n\t${0}', kind.Snippet, monaco),
              helpers.createSnippet('@property', '@property\ndef ${1:name}(self):\n\treturn self._${1:name}', kind.Snippet, monaco),
              helpers.createSnippet('@staticmethod', '@staticmethod\ndef ${1:name}(${2}):\n\t${0}', kind.Snippet, monaco),
              helpers.createSnippet('@classmethod', '@classmethod\ndef ${1:name}(cls${2}):\n\t${0}', kind.Snippet, monaco),

              // ── Common patterns ──
              helpers.createSnippet('ifmain', "if __name__ == '__main__':\n\t${0}", kind.Snippet, monaco),
              helpers.createSnippet('withopen', 'with open(${1:path}, "${2:r}", encoding="utf-8") as ${3:f}:\n\t${0}', kind.Snippet, monaco),
              helpers.createSnippet('withopen write', 'with open(${1:path}, "${2:w}", encoding="utf-8") as ${3:f}:\n\t${3:f}.write(${0})', kind.Snippet, monaco),
              helpers.createSnippet('self.', 'self.${1:attr}', kind.Property, monaco),

              // ── Type hints ──
              helpers.createSnippet('typevar', 'def ${1:func}(${2:name}: ${3:str}) -> ${4:None}:\n\t${0}', kind.Snippet, monaco),
              helpers.createSnippet('typed list', 'list[${1:int}]', kind.Snippet, monaco),
              helpers.createSnippet('typed dict', 'dict[${1:str}, ${2:int}]', kind.Snippet, monaco),
              helpers.createSnippet('Optional', 'Optional[${1:int}]', kind.Snippet, monaco),
              helpers.createSnippet('Union', 'Union[${1:int}, ${2:str}]', kind.Snippet, monaco),

              // ── Data structures ──
              helpers.createSnippet('list', '[${1:items}]', kind.Value, monaco),
              helpers.createSnippet('dict', '{${1:key}: ${2:val}}', kind.Value, monaco),
              helpers.createSnippet('tuple', '(${1:items},)', kind.Value, monaco),

              // ── Async ──
              helpers.createSnippet('async def', 'async def ${1:name}(${2}):\n\t${0}', kind.Keyword, monaco),
              helpers.createSnippet('await', 'await ${1:coroutine}', kind.Keyword, monaco),
              helpers.createSnippet('async with', 'async with ${1:expr} as ${2:name}:\n\t${0}', kind.Snippet, monaco),
              helpers.createSnippet('async for', 'async for ${1:item} in ${2:async_iterable}:\n\t${0}', kind.Snippet, monaco)
            ]
          };
        }
      };
    },
    provideDiagnostics({ monaco, content, lines, largeFile, helpers, settings }) {
      const markers = [];
      const lns = lines || content.split('\n');
      const sharedOpts = { lines: lns };

      const emitFor = (checkId) => (sevWord, line, c1, c2, msg) =>
        helpers.pushChecked(markers, monaco, settings, checkId, sevWord, line, c1, c2, msg);

      // 1) Unmatched brackets
      if (helpers.getCheck(settings, 'unmatchedBrackets', 'error').enabled) {
        markers.push(...helpers.createBalancedPairDiagnostics(content, monaco, {
          lineComment: '#',
          quoteChars: ['"', '\''],
          emit: emitFor('unmatchedBrackets'),
          ...sharedOpts
        }));
      }

      // 2) Common style issues
      const ll = helpers.getCheck(settings, 'longLines', 'info');
      markers.push(...helpers.createCommonDiagnostics(content, monaco, {
        lineComment: '#',
        maxLineLength: ll.enabled ? (ll.maxLineLength || 120) : 0,
        checkTrailingWS: helpers.getCheck(settings, 'trailingWhitespace', 'warning').enabled,
        checkMixedIndent: helpers.getCheck(settings, 'mixedIndent', 'warning').enabled,
        checkLongLines: ll.enabled,
        checkTodo: helpers.getCheck(settings, 'todoComments', 'info').enabled,
        ...sharedOpts
      }));

      // 3) Unclosed strings
      if (helpers.getCheck(settings, 'unclosedStrings', 'error').enabled) {
        markers.push(...helpers.checkUnclosedStrings(content, monaco, {
          lineComment: '#',
          quoteChars: ['"', "'"],
          emit: emitFor('unclosedStrings'),
          ...sharedOpts
        }));
      }

      if (largeFile) return markers;

      const blockKeywords = /^(if|elif|else|for|while|try|except|finally|with|def|class|match|case)\b/;

      // A line is a continuation (don't require a colon on it) if it has
      // unbalanced opening brackets or ends with a continuation marker.
      function isContinuation(code) {
        if (code.endsWith('\\')) return true;
        // unbalanced openers
        let parens = 0, brackets = 0, braces = 0;
        for (const ch of code) {
          if (ch === '(') parens++;
          else if (ch === ')') parens--;
          else if (ch === '[') brackets++;
          else if (ch === ']') brackets--;
          else if (ch === '{') braces++;
          else if (ch === '}') braces--;
        }
        if (parens > 0 || brackets > 0 || braces > 0) return true;
        // ends with a binary operator / comma -> expression continues
        if (/(,|\+|-|\*|\/|%|&|\||\^|=>?|==|!=|<=|>=|and|or|in|is|not)\s*$/i.test(code)) return true;
        return false;
      }

      if (helpers.getCheck(settings, 'styleHints', 'warning').enabled) {
        lns.forEach((line, index) => {
          const commentIndex = line.indexOf('#');
          const codePart = commentIndex === -1 ? line : line.slice(0, commentIndex);
          const trimmed = codePart.trim();
          if (!trimmed) return;

          const lineNum = index + 1;

          // Missing colon after block keyword (only when not a continuation)
          if (blockKeywords.test(trimmed) && !trimmed.endsWith(':') && !isContinuation(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, Math.max(1, codePart.length), Math.max(2, codePart.length + 1),
              'Missing colon at end of line');
          }

          // Bare except
          if (/^except\s*:/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, 1, 8, 'Bare except clause - consider "except Exception"');
          }

          // Mutable default argument
          if (/def\s+\w+\s*\(.*=\s*\[\s*\]/.test(trimmed) || /def\s+\w+\s*\(.*=\s*\{\s*\}/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, 1, trimmed.length, 'Mutable default argument - use None as default instead');
          }

          // == None / != None should be "is None" / "is not None"
          if (/==\s*None/.test(trimmed) || /!=\s*None/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'info',
              lineNum, 1, trimmed.length, 'Use "is None" / "is not None" instead of == / != None');
          }

          // except outside try block (indentation-based)
          if (/^except\b/.test(trimmed)) {
            const indent = line.match(/^(\s*)/)[1].length;
            let foundTry = false;
            for (let j = index - 1; j >= 0; j--) {
              const prevIndent = lns[j].match(/^(\s*)/)[1].length;
              if (prevIndent < indent) break;
              if (prevIndent === indent && /^\s*try\s*:/.test(lns[j])) { foundTry = true; break; }
              if (prevIndent === indent && /^\s*(if|for|while|with|def|class)\b/.test(lns[j])) break;
            }
            if (!foundTry) {
              helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
                lineNum, 1, 8, 'except outside try block - check indentation');
            }
          }

          // Invalid assignment to literal
          if (/^\d+[a-zA-Z_]+.*=/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'strayTokens', 'error',
              lineNum, 1, trimmed.indexOf('='), 'Invalid syntax - cannot assign to literal');
          }
        });
      }

      return markers;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
