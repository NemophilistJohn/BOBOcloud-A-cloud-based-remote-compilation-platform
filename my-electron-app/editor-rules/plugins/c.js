(function registerCRules(globalScope) {
  const registry = globalScope.editorRuleRegistry;
  if (!registry) {
    throw new Error('editorRuleRegistry must be loaded before c.js');
  }

  registry.registerLanguageRulePlugin({
    language: 'c',
    createCompletionProvider(monaco, helpers) {
      const kind = monaco.languages.CompletionItemKind;
      return {
        triggerCharacters: ['#', '.', '>', '('],
        provideCompletionItems() {
          return {
            suggestions: [
              // ── Preprocessor ──
              helpers.createSnippet('#include <>', '#include <${1:stdio.h}>', kind.Keyword, monaco),
              helpers.createSnippet('#include ""', '#include "${1:header.h}"', kind.Keyword, monaco),
              helpers.createSnippet('#define', '#define ${1:NAME} ${2:value}', kind.Keyword, monaco),
              helpers.createSnippet('#ifdef', '#ifdef ${1:NAME}\n\t${0}\n#endif', kind.Keyword, monaco),
              helpers.createSnippet('#ifndef', '#ifndef ${1:NAME}\n#define ${1:NAME}\n\t${0}\n#endif', kind.Snippet, monaco),

              // ── Entry point ──
              helpers.createSnippet('main', 'int main(void) {\n\t${0}\n\treturn 0;\n}', kind.Snippet, monaco),
              helpers.createSnippet('main args', 'int main(int argc, char *argv[]) {\n\t${0}\n\treturn 0;\n}', kind.Snippet, monaco),

              // ── Control flow ──
              helpers.createSnippet('if', 'if (${1:condition}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if/else', 'if (${1:condition}) {\n\t${2}\n} else {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('while', 'while (${1:condition}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('do/while', 'do {\n\t${0}\n} while (${1:condition});', kind.Keyword, monaco),
              helpers.createSnippet('switch', 'switch (${1:expr}) {\ncase ${2:val}:\n\t${0}\n\tbreak;\ndefault:\n\tbreak;\n}', kind.Snippet, monaco),

              // ── IO ──
              helpers.createSnippet('printf', 'printf("${1:format}\\n"${2});', kind.Function, monaco),
              helpers.createSnippet('scanf', 'scanf("${1:format}", ${2:&var});', kind.Function, monaco),
              helpers.createSnippet('fprintf', 'fprintf(${1:stream}, "${2:format}\\n"${3});', kind.Function, monaco),
              helpers.createSnippet('sprintf', 'sprintf(${1:buf}, "${2:format}"${3});', kind.Function, monaco),
              helpers.createPlain('putchar', 'putchar(${1:c});', kind.Function),
              helpers.createPlain('getchar', 'getchar();', kind.Function),
              helpers.createPlain('puts', 'puts(${1:str});', kind.Function),

              // ── Memory ──
              helpers.createSnippet('malloc', '(${1:type}*) malloc(${2:size} * sizeof(${1:type}))', kind.Function, monaco),
              helpers.createSnippet('calloc', '(${1:type}*) calloc(${2:n}, sizeof(${1:type}))', kind.Function, monaco),
              helpers.createSnippet('realloc', '(${1:type}*) realloc(${2:ptr}, ${3:size} * sizeof(${1:type}))', kind.Function, monaco),
              helpers.createPlain('free', 'free(${1:ptr});', kind.Function),
              helpers.createPlain('sizeof', 'sizeof(${1:type})', kind.Keyword),
              helpers.createPlain('memset', 'memset(${1:ptr}, ${2:val}, ${3:size});', kind.Function),
              helpers.createPlain('memcpy', 'memcpy(${1:dest}, ${2:src}, ${3:size});', kind.Function),

              // ── String ──
              helpers.createPlain('strlen', 'strlen(${1:str})', kind.Function),
              helpers.createPlain('strcpy', 'strcpy(${1:dest}, ${2:src});', kind.Function),
              helpers.createPlain('strncpy', 'strncpy(${1:dest}, ${2:src}, ${3:n});', kind.Function),
              helpers.createPlain('strcmp', 'strcmp(${1:a}, ${2:b})', kind.Function),
              helpers.createPlain('strcat', 'strcat(${1:dest}, ${2:src});', kind.Function),
              helpers.createPlain('sprintf', 'sprintf(${1:buf}, "${2:fmt}", ${3:...})', kind.Function),

              // ── File I/O ──
              helpers.createSnippet('fopen', 'FILE *${1:fp} = fopen("${2:path}", "${3:r}");\nif (!${1:fp}) { perror("fopen"); return 1; }', kind.Snippet, monaco),
              helpers.createPlain('fclose', 'fclose(${1:fp});', kind.Function),
              helpers.createPlain('fread', 'fread(${1:buf}, ${2:size}, ${3:n}, ${4:fp})', kind.Function),
              helpers.createPlain('fwrite', 'fwrite(${1:buf}, ${2:size}, ${3:n}, ${4:fp})', kind.Function),
              helpers.createPlain('fgets', 'fgets(${1:buf}, ${2:size}, ${3:fp})', kind.Function),
              helpers.createPlain('fscanf', 'fscanf(${1:fp}, "${2:fmt}", ${3:...})', kind.Function),

              // ── Types and structs ──
              helpers.createSnippet('struct', 'struct ${1:Name} {\n\t${2:int} ${3:field};\n};', kind.Snippet, monaco),
              helpers.createSnippet('typedef struct', 'typedef struct {\n\t${1:int} ${2:field};\n} ${3:Name};', kind.Snippet, monaco),
              helpers.createSnippet('typedef', 'typedef ${1:unsigned int} ${2:Name};', kind.Keyword, monaco),
              helpers.createSnippet('enum', 'enum ${1:name} {\n\t${2:A} = 0,\n\t${3:B},\n\t${0}\n};', kind.Snippet, monaco),

              // ── Common patterns ──
              helpers.createSnippet('NULL check', 'if (${1:ptr} == NULL) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createPlain('NULL', 'NULL', kind.Constant),
              helpers.createPlain('return', 'return ${1:val};', kind.Keyword),
              helpers.createPlain('const', 'const ', kind.Keyword),
              helpers.createPlain('static', 'static ', kind.Keyword),
              helpers.createPlain('extern', 'extern ', kind.Keyword)
            ]
          };
        }
      };
    },
    provideDiagnostics({ monaco, content, lines, largeFile, helpers, settings }) {
      const markers = [];
      const lns = lines || content.split('\n');
      const sharedOpts = { lines: lns };

      // settings-aware emit: routes (severityWord, line, c1, c2, msg) to a check
      // id, honouring the user's enabled/severity config.
      const emitFor = (checkId) => (sevWord, line, c1, c2, msg) =>
        helpers.pushChecked(markers, monaco, settings, checkId, sevWord, line, c1, c2, msg);

      // 1) Unmatched brackets / parens / braces
      if (helpers.getCheck(settings, 'unmatchedBrackets', 'error').enabled) {
        markers.push(...helpers.createBalancedPairDiagnostics(content, monaco, {
          lineComment: '//',
          blockComments: [{ start: '/*', end: '*/' }],
          quoteChars: ['"', '\''],
          emit: emitFor('unmatchedBrackets'),
          ...sharedOpts
        }));
      }

      // 2) Common style issues (each sub-check gated by its own setting)
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

      // 3) Unclosed string / char literals
      if (helpers.getCheck(settings, 'unclosedStrings', 'error').enabled) {
        markers.push(...helpers.checkUnclosedStrings(content, monaco, {
          lineComment: '//',
          blockComments: [{ start: '/*', end: '*/' }],
          quoteChars: ['"', "'"],
          emit: emitFor('unclosedStrings'),
          ...sharedOpts
        }));
      }

      // 4) Structural syntax check (missing semicolons, stray tokens at file
      //    scope, assignment-in-condition, do-while). Real tokenizer-based
      //    scanner that replaces the old broken line-regex heuristic.
      if (!largeFile && globalScope.cFamilyChecker) {
        markers.push(...globalScope.cFamilyChecker.runCFamilyDiagnostics({
          monaco, content, lines: lns, settings, helpers, lang: 'c'
        }));
      }

      // 5) Unsafe C library functions (line-based, settings-gated)
      if (!largeFile && helpers.getCheck(settings, 'unsafeFunctions', 'warning').enabled) {
        lns.forEach((line, index) => {
          const lineNum = index + 1;
          const ci = line.indexOf('//');
          const codePart = ci === -1 ? line : line.slice(0, ci);
          const trimmed = codePart.trim();
          if (!trimmed) return;

          if (/\bgets\s*\(/.test(trimmed)) {
            const col = codePart.indexOf('gets') + 1;
            helpers.pushChecked(markers, monaco, settings, 'unsafeFunctions', 'warning',
              lineNum, col, col + 4, 'gets() is unsafe - use fgets() instead');
          }
          if (/scanf\s*\([^)]*%s/.test(trimmed) && !/%\d+s/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'unsafeFunctions', 'warning',
              lineNum, 1, line.length, 'scanf("%s") without field width is unsafe - use "%Ns" or fgets()');
          }
        });
      }

      return markers;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
