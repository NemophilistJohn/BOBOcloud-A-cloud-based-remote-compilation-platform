const test = require('node:test');
const assert = require('node:assert/strict');

const registeredProviders = {};
const CompletionItemKind = {
  Method: 0,
  Function: 1,
  Constructor: 2,
  Field: 3,
  Variable: 4,
  Class: 5,
  Struct: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Operator: 11,
  Constant: 14,
  Enum: 15,
  EnumMember: 16,
  Keyword: 17,
  Tool: 27,
  Snippet: 28
};

const monaco = {
  languages: {
    CompletionItemKind,
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    registerCompletionItemProvider(language, provider) {
      registeredProviders[language] = provider;
      return { dispose() {} };
    }
  },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }
};

require('../editor-rules/completion-engine.js');
require('../completion-rules.js');
require('../editor-rules/symbol-extractor.js');
['c', 'cpp', 'java', 'go', 'python', 'rust'].forEach(function (language) {
  require('../editor-rules/plugins/' + language + '.js');
});
global.registerCompletionProviders(monaco);

function createModel(initialValue) {
  let value = initialValue;

  function lines() {
    return value.split('\n');
  }

  function offset(position) {
    const allLines = lines();
    let result = 0;
    for (let i = 0; i < position.lineNumber - 1; i += 1) result += (allLines[i] || '').length + 1;
    return result + position.column - 1;
  }

  return {
    setValue(next) { value = next; },
    getValue() { return value; },
    getValueLength() { return value.length; },
    getLineCount() { return lines().length; },
    getLineContent(lineNumber) { return lines()[lineNumber - 1] || ''; },
    getOffsetAt: offset,
    getValueInRange(range) {
      return value.slice(offset({ lineNumber: range.startLineNumber, column: range.startColumn }),
        offset({ lineNumber: range.endLineNumber, column: range.endColumn }));
    },
    getWordUntilPosition(position) {
      const prefix = this.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const match = /[A-Za-z_$][\w$]*$/.exec(prefix);
      const word = match ? match[0] : '';
      return { word, startColumn: position.column - word.length, endColumn: position.column };
    }
  };
}

function endPosition(value) {
  const lines = value.split('\n');
  return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
}

function complete(language, value, requestContext, model) {
  const target = model || createModel(value);
  return registeredProviders[language].provideCompletionItems(
    target,
    endPosition(value),
    requestContext || {},
    { isCancellationRequested: false }
  );
}

test('keeps only language-relevant trigger characters', function () {
  assert.deepEqual(registeredProviders.c.triggerCharacters, ['#', '.', '>']);
  assert.deepEqual(registeredProviders.cpp.triggerCharacters, ['#', '.', ':', '>']);
  assert.deepEqual(registeredProviders.rust.triggerCharacters, ['.', ':']);
  assert.deepEqual(registeredProviders.go.triggerCharacters, ['.']);
  assert.ok(!registeredProviders.c.triggerCharacters.includes('('));
});

test('suppresses suggestions in comments, strings and invalid structural triggers', function () {
  assert.equal(complete('c', 'void f(void) {\n  // pri').suggestions.length, 0);
  assert.equal(complete('rust', 'fn main() {\n  let value = "pri').suggestions.length, 0);
  assert.equal(complete('go', 'func main() {\n  value := `pri').suggestions.length, 0);
  assert.equal(complete('c', 'void f(void) {\n  int n = 2 >', { triggerCharacter: '>' }).suggestions.length, 0);
  assert.equal(complete('rust', "fn f(value: &'a str) {\n  val").suggestions.some(function (item) {
    return item.label === 'value';
  }), true);
});

test('turns legacy plain placeholders into snippets and deduplicates labels', function () {
  const suggestions = complete('c', 'void f(void) {\n  put').suggestions;
  const putchar = suggestions.find(function (item) { return item.label === 'putchar'; });
  assert.ok(putchar);
  assert.equal(putchar.insertTextRules, monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);

  const sprintf = complete('c', 'void f(void) {\n  spri').suggestions.filter(function (item) {
    return item.label === 'sprintf';
  });
  assert.equal(sprintf.length, 1);
});

test('does not reuse a snippet tabstop with conflicting default text', function () {
  global.editorRuleRegistry.listLanguageRulePlugins().forEach(function (plugin) {
    const provider = plugin.createCompletionProvider(monaco, global.editorRuleRegistry.helpers);
    const suggestions = provider.provideCompletionItems().suggestions;
    suggestions.forEach(function (item) {
      const defaults = new Map();
      const pattern = /\$\{(\d+)(?::([^}]*))?\}/g;
      let match;
      while ((match = pattern.exec(String(item.insertText || '')))) {
        if (!match[2]) continue;
        if (defaults.has(match[1])) {
          assert.equal(match[2], defaults.get(match[1]), plugin.language + ':' + item.label + ' tabstop ' + match[1]);
        } else {
          defaults.set(match[1], match[2]);
        }
      }
    });
  });
});

