// src/rclone-client.js - renderer facade for the main-owned rclone broker.

(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;
  var S = BOBO.state || {};
  var operationSequence = 0;
  var activeOperationIds = new Set();

  function nextOperationId(kind) {
    operationSequence += 1;
    var randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Date.now().toString(36) + '-' + operationSequence.toString(36);
    return 'rclone-' + kind + '-' + randomPart;
  }

  function localScope(opts, kind) {
    opts = opts || {};
    var requestedLocalPath = kind === 'sync' ? opts.src : opts.dest;
    if (!opts.localGrant && requestedLocalPath && requestedLocalPath !== S.workspaceRoot) {
      throw new Error('The requested rclone path is not the active workspace');
    }
    return opts.localGrant
      ? { type: 'mapping', grantId: opts.localGrant }
      : {
          type: 'workspace',
          rootPath: S.workspaceRoot,
          workspaceIdentity: S.workspaceIdentity
        };
  }

  async function invokeTracked(kind, invoke) {
    var id = nextOperationId(kind);
    activeOperationIds.add(id);
    try {
      return await invoke(id);
    } finally {
      activeOperationIds.delete(id);
    }
  }

  async function prepareRemote(kind, request, opts) {
    opts = opts || {};
    return invokeTracked('prepare', function(id) {
      return window.api.rclonePrepareRemote({
        operationId: id,
        kind: kind,
        request: request || {},
        localScope: localScope(opts, kind === 'workspace' ? 'sync' : 'pull')
      });
    });
  }

  async function runOperation(kind, opts) {
    opts = opts || {};
    if (typeof opts.remoteGrantId !== 'string' || !opts.remoteGrantId) {
      throw new Error('A prepared remote synchronization grant is required');
    }
    return invokeTracked(kind, async function(operationId) {
      var disposeProgress = function() {};
      if (typeof opts.onProgress === 'function') {
        disposeProgress = window.api.onRcloneProgress(operationId, function(line, progress) {
          if ((!progress || !progress.operationId) &&
              (activeOperationIds.size !== 1 || !activeOperationIds.has(operationId))) return;
          opts.onProgress(line);
        }) || disposeProgress;
      }
      try {
        var payload = {
          operationId: operationId,
          remoteGrantId: opts.remoteGrantId,
          localScope: localScope(opts, kind)
        };
        return kind === 'sync'
          ? await window.api.rcloneSync(payload)
          : await window.api.rclonePull(payload);
      } finally {
        disposeProgress();
      }
    });
  }

  BOBO.rclone = {
    prepareWorkspace: function(request, opts) {
      return prepareRemote('workspace', request, opts);
    },

    prepareTeamPull: function(request, opts) {
      return prepareRemote('team-pull', request, opts);
    },

    sync: function(opts) {
      return runOperation('sync', opts);
    },

    pull: function(opts) {
      return runOperation('pull', opts);
    },

    cancel: function(operationId) {
      return window.api.rcloneCancel(operationId);
    },

    cancelAll: function(reason) {
      return window.api.rcloneCancelAll(reason || 'renderer-context-changed');
    },

    listBinaries: function() {
      return window.api.rcloneListBinaries();
    },

    getSelection: function() {
      return window.api.rcloneGetSelection();
    },

    selectBinary: function(scanId, candidateId) {
      return window.api.rcloneSelectBinary({ scanId: scanId, candidateId: candidateId });
    },

    checkVersion: function() {
      return window.api.rcloneCheckVersion();
    },

    validateConnection: function() {
      return window.api.rcloneValidateConnection();
    }
  };
})(window);
