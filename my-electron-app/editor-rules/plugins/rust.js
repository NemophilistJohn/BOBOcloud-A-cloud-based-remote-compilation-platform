(function registerRustRules(globalScope) {
  const registry = globalScope.editorRuleRegistry;
  if (!registry) {
    throw new Error('editorRuleRegistry must be loaded before rust.js');
  }

  registry.registerLanguageRulePlugin({
    language: 'rust',
    createCompletionProvider(monaco, helpers) {
      const kind = monaco.languages.CompletionItemKind;
      return {
        triggerCharacters: ['.', ':', '!', '('],
        provideCompletionItems() {
          return {
            suggestions: [
              // ── Functions ──
              helpers.createSnippet('fn', 'fn ${1:name}(${2}) {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('fn main', 'fn main() {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('fn with return', 'fn ${1:name}(${2}) -> ${3:Type} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('pub fn', 'pub fn ${1:name}(${2}) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('method', 'fn ${1:name}(&${2:self}) {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('method mut', 'fn ${1:name}(&mut ${2:self}) {\n\t${0}\n}', kind.Snippet, monaco),

              // ── Variables ──
              helpers.createSnippet('let', 'let ${1:name} = ${2:value};', kind.Keyword, monaco),
              helpers.createSnippet('let mut', 'let mut ${1:name} = ${2:value};', kind.Keyword, monaco),
              helpers.createSnippet('let typed', 'let ${1:name}: ${2:Type} = ${3:value};', kind.Snippet, monaco),
              helpers.createSnippet('const', 'const ${1:NAME}: ${2:Type} = ${3:value};', kind.Keyword, monaco),

              // ── Types ──
              helpers.createSnippet('struct', 'struct ${1:Name} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('struct pub', 'pub struct ${1:Name} {\n\tpub ${2:field}: ${3:Type},\n}', kind.Snippet, monaco),
              helpers.createSnippet('tuple struct', 'struct ${1:Name}(${2:Type});', kind.Snippet, monaco),
              helpers.createSnippet('enum', 'enum ${1:Name} {\n\t${2:Variant1},\n\t${3:Variant2},\n}', kind.Snippet, monaco),
              helpers.createSnippet('enum data', 'enum ${1:Name} {\n\t${2:Variant1}(${3:Type}),\n\t${4:Variant2},\n}', kind.Snippet, monaco),
              helpers.createSnippet('trait', 'trait ${1:Name} {\n\tfn ${2:method}(&self) -> ${3:Type};\n}', kind.Snippet, monaco),
              helpers.createSnippet('impl', 'impl ${1:Name} {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('impl trait', 'impl ${1:Trait} for ${2:Type} {\n\t${0}\n}', kind.Snippet, monaco),

              // ── Control flow ──
              helpers.createSnippet('if', 'if ${1:condition} {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if/else', 'if ${1:condition} {\n\t${2}\n} else {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('if let', 'if let ${1:Ok}(x) = ${2:result} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('while let', 'while let ${1:Some}(x) = ${2:iter}.next() {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('for', 'for ${1:item} in ${2:iter} {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('for range', 'for ${1:i} in 0..${2:n} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('loop', 'loop {\n\t${0}\n}', kind.Keyword, monaco),
              helpers.createSnippet('match', 'match ${1:value} {\n\t${2:pattern} => ${0},\n}', kind.Keyword, monaco),
              helpers.createSnippet('match arms', 'match ${1:value} {\n\tOk(${2:val}) => ${0},\n\tErr(${3:e}) => return Err(${3:e}),\n}', kind.Snippet, monaco),

              // ── Macros ──
              helpers.createSnippet('println!', 'println!("${1:value}");', kind.Function, monaco),
              helpers.createSnippet('println! {}', 'println!("${1:key}: {${2:val}}", ${2:val});', kind.Function, monaco),
              helpers.createSnippet('print!', 'print!("${1:value}");', kind.Function, monaco),
              helpers.createSnippet('format!', 'format!("${1:fmt}", ${2:val})', kind.Function, monaco),
              helpers.createSnippet('eprintln!', 'eprintln!("${1:error}");', kind.Function, monaco),
              helpers.createSnippet('vec!', 'vec![${1:1, 2, 3}]', kind.Function, monaco),
              helpers.createSnippet('vec! cap', 'Vec::with_capacity(${1:10})', kind.Snippet, monaco),
              helpers.createSnippet('assert_eq!', 'assert_eq!(${1:actual}, ${2:expected});', kind.Function, monaco),
              helpers.createSnippet('assert!', 'assert!(${1:condition});', kind.Function, monaco),
              helpers.createSnippet('todo!', 'todo!()', kind.Function, monaco),
              helpers.createSnippet('unimplemented!', 'unimplemented!()', kind.Function, monaco),
              helpers.createSnippet('unreachable!', 'unreachable!()', kind.Function, monaco),
              helpers.createSnippet('panic!', 'panic!("${1:msg}");', kind.Function, monaco),
              helpers.createSnippet('dbg!', 'dbg!(&${1:var});', kind.Function, monaco),

              // ── Option / Result ──
              helpers.createSnippet('Option', 'Option<${1:Type}>', kind.Class, monaco),
              helpers.createSnippet('Result', 'Result<${1:Type}, ${2:Error}>', kind.Class, monaco),
              helpers.createPlain('Some', 'Some(${1:value})', kind.Constant),
              helpers.createPlain('None', 'None', kind.Constant),
              helpers.createPlain('Ok', 'Ok(${1:value})', kind.Constant),
              helpers.createPlain('Err', 'Err(${1:error})', kind.Constant),
              helpers.createSnippet('unwrap', '${1:result}.unwrap()', kind.Method, monaco),
              helpers.createSnippet('unwrap_or', '${1:result}.unwrap_or(${2:default})', kind.Method, monaco),
              helpers.createSnippet('unwrap_or_else', '${1:result}.unwrap_or_else(|e| ${0})', kind.Method, monaco),
              helpers.createSnippet('expect', '${1:result}.expect("${2:msg}")', kind.Method, monaco),
              helpers.createSnippet('map', '${1:opt}.map(|x| ${0})', kind.Method, monaco),
              helpers.createSnippet('and_then', '${1:result}.and_then(|val| ${0})', kind.Method, monaco),
              helpers.createSnippet('?', '${1:result}?', kind.Operator, monaco),

              // ── Common types ──
              helpers.createSnippet('Vec', 'Vec<${1:Type}>', kind.Class, monaco),
              helpers.createSnippet('HashMap', 'HashMap<${1:String}, ${2:i32}>', kind.Class, monaco),
              helpers.createSnippet('HashSet', 'HashSet<${1:Type}>', kind.Class, monaco),
              helpers.createSnippet('String', 'String::from("${1}")', kind.Class, monaco),
              helpers.createSnippet('&str', '&str', kind.Class, monaco),

              // ── Attributes ──
              helpers.createSnippet('#[derive]', '#[derive(Debug, Clone)]\nstruct ${1:Name} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('#[derive full]', '#[derive(Debug, Clone, PartialEq, Eq, Hash)]\nstruct ${1:Name} {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('#[test]', '#[test]\nfn ${1:test_name}() {\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('#[cfg]', '#[cfg(test)]\nmod tests {\n\tuse super::*;\n\t${0}\n}', kind.Snippet, monaco),
              helpers.createSnippet('#[allow]', '#[allow(${1:unused_variables})]', kind.Snippet, monaco),

              // ── Common patterns ──
              helpers.createSnippet('main with error', 'fn main() -> Result<(), Box<dyn std::error::Error>> {\n\t${0}\n\tOk(())\n}', kind.Snippet, monaco),
              helpers.createSnippet('impl Display', 'impl std::fmt::Display for ${1:Type} {\n\tfn fmt(&self, f: &mut std::fmt::Formatter<\'_>) -> std::fmt::Result {\n\t\twrite!(f, "${2}"${3})\n\t}\n}', kind.Snippet, monaco),
              helpers.createSnippet('impl From', 'impl From<${1:FromType}> for ${2:ToType} {\n\tfn from(value: ${1:FromType}) -> Self {\n\t\t${0}\n\t}\n}', kind.Snippet, monaco)
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

      // 1) Unmatched brackets (Rust lifetimes 'a are not char literals)
      if (helpers.getCheck(settings, 'unmatchedBrackets', 'error').enabled) {
        markers.push(...helpers.createBalancedPairDiagnostics(content, monaco, {
          lineComment: '//',
          blockComments: [{ start: '/*', end: '*/' }],
          quoteChars: ['"', '\''],
          ignoreRustLifetime: true,
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

      // Note: Rust deliberately omits ';' to return a value, and uses fn/impl/
      // attributes/macros that defeat line-based ';' checks. A real rustc pass
      // (server-side) is the correct tool for statement errors, so we do NOT run
      // a missing-semicolon heuristic here - it caused too many false positives.

      // 4) Rust style hints (settings-gated)
      if (!largeFile && helpers.getCheck(settings, 'styleHints', 'warning').enabled) {
        lns.forEach((line, index) => {
          const lineNum = index + 1;
          const ci = line.indexOf('//');
          const codePart = ci === -1 ? line : line.slice(0, ci);
          const trimmed = codePart.trim();
          if (!trimmed) return;

          // .unwrap() in non-test code
          if (/\.unwrap\(\)/.test(trimmed) && !/#\[test\]/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, 1, trimmed.length,
              'Consider using expect() or proper error handling instead of unwrap()');
          }
          // Unused Result - a call returning Result whose result is dropped
          if (/^\s*.*(?:read|write|open|create|remove|rename|copy)\s*\(/.test(trimmed) &&
              !/;\s*$/.test(trimmed) && !/^\s*let\b/.test(trimmed)) {
            helpers.pushChecked(markers, monaco, settings, 'styleHints', 'warning',
              lineNum, 1, trimmed.length,
              'Unused Result - results must be used. Add "let _ =" or ".ok();"');
          }
        });
      }

      return markers;
    }
  });
})(typeof window !== 'undefined' ? window : globalThis);