test('preprocessor completion replaces the full directive prefix', function () {
  const suggestions = complete('c', '#inc', { triggerCharacter: '#' }).suggestions;
  assert.ok(suggestions.length >= 2);
  assert.ok(suggestions.every(function (item) { return String(item.label).startsWith('#include'); }));
  assert.equal(suggestions[0].range.startColumn, 1);
  assert.equal(suggestions[0].range.endColumn, 5);
});

test('extracts active function parameters in every supported language', function () {
  const cases = [
    ['c', 'int sum(int count, const char *name) {\n  cou', 2, ['count', 'name']],
    ['cpp', 'void run(std::vector<int> values, int limit) {\n  val', 2, ['values', 'limit']],
    ['java', 'void run(String value, int limit) {\n  val', 2, ['value', 'limit']],
    ['python', 'def run(value: str, limit=1):\n    val', 2, ['value', 'limit']],
    ['go', 'func run(ctx context.Context, left, right int) {\n  lef', 2, ['ctx', 'left', 'right']],
    ['rust', 'fn run(value: &str, count: usize) {\n  val', 2, ['value', 'count']]
  ];

  cases.forEach(function (entry) {
    const symbols = global.symbolExtractor.extract(entry[1], entry[0], entry[2]);
    const names = symbols.map(function (symbol) { return symbol.name; });
    entry[3].forEach(function (name) {
      assert.ok(names.includes(name), entry[0] + ' should include parameter ' + name);
      assert.equal(symbols.find(function (symbol) { return symbol.name === name; }).priority, 0);
    });
  });
});

test('extracts aliases and multiple declarations', function () {
  const python = global.symbolExtractor.extract(
    'import numpy as np, os\nfrom pathlib import Path as FilePath\ndef run():\n    pass',
    'python',
    4
  ).map(function (symbol) { return symbol.name; });
  assert.ok(python.includes('np'));
  assert.ok(python.includes('os'));
  assert.ok(python.includes('FilePath'));

  const go = global.symbolExtractor.extract(
    'func run() {\n  left, right := pair()\n  lef',
    'go',
    3
  ).map(function (symbol) { return symbol.name; });
  assert.ok(go.includes('left'));
  assert.ok(go.includes('right'));
});

test('offers inferred C, C++ and Rust members without duplicating the receiver', function () {
  const cSource = 'typedef struct { int x; int y; } Point;\nvoid run(void) { Point point;\n  point.';
  const cMembers = complete('c', cSource, { triggerCharacter: '.' }).suggestions;
  assert.deepEqual(cMembers.map(function (item) { return item.label; }).sort(), ['x', 'y']);

  const cppSource = '#include <vector>\nvoid run(std::vector<int> values) {\n  values.pu';
  const cppMembers = complete('cpp', cppSource, { triggerCharacter: '.' }).suggestions;
  const pushBack = cppMembers.find(function (item) { return item.label === 'push_back'; });
  assert.ok(pushBack);
  assert.equal(pushBack.insertText, 'push_back(${1:value})');

  const namespaceMembers = complete('cpp', 'void run() {\n  std::ve').suggestions;
  const vector = namespaceMembers.find(function (item) { return item.label === 'vector'; });
  assert.ok(vector);
  assert.ok(vector.insertText.startsWith('vector<'));

  const rustSource = [
    'struct User { name: String, age: u32 }',
    'impl User { fn greet(&self, prefix: &str) {} }',
    'fn run(user: User) {',
    '  user.gr'
  ].join('\n');
  const rustMembers = complete('rust', rustSource, { triggerCharacter: '.' }).suggestions;
  assert.equal(rustMembers.find(function (item) { return item.label === 'greet'; }).insertText, 'greet(${1:prefix})');

  const goMembers = complete('go', 'func run() {\n  fmt.Pr', { triggerCharacter: '.' }).suggestions;
  const println = goMembers.find(function (item) { return item.label === 'Println'; });
  assert.ok(println);
  assert.equal(println.insertText, 'Println(${1:value})');
});

