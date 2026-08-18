// rclone.js - Layer 1: Rclone 核心模块（主进程，纯 Node.js）
//
// 职责：
//   - 路径规整（单一来源，合并原 main.js 内联 + utils.js 两份实现）
//   - SFTP 配置管理（ensureConfig）
//   - 同步执行（spawn 流式 + 错误归一化 + 重试）
//   - 版本检查 / PATH 查找
//
// 不依赖 Electron，可独立测试。

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// 常量
// ============================================================

const isWindows = process.platform === 'win32';
const isMacOS = process.platform === 'darwin';

const EXE_NAME = isWindows ? 'rclone.exe' : 'rclone';
const REMOTE_NAME = 'cloud-compiler-sftp';

// 与服务端 files.go artifactIgnoredDirs 保持一致
const DEFAULT_EXCLUDES = [
  '**/target/**', '**/.git/**', '**/node_modules/**',
	'**/__pycache__/**', '**/.bobocloud/**', '**/.bobocloud-team.json'
];

const DEFAULT_TIMEOUT_MS = 300000;     // 5 分钟
const DEFAULT_RETRIES = 1;
const executableCache = new Map();
const STDERR_TAIL_SIZE = 8192;         // 报错时保留的 stderr 尾部

const CONFIG_DIR = (function() {
  if (isWindows) return path.join(process.env.APPDATA || '', 'rclone');
  if (isMacOS) return path.join(process.env.HOME || '', 'Library', 'Application Support', 'rclone');
  return path.join(process.env.HOME || '', '.config', 'rclone');
})();
const EXECUTABLE_CACHE_DIR = path.join(CONFIG_DIR, 'bobocloud-bin');

// ============================================================
// 路径规整（合并原 main.js 内联 + utils.js 两份实现）
// ============================================================

function stripWrappingQuotes(value) {
  var trimmed = String(value || '').trim();
  if (trimmed.length >= 2) {
    var first = trimmed.charAt(0);
    var last = trimmed.charAt(trimmed.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function expandWindowsEnvironmentVariables(value) {
  if (!isWindows) return value;
  return value.replace(/%([^%]+)%/g, function(match, name) {
    return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : match;
  });
}

function normalizeRequestedPath(rclonePath) {
  var exe = expandWindowsEnvironmentVariables(stripWrappingQuotes(rclonePath));
  if (!exe) return '';

  // A directory named "rclone" used to be mistaken for an extension-less
  // executable. Check the filesystem before applying filename heuristics.
  try {
    if (fs.existsSync(exe) && fs.statSync(exe).isDirectory()) {
      return path.join(exe, EXE_NAME);
    }
  } catch (error) {
    // Continue with syntax-based normalization; probing reports the real error.
  }

  var lastPart = exe.split(/[/\\]/).pop();
  if (exe.endsWith('/') || exe.endsWith('\\')) {
    return exe + EXE_NAME;
  }
  if (lastPart.toLowerCase() === 'rclone' && isWindows) {
    return exe + '.exe';
  }
  return exe;
}

function executableCandidates(rclonePath) {
  var candidates = [];
  var seen = new Set();

  function add(candidatePath, source) {
    if (!candidatePath) return;
    var key = isWindows ? candidatePath.toLowerCase() : candidatePath;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: candidatePath, source: source });
  }

  var configured = normalizeRequestedPath(rclonePath);
  if (configured) add(configured, 'configured');

  if (process.resourcesPath) {
    add(path.join(process.resourcesPath, 'rclone', EXE_NAME), 'bundled');
  }
  add(path.join(__dirname, 'rclone', EXE_NAME), 'development');
  add(EXE_NAME, 'path');
  return candidates;
}

function isExecutableFile(candidatePath) {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch (error) {
    return false;
  }
}

function ensureExecutableCandidate(candidate) {
  if (isWindows || candidate.source !== 'bundled' || !isExecutableFile(candidate.path)) return candidate;
  var sourceStat = fs.statSync(candidate.path);
  if ((sourceStat.mode & 0o111) !== 0) return candidate;

  // Cross-platform packages built on Windows can contain the correct Unix
  // binary without an executable mode. Copy it to user-writable storage so
  // the packaged application can repair the mode without mutating itself.

  fs.mkdirSync(EXECUTABLE_CACHE_DIR, { recursive: true });
  var cachedPath = path.join(EXECUTABLE_CACHE_DIR, EXE_NAME + '-' + sourceStat.size + '-' + Math.floor(sourceStat.mtimeMs));
  var cacheNeedsRefresh = true;
  try {
    cacheNeedsRefresh = fs.statSync(cachedPath).size !== sourceStat.size;
  } catch (error) {}
  if (cacheNeedsRefresh) {
    var temporaryPath = cachedPath + '.tmp-' + process.pid + '-' + Date.now();
    try {
      fs.copyFileSync(candidate.path, temporaryPath);
      fs.chmodSync(temporaryPath, 0o755);
      fs.renameSync(temporaryPath, cachedPath);
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch (error) {}
    }
  } else {
    fs.chmodSync(cachedPath, 0o755);
  }
  return { path: cachedPath, source: candidate.source };
}

function resolveExecutable(rclonePath) {
  var candidates = executableCandidates(rclonePath);
  var cacheKey = stripWrappingQuotes(rclonePath || '');
  var cached = executableCache.get(cacheKey);
  if (cached && (cached.source === 'path' || isExecutableFile(cached.path))) {
    return {
      path: cached.path,
      source: cached.source,
      candidates: candidates
    };
  }

  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].source !== 'path' && isExecutableFile(candidates[i].path)) {
      var executable = ensureExecutableCandidate(candidates[i]);
      return {
        path: executable.path,
        source: executable.source,
        candidates: candidates
      };
    }
  }

  var pathCandidate = candidates.find(function(candidate) { return candidate.source === 'path'; });
  return {
    path: pathCandidate ? pathCandidate.path : EXE_NAME,
    source: 'path',
    candidates: candidates
  };
}

