// src/rclone-client.js - Layer 3: 渲染进程 rclone 客户端
//
// 薄封装 BOBO.rclone.sync / checkVersion，通过 IPC 调用主进程 rclone 模块。
// 进度行通过 IPC 事件实时转发，在 sync 前注册、sync 后注销。

(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state;

  // 与 rclone.js DEFAULT_EXCLUDES 保持一致（渲染进程无法 require 主进程模块）
  var DEFAULT_EXCLUDES = [
    '**/target/**', '**/.git/**', '**/node_modules/**',
	'**/__pycache__/**', '**/.bobocloud/**', '**/.bobocloud-team.json'
  ];

  var operationSequence = 0;
  var activeOperationIds = new Set();

  function nextOperationId(kind) {
    operationSequence += 1;
    var randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + operationSequence.toString(36);
    return 'rclone-' + kind + '-' + randomPart;
  }

  async function runOperation(kind, opts) {
    opts = opts || {};
    var operationId = nextOperationId(kind);
    activeOperationIds.add(operationId);
    var disposeProgress = function() {};
    if (typeof opts.onProgress === 'function') {
      disposeProgress = window.api.onRcloneProgress(operationId, function(line, progress) {
        if ((!progress || !progress.operationId) &&
            (activeOperationIds.size !== 1 || !activeOperationIds.has(operationId))) return;
        opts.onProgress(line);
      }) || disposeProgress;
    }

    var payload = {
      operationId: operationId,
      rclonePath: S.serverSettings ? S.serverSettings.rclonePath : null,
      remotePath: opts.remotePath,
      excludes: opts.excludes || DEFAULT_EXCLUDES
    };
    if (kind === 'sync') payload.src = opts.src;
    else payload.dest = opts.dest;

    try {
      return kind === 'sync'
        ? await window.api.rcloneSync(payload)
        : await window.api.rclonePull(payload);
    } finally {
      activeOperationIds.delete(operationId);
      disposeProgress();
    }
  }

  BOBO.rclone = {
    DEFAULT_EXCLUDES: DEFAULT_EXCLUDES,

    // sync：同步本地目录到服务端
    // opts: { src, remotePath, excludes?, onProgress? }
    sync: async function(opts) {
      return runOperation('sync', opts);
    },

    // pull：首次或再次打开团队项目时，把云端分支工作树映射到本地。
    pull: async function(opts) {
      return runOperation('pull', opts);
    },

    // checkVersion：检查 rclone 是否可用
    checkVersion: async function(requestedPath) {
      var rclonePath = arguments.length > 0
        ? requestedPath
        : (S.serverSettings ? S.serverSettings.rclonePath : null);
      return await window.api.rcloneCheckVersion(rclonePath);
    }
  };
})(window);
