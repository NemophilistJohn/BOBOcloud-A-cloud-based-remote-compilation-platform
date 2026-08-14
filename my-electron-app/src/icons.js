// src/icons.js — SVG icon system for BOBOCLOUD Editor
// All icons use 16x16 viewBox, stroke-based, currentColor.
// Replace emoji throughout the app with these for visual consistency.
(function(global) {
  var BOBO = global.BOBO || {};

  // Helper: wrap path(s) in a consistent <svg> element.
  // size defaults to 14 (matches the old emoji visual weight).
  function icon(paths, size) {
    var s = size || 14;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 16 16" fill="none" style="flex-shrink:0">' + paths + '</svg>';
  }

  BOBO.icons = {
    // ── Actions ──
    plus: icon(
      '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    ),
    close: icon(
      '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
    ),
    check: icon(
      '<path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      12
    ),
    trash: icon(
      '<path d="M2.5 4h11M6 4V2.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V4M4 4l.5 9a1 1 0 0 0 1 .9h5a1 1 0 0 0 1-.9L12 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    ),
    send: icon(
      '<path d="M2 8l12-5-5 12-2.5-4.5L2 8z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    ),
    copy: icon(
      '<rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M2 11V3a1 1 0 0 1 1-1h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    ),
    play: icon(
      '<path d="M4 2.5v11a.7.7 0 0 0 1.07.6l8.8-5.5a.7.7 0 0 0 0-1.2L5.07 1.9A.7.7 0 0 0 4 2.5z" fill="currentColor"/>',
      11
    ),
    stop: icon(
      '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor"/>',
      10
    ),
    settings: icon(
      '<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    ),
    search: icon(
      '<circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    ),

    // ── Navigation / Status ──
    chevronDown: icon(
      '<path d="M3 6l5 5 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      10
    ),
    chevronRight: icon(
      '<path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
      10
    ),
    history: icon(
      '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
      12
    ),
    clock: icon(
      '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    ),
    cloud: icon(
      '<path d="M4.5 12a3 3 0 0 1-.3-5.98A4 4 0 0 1 12 5.5a3.2 3.2 0 0 1-.5 6.5h-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    ),

    // ── File types ──
    folder: icon(
      '<path d="M1.5 3.5a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .8.4l1 1.4h5.6a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V3.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    ),
    file: icon(
      '<path d="M3 2a1 1 0 0 1 1-1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1v3.5h4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    ),
    fileText: icon(
      '<path d="M3 2a1 1 0 0 1 1-1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1v3.5h4" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 7h6M5 9.5h6M5 12h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'
    ),

    // ── Auth ──
    user: icon(
      '<circle cx="8" cy="5.5" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 13.5c0-2.5 2.5-4 5.5-4s5.5 1.5 5.5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>'
    ),
    lock: icon(
      '<rect x="3" y="7" width="10" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5.5a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" stroke-width="1.4"/>'
    ),
    mail: icon(
      '<rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 5l5.5 4 5.5-4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    ),
    key: icon(
      '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h9A1.5 1.5 0 0 1 14 5.5v1a1.75 1.75 0 0 0 0 3.5v1a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-1a1.75 1.75 0 0 0 0-3.5v-1z" stroke="currentColor" stroke-width="1.4"/><path d="M9.5 4v1.5M9.5 7.25v2M9.5 11v1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-dasharray="0.1 2.2"/>'
    ),
    logout: icon(
      '<path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M10.5 5l3 3-3 3M13 8H6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'
    ),
    shield: icon(
      '<path d="M8 1.5L3 3.5v4c0 3.5 2.5 6.5 5 7.5 2.5-1 5-4 5-7.5v-4L8 1.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
    ),

    // ── Misc ──
    folderOpen: icon(
      '<path d="M1.5 3.5a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .8.4l1 1.4h5.6a1 1 0 0 1 1 1v1.2L8 9 1.5 6.7V3.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M1.5 6.7L8 9l6.5-2.3v4.8a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V6.7z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    )
  };
})(window);
