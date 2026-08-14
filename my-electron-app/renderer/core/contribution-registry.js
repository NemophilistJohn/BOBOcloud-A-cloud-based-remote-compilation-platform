import { toDisposable } from './disposable.js';
import { validateFileDecorationProvider } from './file-decoration.js';

export const ContributionPoint = Object.freeze({
  MENUS: 'menus',
  FILE_DECORATIONS_SYNC: 'fileDecorations.sync',
  FILE_DECORATIONS_SCM: 'fileDecorations.scm',
  FILE_DECORATIONS_DIAGNOSTIC: 'fileDecorations.diagnostic',
  TASKS: 'tasks',
  DEBUG_CONFIGURATION_PROVIDERS: 'debug.configurationProviders',
  SETTINGS: 'settings',
  LANGUAGES: 'languages',
  AI_TOOLS: 'ai.tools',
  MCP_PROVIDERS: 'mcp.providers',
  SKILL_PROVIDERS: 'skills.providers'
});

function requireId(id, label) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new TypeError(label + ' must be a non-empty string.');
  }
  return id.trim();
}

export class ContributionRegistry {
  constructor(options = {}) {
    this._records = new Map();
    this._listeners = new Set();
    this._onError = typeof options.onError === 'function' ? options.onError : () => {};
    this._disposed = false;
  }

  register(point, contribution, options = {}) {
    if (this._disposed) throw new Error('ContributionRegistry has been disposed.');
    const contributionPoint = requireId(point, 'Contribution point');
    const owner = requireId(options.owner || 'core', 'Contribution owner');
    if (!contribution || typeof contribution !== 'object') {
      throw new TypeError('Contribution at "' + contributionPoint + '" must be an object.');
    }
    const id = requireId(options.id || contribution.id, 'Contribution id');
    if (contributionPoint.startsWith('fileDecorations.')) {
      validateFileDecorationProvider(contribution, contributionPoint);
    }
    const key = contributionPoint + '\u0000' + id;
    if (this._records.has(key)) {
      throw new Error('Contribution already registered: ' + contributionPoint + '/' + id);
    }

    const record = { key, point: contributionPoint, id, owner, contribution };
    this._records.set(key, record);
    this._emitChange('added', record);
    return toDisposable(() => this._removeRecord(record));
  }

  list(point) {
    return Array.from(this._records.values())
      .filter((record) => record.point === point)
      .map((record) => record.contribution);
  }

  listEntries(point) {
    return Array.from(this._records.values())
      .filter((record) => !point || record.point === point)
      .map((record) => Object.freeze({
        point: record.point,
        id: record.id,
        owner: record.owner,
        contribution: record.contribution
      }));
  }

  describe(point) {
    return Array.from(this._records.values())
      .filter((record) => !point || record.point === point)
      .map((record) => Object.freeze({ point: record.point, id: record.id, owner: record.owner }));
  }

  async collect(point, method, ...args) {
    const values = [];
    const errors = [];
    const records = Array.from(this._records.values()).filter((record) => record.point === point);
    for (const record of records) {
      const handler = record.contribution[method];
      if (typeof handler !== 'function') continue;
      try {
        values.push(await handler.apply(record.contribution, args));
      } catch (error) {
        errors.push({ id: record.id, owner: record.owner, error });
        this._onError({ source: 'contribution', point, id: record.id, owner: record.owner, error });
      }
    }
    return { values, errors };
  }

  onDidChange(listener) {
    if (this._disposed) throw new Error('ContributionRegistry has been disposed.');
    if (typeof listener !== 'function') throw new TypeError('Contribution change listener must be a function.');
    this._listeners.add(listener);
    return toDisposable(() => this._listeners.delete(listener));
  }

  disposeOwner(owner) {
    for (const [key, record] of this._records) {
      if (record.owner === owner) this._removeRecord(record);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const records = Array.from(this._records.values()).reverse();
    for (const record of records) this._removeRecord(record);
    this._listeners.clear();
  }

  _removeRecord(record) {
    if (this._records.get(record.key) !== record) return;
    this._records.delete(record.key);
    this._emitChange('removed', record);
  }

  _emitChange(type, record) {
    if (this._listeners.size === 0) return;
    const event = Object.freeze({
      type,
      point: record.point,
      id: record.id,
      owner: record.owner,
      contribution: record.contribution
    });
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(event);
      } catch (error) {
        this._onError({
          source: 'contribution-listener',
          point: record.point,
          id: record.id,
          owner: record.owner,
          error
        });
      }
    }
  }
}
