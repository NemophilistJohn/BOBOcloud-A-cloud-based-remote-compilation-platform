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
const { writeFileAtomicSync } = require('./main/atomic-file');
const { DEFAULT_EXCLUDES } = require('./rclone-policy');

// ============================================================
// 常量
// ============================================================

const isWindows = process.platform === 'win32';
const EXE_NAME = isWindows ? 'rclone.exe' : 'rclone';
const REMOTE_NAME = 'cloud-compiler-sftp';

const DEFAULT_TIMEOUT_MS = 300000;     // 5 分钟
const DEFAULT_RETRIES = 1;
const STDERR_TAIL_SIZE = 8192;         // 报错时保留的 stderr 尾部
const CONNECTION_CHECK_TIMEOUT_MS = 15000;

function fixedFailure(message, code) {
  return { success: false, error: message, code: code || null };
}

function obscurePassword(executablePath, password, options) {
  options = options || {};
  return new Promise(function(resolve) {
    var child;
    var executor = typeof options.execFile === 'function' ? options.execFile : execFile;
    try {
      child = executor(executablePath, ['obscure', '-'], {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 16 * 1024,
        signal: options.signal
      }, function(error, stdout) {
        if (error) {
          resolve(fixedFailure('Could not protect the SFTP password for rclone', error.code));
          return;
        }
        var obscured = String(stdout || '').trim();
        if (!obscured || obscured.length > 8192 || /\s/.test(obscured)) {
          resolve(fixedFailure('rclone returned an invalid protected password'));
          return;
        }
        resolve({ success: true, value: obscured });
      });
      if (!child || !child.stdin || typeof child.stdin.end !== 'function') {
        resolve(fixedFailure('Could not send the SFTP password to rclone securely'));
        return;
      }
      if (typeof child.stdin.on === 'function') child.stdin.on('error', function() {});
      child.stdin.end(String(password) + '\n');
    } catch (error) {
      resolve(fixedFailure('Could not protect the SFTP password for rclone', error && error.code));
    }
  });
}

function safeConfigValue(value, name, maximum, trim) {
  var text = String(value || '');
  if (trim !== false) text = text.trim();
  if (!text || Buffer.byteLength(text, 'utf8') > maximum || /[\0\r\n]/.test(text)) {
    throw new Error('Invalid ' + name + ' in SFTP settings');
  }
  return text;
}

function windowsTaskkillPath() {
  var windowsRoot = process.env.SystemRoot || process.env.WINDIR || '';
  return path.isAbsolute(windowsRoot) ? path.join(windowsRoot, 'System32', 'taskkill.exe') : '';
}

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

async function ensureConfig(settings, executablePath, configPath, options) {
  if (!settings || !settings.ip || !settings.user) {
    return { success: false, error: 'missing ip or user in settings' };
  }

  try {
    configPath = requireManagedConfig(configPath, true);
  } catch (error) {
    return { success: false, error: error.message };
  }

  options = options || {};
  var versionChecker = typeof options.checkVersion === 'function' ? options.checkVersion : checkVersion;
  var detected = await versionChecker(executablePath, 'managed');
  if (!detected.available) {
    return {
      success: false,
      error: detected.error,
      attempts: detected.attempts || []
    };
  }
  var rcloneExecutable = detected.path;

  try {
    var host = safeConfigValue(settings.ip, 'host', 1024);
    var user = safeConfigValue(settings.user, 'user', 1024);
    var pass = safeConfigValue(settings.pass, 'password', 64 * 1024, false);
    var protectedPassword = await obscurePassword(rcloneExecutable, pass, options);
    if (!protectedPassword.success) return protectedPassword;
    if (options.signal && options.signal.aborted) return fixedFailure('rclone configuration was cancelled', 'CANCELLED');
    var content = [
      '[' + REMOTE_NAME + ']',
      'type = sftp',
      'host = ' + host,
      'user = ' + user,
      'port = 22',
      'pass = ' + protectedPassword.value,
      ''
    ].join('\n');
    writeFileAtomicSync(configPath, content, { maxBytes: 128 * 1024, mode: 0o600 });
    return { success: true };
  } catch (error) {
    if (!options.signal || !options.signal.aborted) {
      console.error('[rclone] managed configuration failed:', error && error.code ? error.code : 'invalid configuration');
    }
    return fixedFailure('Could not create the managed rclone configuration', error && error.code);
  }
}

