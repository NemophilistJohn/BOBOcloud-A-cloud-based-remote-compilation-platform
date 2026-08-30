// src/utils.js — Pure utility functions
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  // ──── Language detection ────
  BOBO.detectLanguage = function(filename, content) {
    var f = filename.toLowerCase();
    if (f.endsWith('.ts')) return 'typescript';
    if (f.endsWith('.js')) return 'javascript';
    if (f.endsWith('.jsx')) return 'javascript';
    if (f.endsWith('.tsx')) return 'typescript';
    if (f.endsWith('.jsonc')) return 'json';
    if (f.endsWith('.py')) return 'python';
    if (f.endsWith('.cpp') || f.endsWith('.cc') || f.endsWith('.cxx')) return 'cpp';
    if (f.endsWith('.c')) return 'c';
    if (f.endsWith('.java')) return 'java';
    if (f.endsWith('.json')) return 'json';
    if (f.endsWith('.md')) return 'markdown';
    if (f.endsWith('.html')) return 'html';
    if (f.endsWith('.css')) return 'css';
    if (f.endsWith('.scss') || f.endsWith('.sass')) return 'scss';
    if (f.endsWith('.less')) return 'less';
    if (f.endsWith('.sh') || f.endsWith('.bash') || f.endsWith('.zsh')) return 'shell';
    if (f.endsWith('.go')) return 'go';
    if (f.endsWith('.rs')) return 'rust';
    if (f.endsWith('.sql')) return 'sql';
    if (f.endsWith('.xml')) return 'xml';
    if (f.endsWith('.yaml') || f.endsWith('.yml')) return 'yaml';
    // shebang check
    if (content && content.startsWith('#!')) {
      if (content.indexOf('python') !== -1) return 'python';
      if (content.indexOf('node') !== -1) return 'javascript';
      if (content.indexOf('bash') !== -1 || content.indexOf('sh') !== -1) return 'shell';
      if (content.indexOf('go') !== -1) return 'go';
      if (content.indexOf('rust') !== -1) return 'rust';
    }
    return 'plaintext';
  };

  // ──── Image detection ────
  BOBO.isImageFile = function(filename) {
    var imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.svg', '.webp'];
    var ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    return imageExtensions.indexOf(ext) !== -1;
  };

  // ---- Project key (avoid duplicate folder name collision) ----
  BOBO.projectKey = function(workspaceRoot) {
    var normalized = workspaceRoot.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    var hash = 0;
    for (var i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
    }
    return 'p' + Math.abs(hash).toString(36);
  };

  BOBO.isWindowsLocalPath = function(value) {
    var localPath = String(value || '');
    return /^[A-Za-z]:[\\/]/.test(localPath) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(localPath) || /^\/\/[^/]+\/[^/]+/.test(localPath);
  };

  BOBO.localPathSeparator = function(value) {
    return BOBO.isWindowsLocalPath(value) ? '\\' : '/';
  };

  // ──── Language display names ────
  BOBO.langDisplayName = function(langId) {
    var names = {
      'python': 'Python', 'javascript': 'JavaScript', 'typescript': 'TypeScript',
      'java': 'Java', 'c': 'C', 'cpp': 'C++', 'go': 'Go', 'rust': 'Rust',
      'json': 'JSON', 'markdown': 'Markdown', 'html': 'HTML', 'css': 'CSS',
      'shell': 'Shell', 'plaintext': 'Plain Text', 'sql': 'SQL', 'xml': 'XML',
      'yaml': 'YAML', 'php': 'PHP', 'ruby': 'Ruby'
    };
    return names[langId] || langId;
  };
})(window);
