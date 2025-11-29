// completion-rules.js
// Contains code completion rules for all languages

function registerCompletionProviders() {
  // Python
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '_', '(', '='],
    provideCompletionItems: (model, position) => {
      const suggestions = [
        // Keywords
        { label: 'def', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'def ${1:name}(${2:args}):\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'class', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'if ${1:condition}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'elif', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'elif ${1:condition}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for ${1:item} in ${2:iterable}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'while', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'while ${1:condition}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'try', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'try:\n\t${0}\nexcept ${1:Exception}:\n\tpass', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'except', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'except ${1:Exception}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'finally', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'finally:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'with', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'with ${1:context} as ${2:var}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'return', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'return ${1:value}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'yield', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'yield ${1:value}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'import ${1:module}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'from', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'from ${1:module} import ${2:name}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'as', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'as ${1:alias}' },
        { label: 'pass', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'pass' },
        { label: 'break', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'break' },
        { label: 'continue', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'continue' },
        { label: 'lambda', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'lambda ${1:args}: ${2:expr}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'global', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'global ${1:var}' },
        { label: 'nonlocal', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'nonlocal ${1:var}' },
        
        // Built-in functions
        { label: 'print', kind: monaco.languages.CompletionItemKind.Function, insertText: 'print(${1})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'len', kind: monaco.languages.CompletionItemKind.Function, insertText: 'len(${1})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'range', kind: monaco.languages.CompletionItemKind.Function, insertText: 'range(${1:start}, ${2:stop}, ${3:step})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'list', kind: monaco.languages.CompletionItemKind.Function, insertText: 'list(${1:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'dict', kind: monaco.languages.CompletionItemKind.Function, insertText: 'dict(${1})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'set', kind: monaco.languages.CompletionItemKind.Function, insertText: 'set(${1:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'tuple', kind: monaco.languages.CompletionItemKind.Function, insertText: 'tuple(${1:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'str', kind: monaco.languages.CompletionItemKind.Function, insertText: 'str(${1:obj})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'int', kind: monaco.languages.CompletionItemKind.Function, insertText: 'int(${1:obj})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'float', kind: monaco.languages.CompletionItemKind.Function, insertText: 'float(${1:obj})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'bool', kind: monaco.languages.CompletionItemKind.Function, insertText: 'bool(${1:obj})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'input', kind: monaco.languages.CompletionItemKind.Function, insertText: 'input(${1:prompt})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'open', kind: monaco.languages.CompletionItemKind.Function, insertText: 'open(${1:file}, ${2:mode}, encoding=${3:utf-8})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'abs', kind: monaco.languages.CompletionItemKind.Function, insertText: 'abs(${1:num})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'max', kind: monaco.languages.CompletionItemKind.Function, insertText: 'max(${1:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'min', kind: monaco.languages.CompletionItemKind.Function, insertText: 'min(${1:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'sum', kind: monaco.languages.CompletionItemKind.Function, insertText: 'sum(${1:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'sorted', kind: monaco.languages.CompletionItemKind.Function, insertText: 'sorted(${1:iterable}, key=${2:key}, reverse=${3:False})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'reversed', kind: monaco.languages.CompletionItemKind.Function, insertText: 'reversed(${1:seq})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'enumerate', kind: monaco.languages.CompletionItemKind.Function, insertText: 'enumerate(${1:iterable}, start=${2:0})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'zip', kind: monaco.languages.CompletionItemKind.Function, insertText: 'zip(${1:*iterables})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'map', kind: monaco.languages.CompletionItemKind.Function, insertText: 'map(${1:func}, ${2:*iterables})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'filter', kind: monaco.languages.CompletionItemKind.Function, insertText: 'filter(${1:func}, ${2:iterable})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'reduce', kind: monaco.languages.CompletionItemKind.Function, insertText: 'from functools import reduce\nreduce(${1:func}, ${2:iterable}, ${3:initializer})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common code snippets
        { label: 'ifmain', kind: monaco.languages.CompletionItemKind.Snippet, insertText: "if __name__ == '__main__':\n\t${0}", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'withopen', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'with open(${1:file}, ${2:"r"}, encoding="utf-8") as ${3:f}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'forin', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for ${1:item} in ${2:iterable}:\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'tryexcept', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'try:\n\t${0}\nexcept Exception as ${1:e}:\n\tprint(f"Error: {${1:e}}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'classinit', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'class ${1:ClassName}:\n\tdef __init__(self, ${2:args}):\n\t\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'deffunc', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'def ${1:function_name}(${2:args}) -> ${3:return_type}:\n\t"""${4:Docstring}"""\n\t${0}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });

  // C/C++
  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['#', '.', '>', '(', '=', '<', '*', '&'],
    provideCompletionItems: (model, position) => {
      const suggestions = [
        // Preprocessor directives
        { label: '#include', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#include <${1:header}>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include ""', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#include "${1:header}"\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#define', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#define ${1:MACRO} ${2:value}\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#ifdef', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#ifdef ${1:MACRO}\n${0}\n#endif\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#ifndef', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#ifndef ${1:MACRO}\n${0}\n#endif\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#endif', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#endif\n' },
        { label: '#pragma once', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '#pragma once\n' },
        
        // Keywords
        { label: 'using namespace std;', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'using namespace std;\n' },
        { label: 'namespace', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'namespace ${1:name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'class', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'class ${1:Name} {\npublic:\n\t${1:Name}();\n\t~${1:Name}();\n\t${0}\nprivate:\n\t${2:members}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'struct', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'struct ${1:Name} {\n\t${0}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'union', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'union ${1:Name} {\n\t${0}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'enum', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'enum ${1:Name} {\n\t${0}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'enum class', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'enum class ${1:Name} {\n\t${0}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'typedef', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'typedef ${1:type} ${2:alias};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'using', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'using ${1:alias} = ${2:type};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Control flow
        { label: 'if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'if (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else if (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for each', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for (auto& ${1:item} : ${2:container}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'while', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'while (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'do while', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'do {\n\t${0}\n} while (${1:condition});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'switch', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'switch (${1:expression}) {\n\tcase ${2:value}:\n\t\t${0}\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'case', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'case ${1:value}:\n\t${0}\n\tbreak;', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'default', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'default:\n\t${0}\n\tbreak;', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'break', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'break;' },
        { label: 'continue', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'continue;' },
        { label: 'return', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'return ${1:value};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Memory management
        { label: 'new', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'new ${1:Type}(${2:args});' },
        { label: 'delete', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'delete ${1:ptr};' },
        { label: 'delete[]', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'delete[] ${1:ptr};' },
        { label: 'malloc', kind: monaco.languages.CompletionItemKind.Function, insertText: 'malloc(${1:size});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'calloc', kind: monaco.languages.CompletionItemKind.Function, insertText: 'calloc(${1:num}, ${2:size});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'realloc', kind: monaco.languages.CompletionItemKind.Function, insertText: 'realloc(${1:ptr}, ${2:size});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'free', kind: monaco.languages.CompletionItemKind.Function, insertText: 'free(${1:ptr});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common headers
        { label: '#include <iostream>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <iostream>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <vector>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <vector>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <string>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <string>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <map>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <map>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <set>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <set>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <algorithm>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <algorithm>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <cmath>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <cmath>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <cstdio>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <cstdio>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <cstdlib>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <cstdlib>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <ctime>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <ctime>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '#include <cstring>', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '#include <cstring>\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common functions
        { label: 'printf', kind: monaco.languages.CompletionItemKind.Function, insertText: 'printf("${1:format}", ${2:args});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'scanf', kind: monaco.languages.CompletionItemKind.Function, insertText: 'scanf("${1:format}", ${2:args});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'cout', kind: monaco.languages.CompletionItemKind.Variable, insertText: 'cout << ${1} << endl;', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'cin', kind: monaco.languages.CompletionItemKind.Variable, insertText: 'cin >> ${1};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'endl', kind: monaco.languages.CompletionItemKind.Variable, insertText: 'endl' },
        { label: 'exit', kind: monaco.languages.CompletionItemKind.Function, insertText: 'exit(${1:code});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'rand', kind: monaco.languages.CompletionItemKind.Function, insertText: 'rand();', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'srand', kind: monaco.languages.CompletionItemKind.Function, insertText: 'srand(${1:seed});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'time', kind: monaco.languages.CompletionItemKind.Function, insertText: 'time(${1:nullptr});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // STL containers
        { label: 'vector', kind: monaco.languages.CompletionItemKind.Class, insertText: 'vector<${1:Type}> ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'vector<int>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'vector<int> ${1:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'vector<string>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'vector<string> ${1:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'string', kind: monaco.languages.CompletionItemKind.Class, insertText: 'string ${1:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'map', kind: monaco.languages.CompletionItemKind.Class, insertText: 'map<${1:Key}, ${2:Value}> ${3:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'set', kind: monaco.languages.CompletionItemKind.Class, insertText: 'set<${1:Type}> ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'unordered_map', kind: monaco.languages.CompletionItemKind.Class, insertText: 'unordered_map<${1:Key}, ${2:Value}> ${3:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'unordered_set', kind: monaco.languages.CompletionItemKind.Class, insertText: 'unordered_set<${1:Type}> ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'queue', kind: monaco.languages.CompletionItemKind.Class, insertText: 'queue<${1:Type}> ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'stack', kind: monaco.languages.CompletionItemKind.Class, insertText: 'stack<${1:Type}> ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common code snippets
        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'int main() {\n\t${0}\n\treturn 0;\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'main with args', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'int main(int argc, char* argv[]) {\n\t${0}\n\treturn 0;\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'using namespace std;', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'using namespace std;\n' },
        { label: 'for loop', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:size}; ${1:i}++) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for each loop', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for (auto& ${1:item} : ${2:container}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'function', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '${1:returnType} ${2:name}(${3:params}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'class', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'class ${1:Name} {\npublic:\n\t${1:Name}();\n\t${1:Name}(const ${1:Name}& other);\n\t~${1:Name}();\n\t${1:Name}& operator=(const ${1:Name}& other);\n\t\n\t// Methods\n\t${0}\n\nprivate:\n\t// Members\n\t${2:members}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'struct', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'struct ${1:Name} {\n\t${0}\n};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'if (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'else {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'while', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'while (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'do while', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'do {\n\t${0}\n} while (${1:condition});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });

  // Java
  monaco.languages.registerCompletionItemProvider('java', {
    triggerCharacters: ['.', '(', '=', '<', '>'],
    provideCompletionItems: (model, position) => {
      const suggestions = [
        // Keywords
        { label: 'public', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'public ' },
        { label: 'private', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'private ' },
        { label: 'protected', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'protected ' },
        { label: 'static', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'static ' },
        { label: 'final', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'final ' },
        { label: 'abstract', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'abstract ' },
        { label: 'class', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'class ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'interface', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'interface ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'enum', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'enum ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'package', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'package ${1:com.example};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'import ${1:java.util.ArrayList};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import static', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'import static ${1:java.lang.Math.*};\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'if (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else if (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for each', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for (${1:Type} ${2:item} : ${3:collection}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'while', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'while (${1:condition}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'do while', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'do {\n\t${0}\n} while (${1:condition});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'switch', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'switch (${1:expression}) {\n\tcase ${2:value}:\n\t\t${0}\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'case', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'case ${1:value}:\n\t${0}\n\tbreak;' },
        { label: 'default', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'default:\n\t${0}\n\tbreak;' },
        { label: 'break', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'break;' },
        { label: 'continue', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'continue;' },
        { label: 'return', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'return ${1:value};' },
        { label: 'throw', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'throw new ${1:Exception}("${2:message}");', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'throws', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'throws ${1:Exception}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'try', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'try {\n\t${0}\n} catch (${1:Exception} ${2:e}) {\n\t${3:handle exception}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'catch', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'catch (${1:Exception} ${2:e}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'finally', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'finally {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'synchronized', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'synchronized (${1:object}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'volatile', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'volatile ${1:type} ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'transient', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'transient ${1:type} ${2:name};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common imports
        { label: 'import java.util.ArrayList', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.ArrayList;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.List', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.List;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.Map', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.Map;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.HashMap', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.HashMap;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.Set', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.Set;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.HashSet', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.HashSet;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.Arrays', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.Arrays;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.Collections', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.Collections;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.stream.Collectors', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.stream.Collectors;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.util.function.Function', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.util.function.Function;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import java.io.IOException', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import java.io.IOException;\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common classes and methods
        { label: 'System.out.println', kind: monaco.languages.CompletionItemKind.Method, insertText: 'System.out.println(${1});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'System.out.print', kind: monaco.languages.CompletionItemKind.Method, insertText: 'System.out.print(${1});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'System.in.read', kind: monaco.languages.CompletionItemKind.Method, insertText: 'System.in.read();', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Math.abs', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Math.abs(${1});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Math.max', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Math.max(${1}, ${2});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Math.min', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Math.min(${1}, ${2});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Math.sqrt', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Math.sqrt(${1});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Math.pow', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Math.pow(${1}, ${2});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Math.random', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Math.random();', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Arrays.toString', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Arrays.toString(${1:array});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Arrays.sort', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Arrays.sort(${1:array});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Collections.sort', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Collections.sort(${1:list});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Collections.reverse', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Collections.reverse(${1:list});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'String.valueOf', kind: monaco.languages.CompletionItemKind.Method, insertText: 'String.valueOf(${1:obj});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Integer.parseInt', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Integer.parseInt(${1:string});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Double.parseDouble', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Double.parseDouble(${1:string});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Boolean.parseBoolean', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Boolean.parseBoolean(${1:string});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common code snippets
        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public static void main(String[] args) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'class', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public class ${1:ClassName} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'interface', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public interface ${1:InterfaceName} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'constructor', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public ${1:ClassName}(${2:params}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'method', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public ${1:returnType} ${2:methodName}(${3:params}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'getter', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public ${1:type} get${2:PropertyName}() {\n\treturn ${3:propertyName};\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'setter', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'public void set${1:PropertyName}(${2:type} ${3:propertyName}) {\n\tthis.${3:propertyName} = ${3:propertyName};\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'arraylist', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'List<${1:Type}> ${2:name} = new ArrayList<>();\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'hashmap', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'Map<${1:KeyType}, ${2:ValueType}> ${3:name} = new HashMap<>();\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'hashset', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'Set<${1:Type}> ${2:name} = new HashSet<>();\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'trycatch', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'try {\n\t${0}\n} catch (${1:Exception} ${2:e}) {\n\t${2:e}.printStackTrace();\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'foreach', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for (${1:Type} ${2:item} : ${3:collection}) {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fori', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for (int ${1:i} = 0; ${1:i} < ${2:collection}.size(); ${1:i}++) {\n\t${3:Type} ${4:item} = ${2:collection}.get(${1:i});\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });

  // Go
  monaco.languages.registerCompletionItemProvider('go', {
    triggerCharacters: ['.', '(', '=', '<', '>', ':', '\''],
    provideCompletionItems: (model, position) => {
      const suggestions = [
        // Keywords
        { label: 'package', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'package ${1:main}\n', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'import', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'import (\n\t"${1:fmt}"\n)', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'func', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'func ${1:name}(${2:params}) ${3:returnType} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'func main', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'func main() {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'var', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'var ${1:name} ${2:type}${3: = ${4:value}}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'const', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'const ${1:name} ${2:type} = ${3:value}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'type', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'type ${1:name} ${2:type}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'struct', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'type ${1:Name} struct {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'interface', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'type ${1:Name} interface {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'map', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'map[${1:KeyType}]${2:ValueType}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'slice', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '[]${1:Type}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'array', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '[${1:size}]${2:Type}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'chan', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'chan ${1:Type}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'go', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'go ${1:func}(${2:args})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'if ${1:condition} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else if ${1:condition} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for ${1:condition} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for range', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for ${1:index}, ${2:value} := range ${3:collection} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'switch', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'switch ${1:expression} {\n\tcase ${2:value}:\n\t\t${0}\n\tdefault:\n\t\t${3:default case}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'case', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'case ${1:value}:\n\t${0}' },
        { label: 'default', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'default:\n\t${0}' },
        { label: 'break', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'break' },
        { label: 'continue', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'continue' },
        { label: 'return', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'return ${1:value}' },
        { label: 'defer', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'defer ${1:func}(${2:args})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'select', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'select {\n\tcase ${1:<-ch}:\n\t\t${0}\n\tdefault:\n\t\t${2:default case}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fallthrough', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'fallthrough' },
        { label: 'iota', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'iota' },
        
        // Common packages
        { label: '"fmt"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"fmt"' },
        { label: '"os"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"os"' },
        { label: '"io"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"io"' },
        { label: '"io/ioutil"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"io/ioutil"' },
        { label: '"bufio"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"bufio"' },
        { label: '"strings"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"strings"' },
        { label: '"strconv"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"strconv"' },
        { label: '"regexp"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"regexp"' },
        { label: '"math"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"math"' },
        { label: '"math/rand"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"math/rand"' },
        { label: '"sort"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"sort"' },
        { label: '"sync"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"sync"' },
        { label: '"time"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"time"' },
        { label: '"net/http"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"net/http"' },
        { label: '"encoding/json"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"encoding/json"' },
        { label: '"database/sql"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"database/sql"' },
        { label: '"context"', kind: monaco.languages.CompletionItemKind.Module, insertText: '"context"' },
        
        // Common functions
        { label: 'fmt.Println', kind: monaco.languages.CompletionItemKind.Function, insertText: 'fmt.Println(${1:args})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fmt.Printf', kind: monaco.languages.CompletionItemKind.Function, insertText: 'fmt.Printf("${1:format}", ${2:args})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fmt.Sprintf', kind: monaco.languages.CompletionItemKind.Function, insertText: 'fmt.Sprintf("${1:format}", ${2:args})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fmt.Scanln', kind: monaco.languages.CompletionItemKind.Function, insertText: 'fmt.Scanln(&${1:var})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'os.Args', kind: monaco.languages.CompletionItemKind.Variable, insertText: 'os.Args' },
        { label: 'os.Getenv', kind: monaco.languages.CompletionItemKind.Function, insertText: 'os.Getenv("${1:key}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'os.Setenv', kind: monaco.languages.CompletionItemKind.Function, insertText: 'os.Setenv("${1:key}", "${2:value}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'os.Exit', kind: monaco.languages.CompletionItemKind.Function, insertText: 'os.Exit(${1:code})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strings.Contains', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strings.Contains(${1:string}, "${2:substring}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strings.ToUpper', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strings.ToUpper(${1:string})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strings.ToLower', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strings.ToLower(${1:string})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strings.TrimSpace', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strings.TrimSpace(${1:string})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strings.Split', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strings.Split(${1:string}, "${2:separator}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strings.Join', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strings.Join(${1:slice}, "${2:separator}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strconv.Atoi', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strconv.Atoi(${1:string})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'strconv.Itoa', kind: monaco.languages.CompletionItemKind.Function, insertText: 'strconv.Itoa(${1:int})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'time.Now', kind: monaco.languages.CompletionItemKind.Function, insertText: 'time.Now()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'time.Sleep', kind: monaco.languages.CompletionItemKind.Function, insertText: 'time.Sleep(${1:duration})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'math.Abs', kind: monaco.languages.CompletionItemKind.Function, insertText: 'math.Abs(${1:float64})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'math.Sqrt', kind: monaco.languages.CompletionItemKind.Function, insertText: 'math.Sqrt(${1:float64})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'math.Pow', kind: monaco.languages.CompletionItemKind.Function, insertText: 'math.Pow(${1:base}, ${2:exponent})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'rand.Intn', kind: monaco.languages.CompletionItemKind.Function, insertText: 'rand.Intn(${1:max})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'rand.Seed', kind: monaco.languages.CompletionItemKind.Function, insertText: 'rand.Seed(${1:seed})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'sort.Ints', kind: monaco.languages.CompletionItemKind.Function, insertText: 'sort.Ints(${1:slice})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'sort.Strings', kind: monaco.languages.CompletionItemKind.Function, insertText: 'sort.Strings(${1:slice})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'json.Marshal', kind: monaco.languages.CompletionItemKind.Function, insertText: 'json.Marshal(${1:obj})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'json.Unmarshal', kind: monaco.languages.CompletionItemKind.Function, insertText: 'json.Unmarshal(${1:data}, &${2:obj})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        
        // Common code snippets
        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'package main\n\nimport (\n\t"fmt"\n)\n\nfunc main() {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'func', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'func ${1:name}(${2:params}) ${3:returnType} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'struct', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'type ${1:Name} struct {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'interface', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'type ${1:Name} interface {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'map', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '${1:name} := make(map[${2:KeyType}]${3:ValueType})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'slice', kind: monaco.languages.CompletionItemKind.Snippet, insertText: '${1:name} := make([]${2:Type}, ${3:len}, ${4:cap})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'goroutine', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'go func() {\n\t${0}\n}()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'defer', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'defer func() {\n\t${0}\n}()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if err != nil', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'if err != nil {\n\treturn ${1:nil, }err\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for range', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for ${1:index}, ${2:value} := range ${3:collection} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'switch', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'switch ${1:expression} {\n\tcase ${2:value}:\n\t\t${0}\n\tdefault:\n\t\t${3:default case}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      ];
      return { suggestions };
    }
  });

  // Rust
  monaco.languages.registerCompletionItemProvider('rust', {
    triggerCharacters: ['.', '(', '=', '<', '>', ':', '\'', '!'],
    provideCompletionItems: (model, position) => {
      const suggestions = [
        // Keywords
        { label: 'fn', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'fn ${1:name}(${2:params}) ${3:-> return_type} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fn main', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'fn main() {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'let', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'let ${1:name} = ${2:value};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'let mut', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'let mut ${1:name} = ${2:value};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'const', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'const ${1:NAME}: ${2:Type} = ${3:value};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'static', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'static ${1:NAME}: ${2:Type} = ${3:value};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'struct', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'struct ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'enum', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'enum ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'trait', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'trait ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'impl', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'impl ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'impl Trait for Type', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'impl ${1:Trait} for ${2:Type} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'mod', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'mod ${1:name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'use', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'use ${1:crate::module::Item};', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'pub', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'pub ${1:item}' },
        { label: 'pub mod', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'pub mod ${1:name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'pub fn', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'pub fn ${1:name}(${2:params}) ${3:-> return_type} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'pub struct', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'pub struct ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'if ${1:condition} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'else if', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'else if ${1:condition} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'match', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'match ${1:expression} {\n\t${2:pattern} => {\n\t\t${0}\n\t},\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'for ${1:item} in ${2:iterable} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'while', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'while ${1:condition} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'loop', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'loop {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'break', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'break' },
        { label: 'continue', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'continue' },
        { label: 'return', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'return ${1:value};' },
        { label: 'panic!', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'panic!("${1:message}");', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'unreachable!', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'unreachable!();' },
        { label: 'todo!', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'todo!();' },
        { label: 'unsafe', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'unsafe {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'async', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'async ${1:fn} ${2:name}(${3:params}) ${4:-> return_type} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'await', kind: monaco.languages.CompletionItemKind.Keyword, insertText: '.await' },
        { label: 'move', kind: monaco.languages.CompletionItemKind.Keyword, insertText: 'move ${1:closure}' },
        
        // Common types and literals
        { label: 'String', kind: monaco.languages.CompletionItemKind.Class, insertText: 'String' },
        { label: '&str', kind: monaco.languages.CompletionItemKind.TypeParameter, insertText: '&str' },
        { label: 'Vec<T>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'Vec<${1:Type}>' },
        { label: 'HashMap<K, V>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'HashMap<${1:Key}, ${2:Value}>' },
        { label: 'HashSet<T>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'HashSet<${1:Type}>' },
        { label: 'Option<T>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'Option<${1:Type}>' },
        { label: 'Result<T, E>', kind: monaco.languages.CompletionItemKind.Class, insertText: 'Result<${1:OkType}, ${2:ErrType}>' },
        { label: 'Some', kind: monaco.languages.CompletionItemKind.Constant, insertText: 'Some(${1:value})' },
        { label: 'None', kind: monaco.languages.CompletionItemKind.Constant, insertText: 'None' },
        { label: 'Ok', kind: monaco.languages.CompletionItemKind.Constant, insertText: 'Ok(${1:value})' },
        { label: 'Err', kind: monaco.languages.CompletionItemKind.Constant, insertText: 'Err(${1:error})' },
        { label: 'true', kind: monaco.languages.CompletionItemKind.Constant, insertText: 'true' },
        { label: 'false', kind: monaco.languages.CompletionItemKind.Constant, insertText: 'false' },
        
        // Common functions and methods
        { label: 'println!', kind: monaco.languages.CompletionItemKind.Function, insertText: 'println!("${1:format}", ${2:args});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'print!', kind: monaco.languages.CompletionItemKind.Function, insertText: 'print!("${1:format}", ${2:args});', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'format!', kind: monaco.languages.CompletionItemKind.Function, insertText: 'format!("${1:format}", ${2:args})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'String::new', kind: monaco.languages.CompletionItemKind.Method, insertText: 'String::new()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'String::from', kind: monaco.languages.CompletionItemKind.Method, insertText: 'String::from("${1:string}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '.to_string()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.to_string()' },
        { label: 'Vec::new', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Vec::new()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Vec::with_capacity', kind: monaco.languages.CompletionItemKind.Method, insertText: 'Vec::with_capacity(${1:capacity})', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '.push()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.push(${1:item});' },
        { label: '.pop()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.pop()' },
        { label: '.len()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.len()' },
        { label: '.is_empty()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.is_empty()' },
        { label: 'HashMap::new', kind: monaco.languages.CompletionItemKind.Method, insertText: 'HashMap::new()', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: '.insert()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.insert(${1:key}, ${2:value});' },
        { label: '.get()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.get(&${1:key})' },
        { label: '.contains_key()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.contains_key(&${1:key})' },
        { label: '.remove()', kind: monaco.languages.CompletionItemKind.Method, insertText: '.remove(&${1:key})' },
        { label: 'Result::unwrap', kind: monaco.languages.CompletionItemKind.Method, insertText: '.unwrap()' },
        { label: 'Result::expect', kind: monaco.languages.CompletionItemKind.Method, insertText: '.expect("${1:message}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Option::unwrap', kind: monaco.languages.CompletionItemKind.Method, insertText: '.unwrap()' },
        { label: 'Option::expect', kind: monaco.languages.CompletionItemKind.Method, insertText: '.expect("${1:message}")', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Option::unwrap_or', kind: monaco.languages.CompletionItemKind.Method, insertText: '.unwrap_or(${1:default})' },
        { label: 'Option::map', kind: monaco.languages.CompletionItemKind.Method, insertText: '.map(|${1:item}| ${2:expression})' },
        { label: 'Option::and_then', kind: monaco.languages.CompletionItemKind.Method, insertText: '.and_then(|${1:item}| ${2:expression})' },
        
        // Common code snippets
        { label: 'main', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'fn main() {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'fn', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'fn ${1:name}(${2:params}) ${3:-> return_type} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'struct', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'struct ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'enum', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'enum ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'impl', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'impl ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'trait', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'trait ${1:Name} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'match', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'match ${1:expression} {\n\t${2:pattern} => {\n\t\t${0}\n\t},\n\t_ => {\n\t\t${3:default case}\n\t},\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'if let', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'if let Some(${1:value}) = ${2:option} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'while let', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'while let Some(${1:value}) = ${2:option} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'for', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'for ${1:item} in ${2:iterable} {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'loop', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'loop {\n\t${0}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'vec!', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'vec![${1:items}]', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'hashmap!', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'hashmap!{\n\t${1:key} => ${2:value},\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'println!', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'println!("${1:Hello, world!}");', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet },
        { label: 'Ok(())', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'Ok(())' },
        { label: 'Err(e)', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'Err(${1:e})' },
        { label: 'Some(value)', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'Some(${1:value})' },
        { label: 'None', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'None' }
      ];
      return { suggestions };
    }
  });
}

// Make function globally available
if (typeof window !== 'undefined') {
  window.registerCompletionProviders = registerCompletionProviders;
} else if (typeof global !== 'undefined') {
  global.registerCompletionProviders = registerCompletionProviders;
}