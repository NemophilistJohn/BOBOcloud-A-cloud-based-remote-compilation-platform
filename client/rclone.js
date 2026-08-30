// rclone.js - Layer 1: Rclone 核心模块（主进程，纯 Node.js）
//
// 职责：
//   - SFTP 配置管理（ensureConfig）
//   - 同步执行（spawn 流式 + 错误归一化 + 重试）
//   - 对主进程受管 rclone 的精确版本检查
//
// 不依赖 Electron，可独立测试。

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// 常量
// ============================================================

const isWindows = process.platform === 'win32';
const EXE_NAME = isWindows ? 'rclone.exe' : 'rclone';
const REMOTE_NAME = 'cloud-compiler-sftp';

// 与服务端 files.go artifactIgnoredDirs 保持一致
const DEFAULT_EXCLUDES = [
  '**/target/**', '**/.git/**', '**/node_modules/**',
	'**/__pycache__/**', '**/.bobocloud/**', '**/.bobocloud-team.json'
];

const DEFAULT_TIMEOUT_MS = 300000;     // 5 分钟
const DEFAULT_RETRIES = 1;
const STDERR_TAIL_SIZE = 8192;         // 报错时保留的 stderr 尾部

function requireManagedExecutable(executablePath) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw new Error('A managed absolute rclone executable path is required');
  }
  var stat = fs.statSync(executablePath);
  if (!stat.isFile()) throw new Error('The managed rclone executable is not a regular file');
  return executablePath;
}

function requireManagedConfig(configPath, createParent) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) {
    throw new Error('An app-managed absolute rclone config path is required');
  }
  const parent = path.dirname(configPath);
  if (createParent) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('The app-managed rclone config directory is unsafe');
  }
  if (fs.existsSync(configPath)) {
    const configStat = fs.lstatSync(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink()) {
      throw new Error('The app-managed rclone config is unsafe');
    }
  } else if (!createParent) {
    throw new Error('The app-managed rclone config is missing');
  }
  return configPath;
}

// ============================================================
// 配置管理
// ============================================================

async function ensureConfig(settings, executablePath, configPath) {
  if (!settings || !settings.ip || !settings.user) {
    return { success: false, error: 'missing ip or user in settings' };
  }

  try {
    configPath = requireManagedConfig(configPath, true);
  } catch (error) {
    return { success: false, error: error.message };
  }

  var detected = await checkVersion(executablePath, 'managed');
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
    '--config', configPath,
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
    execFile(rcloneExecutable, args, { windowsHide: true, timeout: 30000 }, function(error, stdout, stderr) {
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
    var exe;
    try {
      exe = requireManagedExecutable(opts.executablePath);
    } catch (error) {
      resolve({
        success: false,
        error: { type: 'EXECUTABLE_UNAVAILABLE', message: error.message },
        stats: { durationMs: 0 }
      });
      return;
    }
    var excludes = opts.excludes || DEFAULT_EXCLUDES;
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    var onProgress = opts.onProgress;
    var configPath;
    try {
      configPath = requireManagedConfig(opts.configPath, false);
    } catch (error) {
      resolve({
        success: false,
        error: { type: 'CONFIG_UNAVAILABLE', message: error.message },
        stats: { durationMs: 0 }
      });
      return;
    }

    var isPull = opts.direction === 'pull';
    var localPath = opts.src || opts.dest;
    var args = isPull
      ? ['--config', configPath, 'sync', REMOTE_NAME + ':' + opts.remotePath, localPath]
      : ['--config', configPath, 'sync', localPath, REMOTE_NAME + ':' + opts.remotePath];
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

      var version = stdout ? stdout.split('\n')[0].trim() : '';
      if (!/^rclone v(?:\d|\s)/i.test(version)) {
        resolve({
          available: false,
          path: candidate.path,
          source: candidate.source,
          code: 'INVALID_RCLONE',
          error: 'Executable did not identify itself as rclone'
        });
        return;
      }
      resolve({
        available: true,
        path: candidate.path,
        source: candidate.source,
        version: version
      });
    });
  });
}

async function checkVersion(executablePath, source) {
  try {
    return await probeVersion({
      path: requireManagedExecutable(executablePath),
      source: source || 'managed'
    });
  } catch (error) {
    return {
      available: false,
      path: typeof executablePath === 'string' ? executablePath : null,
      source: source || 'managed',
      code: error.code || null,
      error: error.message
    };
  }
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
  requireManagedExecutable: requireManagedExecutable,
  requireManagedConfig: requireManagedConfig,
  ensureConfig: ensureConfig,
  sync: sync,
  pull: pull,
  checkVersion: checkVersion
};