function normalizePath(rclonePath) {
  return resolveExecutable(rclonePath).path;
}

// ============================================================
// 配置管理
// ============================================================

async function ensureConfig(settings) {
  if (!settings || !settings.ip || !settings.user) {
    return { success: false, error: 'missing ip or user in settings' };
  }

  if (!fs.existsSync(CONFIG_DIR)) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    } catch (error) {
      return { success: false, error: 'failed to create rclone config dir: ' + error.message };
    }
  }

  var detected = await checkVersion(settings.rclonePath);
  if (!detected.available) {
    return {
      success: false,
      error: detected.error,
      attempts: detected.attempts || []
    };
  }
  var rcloneExecutable = detected.path;

  // 用 execFile + 参数数组执行，避免经 shell 解析带来的命令注入风险
  var args = [
    'config', 'create', REMOTE_NAME, 'sftp',
    'host=' + settings.ip,
    'user=' + settings.user,
    'port=22'
  ];
  if (settings.pass) {
    args.push('pass=' + settings.pass);
  }
  args.push('--non-interactive');

  return new Promise(function(resolve) {
    execFile(rcloneExecutable, args, { windowsHide: true }, function(error, stdout, stderr) {
      if (error) {
        console.error('[rclone] config create failed:', error.message);
        console.error('[rclone] stderr:', stderr);
        resolve({ success: false, error: error.message });
      } else {
        console.log('[rclone] config updated successfully');
        resolve({ success: true });
      }
    });
  });
}

// ============================================================
// 错误归一化
// ============================================================

function classifyError(error, stderr, timedOut) {
  if (timedOut) {
    return { type: 'TIMEOUT', message: 'rclone timed out' };
  }
  if (!error) {
    return null;
  }

  // Node.js error.code: ENOENT = 可执行文件不存在
  if (error.code === 'ENOENT') {
    return { type: 'BINARY_NOT_FOUND', message: 'rclone executable not found' };
  }

  // 按 stderr 关键词分类（rclone 输出固定为英文，与系统 locale 无关）
  var s = (stderr || '').toLowerCase();
  if (s.includes('auth') || s.includes('permission denied') || s.includes('password')) {
    return { type: 'AUTH_FAILED', message: 'Authentication failed' };
  }
  if (s.includes('connection refused') || s.includes('could not connect') ||
      s.includes('dial') || s.includes('ssh:') || s.includes('network is unreachable')) {
    return { type: 'CONNECTION_FAILED', message: 'SFTP connection failed' };
  }

  var exitCode = null;
  if (typeof error.code === 'number') {
    exitCode = error.code;
  }
  return { type: 'UNKNOWN', message: error.message, exitCode: exitCode };
}

// ============================================================
// 同步
// ============================================================

// syncOnce 执行一次同步（无重试）
function syncOnce(opts) {
  return new Promise(function(resolve) {
    var exe = normalizePath(opts.rclonePath);
    var excludes = opts.excludes || DEFAULT_EXCLUDES;
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var onProgress = opts.onProgress;

    var isPull = opts.direction === 'pull';
    var localPath = opts.src || opts.dest;
    var args = isPull
      ? ['sync', REMOTE_NAME + ':' + opts.remotePath, localPath]
      : ['sync', localPath, REMOTE_NAME + ':' + opts.remotePath];
    for (var i = 0; i < excludes.length; i++) {
      args.push('--exclude', excludes[i]);
    }
    args.push('--stats-one-line', '--stats', '5s',
              '--contimeout', '30s', '--timeout', '120s');

    var child = spawn(exe, args, { windowsHide: true });
    var stderrTail = '';
    var timedOut = false;
    var resolved = false;
    var startTime = Date.now();

    function resolveOnce(result) {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    }

    var timer = setTimeout(function() {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (e) {}
    }, timeoutMs);

    // stdout：rclone sync 正常无输出，保留以防万一
    child.stdout.on('data', function(data) {
      var text = data.toString().trim();
      if (onProgress && text) {
        onProgress(text);
      }
    });

    // stderr：rclone 的 --stats-one-line 进度行走这里
    child.stderr.on('data', function(data) {
      var lines = data.toString().split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        if (onProgress) onProgress(line);
        // 维护尾部 ring buffer 用于报错上下文
        stderrTail = (stderrTail + line + '\n').slice(-STDERR_TAIL_SIZE);
      }
    });

    // spawn 本身失败（如 ENOENT）
    child.on('error', function(error) {
      clearTimeout(timer);
      var classified = classifyError(error, stderrTail, false);
      resolveOnce({
        success: false,
        error: classified,
        stats: { durationMs: Date.now() - startTime }
      });
    });

    child.on('close', function(code) {
      clearTimeout(timer);
      var durationMs = Date.now() - startTime;

      if (code === 0 && !timedOut) {
        resolveOnce({ success: true, error: null, stats: { durationMs: durationMs } });
      } else {
        var fakeError = { message: 'rclone exited with code ' + code, code: code };
        var classified = classifyError(fakeError, stderrTail, timedOut);
        resolveOnce({
          success: false,
          error: classified,
          stats: { durationMs: durationMs }
        });
      }
    });
  });
}