function checkConnection(opts) {
  opts = opts || {};
  return new Promise(function(resolve) {
    if (opts.signal && opts.signal.aborted) {
      resolve({ success: false, error: { type: 'CANCELLED', message: 'rclone connection check was cancelled' } });
      return;
    }
    var executablePath;
    var configPath;
    try {
      executablePath = requireManagedExecutable(opts.executablePath);
      configPath = requireManagedConfig(opts.configPath, false);
    } catch (error) {
      resolve({ success: false, error: { type: 'CONFIG_UNAVAILABLE', message: 'The managed rclone connection is unavailable' } });
      return;
    }
    var executor = typeof opts.execFile === 'function' ? opts.execFile : execFile;
    var args = [
      '--config', configPath,
      'lsjson', REMOTE_NAME + ':',
      '--stat', '--no-modtime', '--no-mimetype'
    ];
    try {
      executor(executablePath, args, {
        windowsHide: true,
        timeout: Number(opts.timeoutMs || CONNECTION_CHECK_TIMEOUT_MS),
        maxBuffer: 64 * 1024,
        signal: opts.signal
      }, function(error, _stdout, stderr) {
        if (!error) {
          resolve({ success: true });
          return;
        }
        if (opts.signal && opts.signal.aborted) {
          resolve({ success: false, error: { type: 'CANCELLED', message: 'rclone connection check was cancelled' } });
          return;
        }
        var classified = classifyError(error, stderr, error.killed === true);
        if (!classified || classified.type === 'UNKNOWN') {
          classified = { type: 'CONNECTION_FAILED', message: 'SFTP connection check failed' };
        }
        resolve({ success: false, error: classified });
      });
    } catch (_) {
      resolve({ success: false, error: { type: 'CONNECTION_FAILED', message: 'SFTP connection check failed' } });
    }
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
    var signal = opts.signal;
    if (signal && signal.aborted) {
      resolve({
        success: false,
        error: { type: 'CANCELLED', message: 'rclone operation was cancelled' },
        stats: { durationMs: 0 }
      });
      return;
    }
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
    // Core exclusions are policy, not a renderer preference. Optional callers
    // may only add patterns; an empty array can never disable the defaults.
    var excludes = DEFAULT_EXCLUDES.slice();
    if (Array.isArray(opts.excludes)) {
      for (var excludeIndex = 0; excludeIndex < opts.excludes.length; excludeIndex++) {
        var pattern = String(opts.excludes[excludeIndex] || '');
        if (pattern && excludes.indexOf(pattern) === -1) excludes.push(pattern);
      }
    }
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

    var child;
    try {
      child = (typeof opts.spawn === 'function' ? opts.spawn : spawn)(exe, args, { windowsHide: true });
    } catch (error) {
      resolve({
        success: false,
        error: classifyError(error, '', false),
        stats: { durationMs: 0 }
      });
      return;
    }
    var stderrTail = '';
    var timedOut = false;
    var cancelled = false;
    var terminationReason = '';
    var resolved = false;
    var startTime = Date.now();
    var forceKillTimer = null;
    var killConfirmationTimer = null;

    function cleanup() {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(killConfirmationTimer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortOperation);
      }
    }

    function resolveOnce(result) {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    }

    function forceKill() {
      if (resolved || child.exitCode !== null || child.signalCode) return;
      if (isWindows && child.pid) {
        var taskkillPath = windowsTaskkillPath();
        if (taskkillPath) {
          (typeof opts.execFile === 'function' ? opts.execFile : execFile)(
            taskkillPath, ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, function() {
              if (resolved || child.exitCode !== null || child.signalCode) return;
              try { child.kill('SIGKILL'); } catch (_) {}
            }
          );
        } else {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      } else {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
      killConfirmationTimer = setTimeout(function() {
        resolveOnce({
          success: false,
          error: {
            type: 'TERMINATION_UNCONFIRMED',
            message: 'rclone did not confirm process termination'
          },
          stats: { durationMs: Date.now() - startTime }
        });
      }, Number(opts.killConfirmationMs || 5000));
    }

    function terminate(reason) {
      if (resolved || child.exitCode !== null || child.signalCode) return;
      if (terminationReason) return;
      terminationReason = reason;
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      forceKillTimer = setTimeout(forceKill, Number(opts.killGraceMs || 1500));
    }

    function abortOperation() {
      terminate('cancelled');
    }

    var timer = setTimeout(function() {
      terminate('timeout');
    }, timeoutMs);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', abortOperation, { once: true });
      if (signal.aborted) abortOperation();
    }

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
      if (cancelled || timedOut) return;
      var classified = classifyError(error, stderrTail, false);
      resolveOnce({
        success: false,
        error: classified,
        stats: { durationMs: Date.now() - startTime }
      });
    });

    child.on('close', function(code) {
      var durationMs = Date.now() - startTime;

      if (cancelled) {
        resolveOnce({
          success: false,
          error: { type: 'CANCELLED', message: 'rclone operation was cancelled' },
          stats: { durationMs: durationMs }
        });
      } else if (code === 0 && !timedOut) {
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
    if (opts.signal && opts.signal.aborted) {
      return {
        success: false,
        error: { type: 'CANCELLED', message: 'rclone operation was cancelled' },
        stats: { durationMs: 0 }
      };
    }
    lastResult = await syncOnce(opts);
    if (lastResult.success) return lastResult;

    var retryable = lastResult.error &&
      (lastResult.error.type === 'CONNECTION_FAILED' || lastResult.error.type === 'TIMEOUT');
    if (!retryable || attempt === maxAttempts - 1) return lastResult;

    // 指数退避：2s, 4s, ...
    var backoffMs = 2000 * Math.pow(2, attempt);
    await new Promise(function(r) {
      var timer = setTimeout(done, backoffMs);
      function done() {
        clearTimeout(timer);
        if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
          opts.signal.removeEventListener('abort', done);
        }
        r();
      }
      if (opts.signal && typeof opts.signal.addEventListener === 'function') {
        opts.signal.addEventListener('abort', done, { once: true });
      }
    });
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
  windowsTaskkillPath: windowsTaskkillPath,
  requireManagedExecutable: requireManagedExecutable,
  requireManagedConfig: requireManagedConfig,
  ensureConfig: ensureConfig,
  checkConnection: checkConnection,
  syncOnce: syncOnce,
  sync: sync,
  pull: pull,
  checkVersion: checkVersion
};