test('does not attach receiver-specific static snippets to arbitrary objects', function () {
  const javaMembers = complete('java', 'class Demo { void run(Object obj) {\n  obj.', { triggerCharacter: '.' }).suggestions;
  assert.ok(!javaMembers.some(function (item) {
    return ['sout', 'serr', 'this.'].includes(item.label);
  }));

  const pythonMembers = complete('python', 'def run(obj):\n    obj.', { triggerCharacter: '.' }).suggestions;
  assert.ok(!pythonMembers.some(function (item) { return item.label === 'self.'; }));

  assert.ok(complete('java', 'class Demo { void run() {\n  thi').suggestions.some(function (item) {
    return item.label === 'this.';
  }));
  assert.ok(complete('python', 'def run(self):\n    sel').suggestions.some(function (item) {
    return item.label === 'self.';
  }));
});

test('keeps function parameters visible inside nested control-flow blocks', function () {
  const c = global.symbolExtractor.extract(
    'int run(int count) {\n  if (count > 0) {\n    cou',
    'c',
    3
  );
  assert.ok(c.some(function (symbol) { return symbol.name === 'count' && symbol.priority === 0; }));
});

test('does not leak local declarations from another function', function () {
  const cases = [
    ['c', 'void first(void) {\n  int hidden = 1;\n}\nvoid second(void) {\n  int visible = 2;\n  vis\n}', 6],
    ['cpp', 'void first() {\n  int hidden = 1;\n}\nvoid second() {\n  int visible = 2;\n  vis\n}', 6],
    ['java', 'class Demo {\n  void first() {\n    int hidden = 1;\n  }\n  void second() {\n    int visible = 2;\n    vis\n  }\n}', 7],
    ['python', 'def first():\n    hidden = 1\n\ndef second():\n    visible = 2\n    vis', 6],
    ['go', 'func first() {\n  hidden := 1\n}\nfunc second() {\n  visible := 2\n  vis\n}', 6],
    ['rust', 'fn first() {\n  let hidden = 1;\n}\nfn second() {\n  let visible = 2;\n  vis\n}', 6]
  ];

  cases.forEach(function (entry) {
    const symbols = global.symbolExtractor.extract(entry[1], entry[0], entry[2]);
    const names = symbols.map(function (symbol) { return symbol.name; });
    assert.ok(names.includes('visible'), entry[0] + ' should include the active function local');
    assert.ok(!names.includes('hidden'), entry[0] + ' should not leak a local from first() into second()');
  });
});

test('extracts Java generic local declarations', function () {
  const symbols = global.symbolExtractor.extract(
    'class Demo {\n  void run() {\n    List<String> names = new ArrayList<>();\n    nam\n  }\n}',
    'java',
    4
  );
  const names = symbols.map(function (symbol) { return symbol.name; });
  assert.ok(names.includes('names'));
});

test('treats a Go method receiver as an active local parameter', function () {
  const symbols = global.symbolExtractor.extract(
    'type Server struct{}\nfunc (srv *Server) Handle(request string) {\n  sr\n}',
    'go',
    3
  );
  const receiver = symbols.find(function (symbol) { return symbol.name === 'srv'; });
  assert.ok(receiver);
  assert.equal(receiver.priority, 0);
  assert.match(receiver.detail, /receiver/i);
});

test('uses Monaco completion kinds instead of stale numeric mappings', function () {
  const value = 'int calculate(int count) {\n  cou';
  const suggestions = complete('c', value).suggestions;
  assert.equal(suggestions.find(function (item) { return item.label === 'count'; }).kind, CompletionItemKind.Variable);

  const functionValue = 'int calculate(int count) { return count; }\ncal';
  const functions = complete('c', functionValue).suggestions;
  assert.equal(functions.find(function (item) { return item.label === 'calculate'; }).kind, CompletionItemKind.Function);
});

test('reuses symbols while typing on the same line and respects cancellation', function () {
  let value = 'int run(int count) {\n  int local;\n  c';
  const model = createModel(value);
  const originalExtract = global.symbolExtractor.extract;
  let extractCalls = 0;
  global.symbolExtractor.extract = function () {
    extractCalls += 1;
    return originalExtract.apply(this, arguments);
  };

  registeredProviders.c.provideCompletionItems(model, endPosition(value), {}, { isCancellationRequested: false });
  value = 'int run(int count) {\n  int local;\n  co';
  model.setValue(value);
  registeredProviders.c.provideCompletionItems(model, endPosition(value), {}, { isCancellationRequested: false });
  assert.equal(extractCalls, 1);

  const cancelled = registeredProviders.c.provideCompletionItems(
    model,
    endPosition(value),
    {},
    { isCancellationRequested: true }
  );
  assert.deepEqual(cancelled, { suggestions: [] });
  assert.equal(extractCalls, 1);
  global.symbolExtractor.extract = originalExtract;
});
