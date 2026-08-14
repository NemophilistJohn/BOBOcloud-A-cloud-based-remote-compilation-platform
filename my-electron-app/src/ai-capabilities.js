// Declarative capability registry for future Skills/MCP integrations.
// This registry intentionally stores metadata only and has no invocation API.
(function(global) {
  'use strict';

  var BOBO = global.BOBO = global.BOBO || {};
  var entries = Object.create(null);
  var allowedKinds = { native: true, skill: true, mcp: true };
  var allowedStates = { available: true, planned: true, disabled: true };

  function cleanText(value, limit) {
    return String(value || '').trim().slice(0, limit);
  }

  function normalize(definition) {
    definition = definition && typeof definition === 'object' ? definition : {};
    var id = cleanText(definition.id, 120);
    if (!id) throw new Error('Capability id is required');
    var kind = allowedKinds[definition.kind] ? definition.kind : 'native';
    var state = allowedStates[definition.state] ? definition.state : 'disabled';
    return Object.freeze({
      id: id,
      kind: kind,
      state: state,
      label: cleanText(definition.label || id, 160),
      description: cleanText(definition.description, 500),
      readOnly: definition.readOnly === true,
      requiresConfirmation: definition.requiresConfirmation !== false,
      source: cleanText(definition.source, 160)
    });
  }

  function register(definition) {
    var entry = normalize(definition);
    entries[entry.id] = entry;
    return entry;
  }

  function unregister(id) {
    delete entries[String(id || '')];
  }

  function get(id) {
    return entries[String(id || '')] || null;
  }

  function list(filter) {
    filter = filter && typeof filter === 'object' ? filter : {};
    return Object.keys(entries).sort().map(function(id) { return entries[id]; }).filter(function(entry) {
      return (!filter.kind || entry.kind === filter.kind) && (!filter.state || entry.state === filter.state);
    });
  }

  function snapshot() {
    return Object.freeze(list().slice());
  }

  function describeForPrompt() {
    var values = list();
    var lines = [
      'Capability registry is informational only. No capability can be invoked from this chat.',
      'Never claim that you executed an app command, Skill, MCP server, terminal command, file edit, build, or cloud action.'
    ];
    if (!values.length) {
      lines.push('No Skills or MCP integrations are registered.');
      return lines.join('\n');
    }
    values.forEach(function(entry) {
      lines.push('- [' + entry.kind + '/' + entry.state + '] ' + entry.id + ': ' + entry.description);
    });
    return lines.join('\n');
  }

  register({
    id: 'workspace.context', kind: 'native', state: 'available', label: 'Workspace context',
    description: 'The renderer may attach the active file, selection, project summary, or explicitly referenced files to a request.',
    readOnly: true, requiresConfirmation: false, source: 'renderer'
  });
  register({
    id: 'skills.registry', kind: 'skill', state: 'planned', label: 'Skills registry',
    description: 'Reserved metadata slot for future user-approved Skills. No Skill execution is implemented.',
    readOnly: true, requiresConfirmation: true, source: 'reserved'
  });
  register({
    id: 'mcp.registry', kind: 'mcp', state: 'planned', label: 'MCP registry',
    description: 'Reserved metadata slot for future user-approved MCP servers. No MCP connection or tool execution is implemented.',
    readOnly: true, requiresConfirmation: true, source: 'reserved'
  });

  BOBO.aiCapabilities = {
    register: register,
    unregister: unregister,
    get: get,
    list: list,
    snapshot: snapshot,
    describeForPrompt: describeForPrompt
  };
})(window);
