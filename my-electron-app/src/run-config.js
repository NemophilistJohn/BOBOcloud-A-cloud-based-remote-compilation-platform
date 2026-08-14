// src/run-config.js — Run configuration: per-workspace & per-language
// compile args / program args, edited in a popover next to the Run button.
//
// 用户视角工作流：
//   1. 打开项目，点 Run 旁的 ⚙ 按钮（或仅在需要时配置一次）；
//   2. 弹层中按当前文件语言显示两栏：编译参数（编译型语言）与程序参数；
//   3. 配置按 工作区×语言 记忆在 localStorage，之后每次运行自动携带；
//   4. 参数以 argv 数组发给服务端（不经 shell 拼接， quoting 安全）。
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  var STORAGE_KEY = 'bobocloud.runconfig.v1';

  // 编译型语言（显示编译参数栏）；解释型语言只显示程序参数
  var COMPILED_LANGS = { c: true, cpp: true, java: true, go: true, rust: true };
  var LANG_NAMES = { c: 'C', cpp: 'C++', java: 'Java', go: 'Go', rust: 'Rust', python: 'Python', node: 'Node.js' };

  // 文件扩展名 → 语言（与服务端插件注册表一致）
  var EXT_LANG = {
    '.c': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
    '.java': 'java', '.go': 'go', '.rs': 'rust', '.py': 'python',
    '.js': 'node', '.mjs': 'node', '.cjs': 'node'
  };

  function languageForFile(filePath) {
    var m = /\.([A-Za-z0-9]+)$/.exec(filePath || '');
    if (!m) return null;
    return EXT_LANG['.' + m[1].toLowerCase()] || null;
  }

  // ──── 持久化 ────
  function loadAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch (e) { return {}; }
  }
  function saveAll(all) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch (e) {}
  }
  function configKey(lang) {
    return (S.workspaceRoot || '_global') + '|' + lang;
  }
  function getRaw(lang) {
    var all = loadAll();
    return all[configKey(lang)] || { compile: '', run: '' };
  }
  function setRaw(lang, data) {
    var all = loadAll();
    all[configKey(lang)] = data;
    saveAll(all);
  }

  // ──── 参数解析（支持引号）────
  // "-DMSG=hello world" 写法需引号：-DMSG="hello world"
  function splitArgs(str) {
    var out = [], cur = '', quote = null, esc = false;
    str = str || '';
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (esc) { cur += ch; esc = false; continue; }
      if (ch === '\\' && quote !== "'") { esc = true; continue; }
      if (quote) {
        if (ch === quote) quote = null; else cur += ch;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (/\s/.test(ch)) {
        if (cur) { out.push(cur); cur = ''; }
        continue;
      }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // getArgs 返回当前语言已配置的参数（argv 数组形式）
  function getArgs(lang) {
    var raw = getRaw(lang);
    return {
      compileArgs: splitArgs(raw.compile),
      runArgs: splitArgs(raw.run)
    };
  }

  // ──── Popover UI ────
  var currentLang = null;

  function $(id) { return document.getElementById(id); }

  function openPopover() {
    var pop = $('run-config-pop');
    var active = S.tabs.find(function(t) { return t.path === S.activeTabPath; });
    currentLang = active ? languageForFile(active.path) : null;

    var langLabel = $('rc-lang');
    if (currentLang) {
      langLabel.textContent = '— ' + (LANG_NAMES[currentLang] || currentLang);
      var raw = getRaw(currentLang);
      $('rc-compile-args').value = raw.compile;
      $('rc-run-args').value = raw.run;
      var isCompiled = !!COMPILED_LANGS[currentLang];
      $('rc-compile-field').style.display = isCompiled ? '' : 'none';
      $('rc-hint').textContent = isCompiled
        ? 'Saved per workspace & language. Compile args are appended to the compiler command.'
        : 'Saved per workspace & language. Program args are passed to the script (argv).';
    } else {
      langLabel.textContent = '— no runnable file open';
      $('rc-compile-field').style.display = 'none';
      $('rc-hint').textContent = 'Open a source file (.c .cpp .java .go .rs .py .js) to configure its run.';
    }

    // 定位在按钮下方
    var btn = $('run-config-btn');
    var rect = btn.getBoundingClientRect();
    pop.style.display = 'block';
    var pw = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(rect.right - pw, global.innerWidth - pw - 8)) + 'px';
    pop.style.top = (rect.bottom + 6) + 'px';

    setTimeout(function() { document.addEventListener('click', onClickOutside); }, 0);
  }

  function closePopover() {
    var pop = $('run-config-pop');
    if (pop) pop.style.display = 'none';
    document.removeEventListener('click', onClickOutside);
  }

  function onClickOutside(e) {
    var pop = $('run-config-pop');
    if (!pop.contains(e.target) && e.target.id !== 'run-config-btn' && !e.target.closest('#run-config-btn')) {
      closePopover();
    }
  }

  function onInput() {
    if (!currentLang) return;
    setRaw(currentLang, {
      compile: $('rc-compile-args').value,
      run: $('rc-run-args').value
    });
  }

  function init() {
    var btn = $('run-config-btn');
    if (!btn) return;
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var pop = $('run-config-pop');
      if (pop.style.display === 'block') closePopover(); else openPopover();
    });
    $('rc-compile-args').addEventListener('input', onInput);
    $('rc-run-args').addEventListener('input', onInput);
    // 弹层内回车不触发全局快捷键
    $('run-config-pop').addEventListener('keydown', function(e) { e.stopPropagation(); });
  }

  BOBO.runConfig = {
    init: init,
    languageForFile: languageForFile,
    getArgs: getArgs
  };
})(window);
