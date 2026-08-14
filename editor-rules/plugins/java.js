(function registerJavaRules(globalScope) {
  const registry = globalScope.editorRuleRegistry;
  if (!registry) {
    throw new Error('editorRuleRegistry must be loaded before java.js');
  }

  registry.registerLanguageRulePlugin({
    language: 'java',
    createCompletionProvider(monaco, helpers) {
      const kind = monaco.languages.CompletionItemKind;
      return {
        triggerCharacters: ['.', '('],
        provideCompletionItems() {
          return {
            suggestions: [
              // ── Modifiers ──
              helpers.createPlain('public', 'public ', kind.Keyword),
              helpers.createPlain('private', 'private ', kind.Keyword),
              helpers.createPlain('protected', 'protected ', kind.Keyword),
              helpers.createPlain('static', 'static ', kind.Keyword),
              helpers.createPlain('final', 'final ', kind.Keyword),
              helpers.createPlain('abstract', 'abstract ', kind.Keyword),
              helpers.createPlain('synchronized', 'synchronized ', kind.Keyword),

              // ── Classes ──
              helpers.createSnippet('class', 'public class ${1:Main} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('interface', 'public interface ${1:Name} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('enum', 'public enum ${1:Name} {\n\t${2:A}, ${3:B};\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('record', 'public record ${1:Name}(${2:String name}, ${3:int age}) {\n\t${0}\n}', kind.Snippet, monaco),

              // ── Entry point ──
              helpers.createSnippet('main', 'public static void main(String[] args) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('psvm', 'public static void main(String[] args) {\n\t${0}\n}', kind.Snippet, monaco),

              // ── Methods ──
              helpers.createSnippet('method', 'public ${1:void} ${2:name}(${3}) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('getter', 'public ${1:Type} get${2:Field}() {\n\treturn ${3:field};\n}', kind.Snippet, monaco),
              helpers.createSnippet('setter', 'public void set${1:Field}(${2:Type} ${3:value}) {\n\tthis.${4:field} = ${3:value};\n}', kind.Snippet, monaco),
              helpers.createSnippet('constructor', 'public ${1:Name}(${2}) {\n\t${0}\n}', kind.Snippet, monaco),

              // ── Control flow ──
              helpers.createSnippet('if', 'if (${1:condition}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if/else', 'if (${1:condition}) {\n\t${2}\n} else {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for each', 'for (${1:Type} ${2:item} : ${3:collection}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('while', 'while (${1:condition}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('switch', 'switch (${1:expr}) {\n\tcase ${2:val} -> ${0};\n\tdefault -> {}\n}', kind.Keyword, monaco),
              helpers.createSnippet('try/catch', 'try {\n\t${0}\n} catch (${1:Exception} ${2:e}) {\n\t${2:e}.printStackTrace();\n}', kind.Snippet, monaco),
              helpers.createSnippet('try/resource', 'try (${1:var}) {\n\t${0}\n} catch (${2:Exception} ${3:e}) {\n\t${3:e}.printStackTrace();\n}', kind.Snippet, monaco),

              // ── Output ──
              helpers.createSnippet('sout', 'System.out.println(${1:value});', kind.Method, monaco),
              helpers.createSnippet('soutf', 'System.out.printf("${1:%s}\\n", ${2:val});', kind.Method, monaco),
              helpers.createSnippet('serr', 'System.err.println(${1:value});', kind.Method, monaco),

              // ── Collections ──
              helpers.createSnippet('ArrayList', 'List<${1:String}> ${2:list} = new ArrayList<>();', kind.Class, monaco),
              helpers.createSnippet('HashMap', 'Map<${1:String}, ${2:Integer}> ${3:map} = new HashMap<>();', kind.Class, monaco),
              helpers.createSnippet('HashSet', 'Set<${1:String}> ${2:set} = new HashSet<>();', kind.Class, monaco),
              helpers.createSnippet('LinkedList', 'List<${1:String}> ${2:list} = new LinkedList<>();', kind.Class, monaco),
              helpers.createSnippet('Stream', '${1:list}.stream().${2:map}(${3:x} -> ${0}).collect(Collectors.toList());', kind.Snippet, monaco),

              // ── Common patterns ──
              helpers.createSnippet('equals/hashCode', '@Override\npublic boolean equals(Object o) {\n\tif (this == o) return true;\n\tif (!(o instanceof ${1:Type})) return false;\n\t${1:Type} that = (${1:Type}) o;\n\treturn ${0};\n}\n\n@Override\npublic int hashCode() {\n\treturn Objects.hash(${2:field});\n}', kind.Snippet, monaco),
              helpers.createSnippet('toString', '@Override\npublic String toString() {\n\treturn "${1:Name}{" +\n\t\t"${2:field}=" + ${2:field} +\n\t\t\'}\'\n\t;\n}', kind.Snippet, monaco),
              helpers.createSnippet('@Override', '@Override\npublic ${1:void} ${2:name}(${3}) {\n\tsuper.${2:name}(${3});\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('Thread', 'new Thread(() -> {\n\t${0}\n}).start();', kind.Snippet, monaco),
              helpers.createSnippet('Optional', 'Optional.ofNullable(${1:val}).ifPresent(${2:v} -> ${0});', kind.Snippet, monaco),
              helpers.createPlain('return', 'return ${1:val};', kind.Keyword),
              helpers.createPlain('this.', 'this.${1:field}', kind.Property),

              // ── Annotations ──
              helpers.createPlain('@Test', '@Test\npublic void ${1:test}() {\n\t${0}\n}', kind.Snippet)
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
          quoteChars: ['"', '\''],
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

      // 3) Unclosed strings
      if (helpers.getCheck(settings, 'unclosedStrings', 'error').enabled) {
        markers.push(...helpers.checkUnclosedStrings(content, monaco, {
          lineComment: '//',
          blockComments: [{ start: '/*', end: '*/' }],
          quoteChars: ['"', "'"],
          emit: emitFor('unclosedStrings'),
          ...sharedOpts
        }));
      }

      // 4) Structural syntax check (Java: class bodies do NOT need ';')
      if (!largeFile && globalScope.cFamilyChecker) {
        markers.push(...globalScope.cFamilyChecker.runCFamilyDiagnostics({
          monaco, content, lines: lns, settings, helpers, lang: 'java'
        }));
      }

      // 5) Java style hints (line-based, settings-gated)
      if (!largeFile && helpers.getCheck(settings, 'styleHints', 'warning').enabled) {
        lns.forEach((line, index) => {
          const lineNum = index + 1;
          const ci = line.indexOf('//');
          const codePart = ci === -1 ? line : line.slice(0, ci);
          const trimmed = codePart.trim();
          if (!trimmed) return;

          // Raw type usage: new ArrayList() without <>
          if (/\bnew\s+(ArrayList|HashMap|HashSet|LinkedList|TreeMap|TreeSet)\s*\(\s*\)/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, 1, trimmed.length, 'Raw type usage - add type parameters <>');
          }
          // System.out in non-test code
          if (/System\.out\.print/.test(trimmed) && !/@Test/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'info',
              lineNum, 1, trimmed.length, 'Consider using a logger instead of System.out');
          }
          // Empty catch block
          if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, 1, trimmed.length, 'Empty catch block - handle or at least log the exception');
          }
        });
      }

      return markers;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
