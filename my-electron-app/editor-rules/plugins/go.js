(function registerGoRules(globalScope) {
  const registry = globalScope.editorRuleRegistry;
  if (!registry) {
    throw new Error('editorRuleRegistry must be loaded before go.js');
  }

  registry.registerLanguageRulePlugin({
    language: 'go',
    createCompletionProvider(monaco, helpers) {
      const kind = monaco.languages.CompletionItemKind;
      return {
        triggerCharacters: ['.', '(', '"'],
        provideCompletionItems() {
          return {
            suggestions: [
              // ── Package ──
              helpers.createSnippet('package', 'package ${1:main}', kind.Keyword, monaco),
              helpers.createSnippet('import', 'import (\n\t"${1:fmt}"\n)', kind.Keyword, monaco),
              helpers.createSnippet('import single', 'import "${1:fmt}"', kind.Keyword, monaco),

              // ── Functions ──
              helpers.createSnippet('func', 'func ${1:name}(${2}) ${3:error} {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('main', 'func main() {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('method', 'func (${1:r} *${2:Type}) ${3:Name}(${4}) ${5:error} {\n\t${0}\n}', kind.Snippet, monaco),

              // ── Control flow ──
              helpers.createSnippet('if', 'if ${1:condition} {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if/else', 'if ${1:condition} {\n\t${2}\n} else {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if init', 'if ${1:var} := ${2:expr}; ${1:var} ${3:cond} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('for', 'for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for range', 'for ${1:i}, ${2:v} := range ${3:items} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('for range idx', 'for ${1:i} := range ${2:items} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('for cond', 'for ${1:condition} {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for ever', 'for {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('switch', 'switch ${1:expr} {\ncase ${2:val}:\n\t${0}\ndefault:\n}', kind.Keyword, monaco),
              helpers.createSnippet('switch type', 'switch ${1:v} := ${2:x}.(type) {\ncase ${3:int}:\n\t${0}\ndefault:\n}', kind.Snippet, monaco),
              helpers.createSnippet('select', 'select {\ncase ${1:msg} := <-${2:ch}:\n\t${0}\ncase <-${3:ctx}.Done():\n\treturn\n}', kind.Snippet, monaco),

              // ── Variables ──
              helpers.createSnippet('var', 'var ${1:name} ${2:type} = ${3:value}', kind.Keyword, monaco),
              helpers.createSnippet('short decl', '${1:name} := ${2:value}', kind.Snippet, monaco),
              helpers.createSnippet('const', 'const ${1:Name} = ${2:value}', kind.Keyword, monaco),
              helpers.createSnippet('const block', 'const (\n\t${1:Name} = ${2:value}\n)', kind.Keyword, monaco),

              // ── Types ──
              helpers.createSnippet('struct', 'type ${1:Name} struct {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('struct fields', 'type ${1:Name} struct {\n\t${2:Field} ${3:Type} \`json:"${4:field}"\`\n}', kind.Snippet, monaco),
              helpers.createSnippet('interface', 'type ${1:Name} interface {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('type alias', 'type ${1:Name} ${2:underlying}', kind.Keyword, monaco),

              // ── Error handling ──
              helpers.createSnippet('if err != nil', 'if err != nil {\n\treturn ${1:err}\n}', kind.Snippet, monaco),
              helpers.createSnippet('if err log', 'if err != nil {\n\tlog.Fatal(err)\n}', kind.Snippet, monaco),
              helpers.createSnippet('err check fmt', 'if err != nil {\n\treturn fmt.Errorf("${1:msg}: %w", err)\n}', kind.Snippet, monaco),

              // ── Common functions ──
              helpers.createSnippet('fmt.Println', 'fmt.Println(${1:value})', kind.Function, monaco),
              helpers.createSnippet('fmt.Printf', 'fmt.Printf("${1:%v}\\n", ${2:val})', kind.Function, monaco),
              helpers.createSnippet('fmt.Sprintf', 'fmt.Sprintf("${1:%v}", ${2:val})', kind.Function, monaco),
              helpers.createSnippet('fmt.Errorf', 'fmt.Errorf("${1:msg}: %w", ${2:err})', kind.Function, monaco),
              helpers.createSnippet('make slice', 'make([]${1:int}, ${2:0}, ${3:cap})', kind.Function, monaco),
              helpers.createSnippet('make map', 'make(map[${1:string}]${2:int})', kind.Function, monaco),
              helpers.createSnippet('make chan', 'make(chan ${1:int}${2:, 10})', kind.Function, monaco),
              helpers.createSnippet('append', 'append(${1:slice}, ${2:elem})', kind.Function, monaco),
              helpers.createSnippet('copy', 'copy(${1:dst}, ${2:src})', kind.Function, monaco),

              // ── Concurrency ──
              helpers.createSnippet('go func', 'go func() {\n\t${0}\n}()', kind.Keyword, monaco),
              helpers.createSnippet('goroutine', 'go ${1:func}(${2:args})', kind.Keyword, monaco),
              helpers.createSnippet('defer', 'defer ${1:func}(${2:args})', kind.Keyword, monaco),
              helpers.createSnippet('defer close', 'defer ${1:file}.Close()', kind.Snippet, monaco),
              helpers.createSnippet('context', 'ctx, cancel := context.WithTimeout(context.Background(), ${1:time.Second}*${2:10})\ndefer cancel()', kind.Snippet, monaco),

              // ── Common patterns ──
              helpers.createSnippet('T test', 'func Test${1:Name}(t *testing.T) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createPlain('return', 'return ${1:val}', kind.Keyword),
              helpers.createSnippet('http.HandleFunc', 'http.HandleFunc("${1:/path}", func(w http.ResponseWriter, r *http.Request) {\n\t${0}\n})', kind.Snippet, monaco)
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
          lineComment: '//',
          blockComments: [{ start: '/*', end: '*/' }],
          quoteChars: ['"', '\'', '`'],
          emit: emitFor('unmatchedBrackets'),
          ...sharedOpts
        }));
      }

      // 2) Common style issues
      const ll = helpers.getCheck(settings, 'longLines', 'info');
      markers.push(...helpers.createCommonDiagnostics(content, monaco, {
        lineComment: '//',
        maxLineLength: ll.enabled ? (ll.maxLineLength || 120) : 0,
        checkTrailingWS: helpers.getCheck(settings, 'trailingWhitespace', 'warning').enabled,
        checkMixedIndent: helpers.getCheck(settings, 'mixedIndent', 'warning').enabled,
        checkLongLines: ll.enabled,
        checkTodo: helpers.getCheck(settings, 'todoComments', 'info').enabled,
        ...sharedOpts
      }));

      // 3) Unclosed strings (Go also has raw strings `...`)
      if (helpers.getCheck(settings, 'unclosedStrings', 'error').enabled) {
        markers.push(...helpers.checkUnclosedStrings(content, monaco, {
          lineComment: '//',
          blockComments: [{ start: '/*', end: '*/' }],
          quoteChars: ['"', "'", '`'],
          emit: emitFor('unclosedStrings'),
          ...sharedOpts
        }));
      }

      // Note: Go auto-inserts semicolons, so there is no missing-semicolon check.

      // 4) Go style hints (settings-gated)
      if (!largeFile && helpers.getCheck(settings, 'styleHints', 'warning').enabled) {
        lns.forEach((line, index) => {
          const lineNum = index + 1;
          const ci = line.indexOf('//');
          const codePart = ci === -1 ? line : line.slice(0, ci);
          const trimmed = codePart.trim();
          if (!trimmed) return;

          // Missing error check: `val, err = foo()` (assignment, not :=) without
          // a following `if err != nil`
          if (/,\s*err\s*$/.test(trimmed) && /^[\w.]+\(/.test(trimmed) && !/err\s*:=/.test(trimmed)) {
            const nextLine = index + 1 < lns.length ? lns[index + 1].trim() : '';
            if (!/if\s+err\s*!=\s*nil/.test(nextLine)) {
              helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
                lineNum, 1, trimmed.length, 'Missing error check - err value is not checked');
            }
          }
          // Exported function without doc comment
          if (/^func [A-Z]\w*/.test(trimmed) && index > 0) {
            const prevLine = lns[index - 1].trim();
            if (!/^\/\//.test(prevLine) && !/^\/\*/.test(prevLine)) {
              helpers.pushChecked(markers, monaco, settings, 'styleHints', 'info',
                lineNum, 1, trimmed.length, 'Exported function should have a doc comment');
            }
          }
        });
      }

      return markers;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