// sync 执行同步（带重试，仅对瞬态错误重试）
async function sync(opts) {
  var maxAttempts = 1 + (opts.retries !== undefined ? opts.retries : DEFAULT_RETRIES);
  var lastResult = null;

  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await syncOnce(opts);
    if (lastResult.success) return lastResult;

    var retryable = lastResult.error &&
      (lastResult.error.type === 'CONNECTION_FAILED' || lastResult.error.type === 'TIMEOUT');
    if (!retryable || attempt === maxAttempts - 1) return lastResult;

    // 指数退避：2s, 4s, ...
    var backoffMs = 2000 * Math.pow(2, attempt);
    await new Promise(function(r) { setTimeout(r, backoffMs); });
  }

  return lastResult;
}

async function pull(opts) {
  var pullOptions = Object.assign({}, opts, { direction: 'pull' });
  return sync(pullOptions);
}

// ============================================================
// 版本检查
// ============================================================

function probeVersion(candidate) {
  return new Promise(function(resolve) {
    execFile(candidate.path, ['--version'], { windowsHide: true, timeout: 10000 }, function(error, stdout) {
      if (error) {
        resolve({
          available: false,
          path: candidate.path,
          source: candidate.source,
          code: error.code || null,
          error: error.code === 'ENOENT' ? 'executable not found' : error.message
        });
        return;
      }

      resolve({
        available: true,
        path: candidate.path,
        source: candidate.source,
        version: stdout ? stdout.split('\n')[0].trim() : null
      });
    });
  });
}

async function checkVersion(rclonePath) {
  var candidates = executableCandidates(rclonePath);
  var attempts = [];

  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (candidate.source !== 'path' && !isExecutableFile(candidate.path)) {
      attempts.push({
        path: candidate.path,
        source: candidate.source,
        code: 'ENOENT',
        error: 'executable not found'
      });
      continue;
    }

    try {
      candidate = ensureExecutableCandidate(candidate);
    } catch (error) {
      attempts.push({
        path: candidate.path,
        source: candidate.source,
        code: error.code || null,
        error: 'failed to prepare executable: ' + error.message
      });
      continue;
    }

    var result = await probeVersion(candidate);
    if (result.available) {
      executableCache.set(stripWrappingQuotes(rclonePath || ''), {
        path: result.path,
        source: result.source
      });
      result.attempts = attempts;
      return result;
    }
    attempts.push({
      path: result.path,
      source: result.source,
      code: result.code,
      error: result.error
    });
  }

  var configuredFailed = attempts.some(function(attempt) {
    return attempt.source === 'configured';
  });
  return {
    available: false,
    path: null,
    source: null,
    error: configuredFailed
      ? 'Configured rclone is unavailable and no bundled or PATH fallback could be started'
      : 'No bundled or PATH rclone executable could be started',
    attempts: attempts
  };
}

// ============================================================
// PATH 查找
// ============================================================

async function findInPath() {
  var cmd = isWindows ? 'where' : 'which';
  return new Promise(function(resolve) {
    execFile(cmd, ['rclone'], { windowsHide: true, timeout: 5000 }, function(error, stdout) {
      if (error) {
        resolve({ path: null, error: 'rclone not found in PATH' });
      } else {
        var found = stdout.trim().split('\n')[0].trim();
        resolve({ path: found, error: null });
      }
    });
  });
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  EXE_NAME: EXE_NAME,
  REMOTE_NAME: REMOTE_NAME,
  DEFAULT_EXCLUDES: DEFAULT_EXCLUDES,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES: DEFAULT_RETRIES,
  normalizeRequestedPath: normalizeRequestedPath,
  executableCandidates: executableCandidates,
  ensureExecutableCandidate: ensureExecutableCandidate,
  resolveExecutable: resolveExecutable,
  normalizePath: normalizePath,
  ensureConfig: ensureConfig,
  sync: sync,
  pull: pull,
  checkVersion: checkVersion,
  findInPath: findInPath
};
