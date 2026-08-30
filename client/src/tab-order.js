// src/tab-order.js - In-memory ordering for file editor tabs.
(function(global) {
  var BOBO = global.BOBO = global.BOBO || {};

  function indexOfPath(tabs, filePath) {
    for (var index = 0; index < tabs.length; index += 1) {
      if (tabs[index] && tabs[index].path === filePath) return index;
    }
    return -1;
  }

  function reorder(tabs, sourcePath, targetPath, position) {
    if (!Array.isArray(tabs) || (position !== 'before' && position !== 'after')) return false;
    var sourceIndex = indexOfPath(tabs, sourcePath);
    var targetIndex = indexOfPath(tabs, targetPath);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false;

    var insertionIndex = targetIndex + (position === 'after' ? 1 : 0);
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    if (sourceIndex === insertionIndex) return false;

    var movedTab = tabs.splice(sourceIndex, 1)[0];
    tabs.splice(insertionIndex, 0, movedTab);
    return true;
  }

  BOBO.tabOrder = Object.freeze({ reorder: reorder });
})(window);
