(function registerCppRules(globalScope) {
  const registry = globalScope.editorRuleRegistry;
  if (!registry) {
    throw new Error('editorRuleRegistry must be loaded before cpp.js');
  }

  registry.registerLanguageRulePlugin({
    language: 'cpp',
    createCompletionProvider(monaco, helpers) {
      const kind = monaco.languages.CompletionItemKind;
      return {
        triggerCharacters: ['#', '.', ':', '(', '>'],
        provideCompletionItems() {
          return {
            suggestions: [
              // ── Preprocessor ──
              helpers.createSnippet('#include <>', '#include <${1:iostream}>', kind.Keyword, monaco),
              helpers.createSnippet('#include ""', '#include "${1:header.h}"', kind.Keyword, monaco),
              helpers.createPlain('using namespace std;', 'using namespace std;', kind.Keyword),
              helpers.createSnippet('#pragma once', '#pragma once', kind.Keyword, monaco),
              helpers.createSnippet('namespace', 'namespace ${1:name} {\n\t${0}\n}', kind.Keyword, monaco),

              // ── Entry point ──
              helpers.createSnippet('main', 'int main() {\n\t${0}\n\treturn 0;\n}', kind.Snippet, monaco),
              helpers.createSnippet('main args', 'int main(int argc, char *argv[]) {\n\t${0}\n\treturn 0;\n}', kind.Snippet, monaco),

              // ── Classes ──
              helpers.createSnippet('class', 'class ${1:Name} {\npublic:\n\t${1:Name}();\n\t~${1:Name}();\nprivate:\n\t${0}\n};', kind.Snippet, monaco),
              helpers.createSnippet('struct', 'struct ${1:Name} {\n\t${0}\n};', kind.Snippet, monaco),
              helpers.createSnippet('template class', 'template <typename ${1:T}>\nclass ${2:Name} {\npublic:\n\t${0}\n};', kind.Snippet, monaco),

              // ── Control flow ──
              helpers.createSnippet('if', 'if (${1:condition}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if/else', 'if (${1:condition}) {\n\t${2}\n} else {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for', 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('range for', 'for (auto& ${1:item} : ${2:container}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('while', 'while (${1:condition}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('switch', 'switch (${1:expr}) {\ncase ${2:val}:\n\t${0}\n\tbreak;\ndefault:\n\tbreak;\n}', kind.Snippet, monaco),
              helpers.createSnippet('try/catch', 'try {\n\t${0}\n} catch (const std::exception& ${1:e}) {\n\tstd::cerr << ${1:e}.what() << std::endl;\n}', kind.Snippet, monaco),

              // ── IO ──
              helpers.createSnippet('cout', 'std::cout << ${1:value} << std::endl;', kind.Variable, monaco),
              helpers.createSnippet('cin', 'std::cin >> ${1:var};', kind.Variable, monaco),
              helpers.createSnippet('cerr', 'std::cerr << ${1:error} << std::endl;', kind.Variable, monaco),
              helpers.createSnippet('cout format', 'std::cout << "${1:text}: " << ${2:var} << "\\n";', kind.Snippet, monaco),

              // ── STL Containers ──
              helpers.createSnippet('vector', 'std::vector<${1:int}> ${2:items};', kind.Class, monaco),
              helpers.createSnippet('vector init', 'std::vector<${1:int}> ${2:items} = {${3:1, 2, 3}};', kind.Class, monaco),
              helpers.createSnippet('map', 'std::map<${1:std::string}, ${2:int}> ${3:m};', kind.Class, monaco),
              helpers.createSnippet('unordered_map', 'std::unordered_map<${1:std::string}, ${2:int}> ${3:m};', kind.Class, monaco),
              helpers.createSnippet('set', 'std::set<${1:int}> ${2:s};', kind.Class, monaco),
              helpers.createSnippet('string', 'std::string ${1:str} = "${2}";', kind.Class, monaco),
              helpers.createSnippet('pair', 'std::pair<${1:int}, ${2:int}> ${3:p};', kind.Class, monaco),
              helpers.createSnippet('queue', 'std::queue<${1:int}> ${2:q};', kind.Class, monaco),
              helpers.createSnippet('stack', 'std::stack<${1:int}> ${2:s};', kind.Class, monaco),
              helpers.createSnippet('priority_queue', 'std::priority_queue<${1:int}> ${2:pq};', kind.Class, monaco),

              // ── STL Algorithms ──
              helpers.createSnippet('sort', 'std::sort(${1:vec}.begin(), ${1:vec}.end());', kind.Function, monaco),
              helpers.createSnippet('find', 'std::find(${1:vec}.begin(), ${1:vec}.end(), ${2:val})', kind.Function, monaco),
              helpers.createSnippet('lower_bound', 'std::lower_bound(${1:vec}.begin(), ${1:vec}.end(), ${2:val})', kind.Function, monaco),

              // ── Smart Pointers ──
              helpers.createSnippet('unique_ptr', 'std::unique_ptr<${1:Type}> ${2:p} = std::make_unique<${1:Type}>(${3});', kind.Class, monaco),
              helpers.createSnippet('shared_ptr', 'std::shared_ptr<${1:Type}> ${2:p} = std::make_shared<${1:Type}>(${3});', kind.Class, monaco),

              // ── Templates & Functions ──
              helpers.createSnippet('function', '${1:void} ${2:name}(${3}) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('template func', 'template <typename ${1:T}>\n${1:T} ${2:func}(${1:T} ${3:x}) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('auto', 'auto ${1:var} = ${2:value};', kind.Keyword, monaco),
              helpers.createSnippet('lambda', '[&](${1:auto x}) { return ${0}; }', kind.Snippet, monaco),
              helpers.createSnippet('lambda capture', '[${1:capture}](${2:auto x}) { return ${0}; }', kind.Snippet, monaco),
              helpers.createPlain('nullptr', 'nullptr', kind.Constant),
              helpers.createSnippet('constexpr', 'constexpr ${1:int} ${2:NAME} = ${3:val};', kind.Keyword, monaco),

              // ── Common patterns ──
              helpers.createSnippet('push_back', '${1:vec}.push_back(${2:val});', kind.Method, monaco),
              helpers.createSnippet('emplace_back', '${1:vec}.emplace_back(${2:args});', kind.Method, monaco),
              helpers.createSnippet('for_each', 'std::for_each(${1:vec}.begin(), ${1:vec}.end(), [](auto& ${2:x}) { ${0}; });', kind.Snippet, monaco),
              helpers.createPlain('return', 'return ${1:val};', kind.Keyword)
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

      // 4) Structural syntax check (real tokenizer + statement scanner)
      if (!largeFile && globalScope.cFamilyChecker) {
        markers.push(...globalScope.cFamilyChecker.runCFamilyDiagnostics({
          monaco, content, lines: lns, settings, helpers, lang: 'cpp'
        }));
      }

      // 5) C++ modernization hints (line-based, settings-gated)
      if (!largeFile && helpers.getCheck(settings, 'cppModernize', 'info').enabled) {
        lns.forEach((line, index) => {
          const lineNum = index + 1;
          const ci = line.indexOf('//');
          const codePart = ci === -1 ? line : line.slice(0, ci);
          const trimmed = codePart.trim();
          if (!trimmed) return;

          // NULL -> nullptr
          const nullIdx = trimmed.search(/\bNULL\b/);
          if (nullIdx !== -1) {
            const col = codePart.indexOf('NULL', nullIdx) + 1;
            helpers.pushChecked(markers, monaco, settings, 'cppModernize', 'info',
              lineNum, col, col + 4, 'Consider using nullptr instead of NULL');
          }
          // C-style cast: (int), (double), (char*), (void*) ...
          const castMatch = trimmed.match(/\((int|double|float|char|void|long|short|unsigned|size_t)\s*\*?\)/);
          if (castMatch) {
            helpers.pushChecked(markers, monaco, settings, 'cppModernize', 'info',
              lineNum, 1, line.length, 'C-style cast detected - prefer static_cast<>');
          }
        });
      }

      return markers;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
