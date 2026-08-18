// src/language-packs-panel.js - Settings UI for hot-reloadable UI language packs.
(function(global) {
  'use strict';

  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  var elements = {};
  var bound = false;
  var subscribed = false;
  var renderSequence = 0;
  var busyCount = 0;
  var availablePackCount = 0;

  function byId(id) { return document.getElementById(id); }

  function i18n() { return BOBO.i18n || null; }

  function interpolate(source, params) {
    return String(source).replace(/\{([\w.-]+)\}/g, function(match, key) {
      return params && params[key] != null ? String(params[key]) : match;
    });
  }

  function tr(source, params) {
    var service = i18n();
    if (service && typeof service.t === 'function') {
      try { return service.t(source, params); } catch (_error) { /* Use the source text. */ }
    }
    return interpolate(source, params);
  }

  function asPromise(value) { return Promise.resolve(value); }

  function resolvePackValue(pack, keys, fallback) {
    var manifest = pack && pack.manifest && typeof pack.manifest === 'object' ? pack.manifest : {};
    for (var i = 0; i < keys.length; i++) {
      if (pack && pack[keys[i]] != null && pack[keys[i]] !== '') return pack[keys[i]];
      if (manifest[keys[i]] != null && manifest[keys[i]] !== '') return manifest[keys[i]];
    }
    return fallback;
  }

  function normalizePack(pack, index) {
    pack = pack && typeof pack === 'object' ? pack : {};
    var id = String(resolvePackValue(pack, ['id', 'locale', 'code', 'language'], 'pack-' + index));
    var source = String(resolvePackValue(pack, ['source', 'origin'], '')).toLowerCase();
    var builtIn = pack.builtIn === true || pack.builtin === true || pack.bundled === true ||
      source === 'builtin' || source === 'built-in' || source === 'bundled' || source === 'core';
    var nativeName = String(resolvePackValue(pack, ['nativeName', 'native_name', 'displayName', 'label', 'name'], id));
    var name = String(resolvePackValue(pack, ['name', 'englishName', 'english_name'], nativeName));
    var removable = resolvePackValue(pack, ['removable'], !builtIn) !== false && !builtIn;

    return {
      raw: pack,
      id: id,
      name: name,
      nativeName: nativeName,
      version: String(resolvePackValue(pack, ['version'], '1.0.0')),
      builtIn: builtIn,
      removable: removable
    };
  }

  function normalizePacks(value) {
    var packs = Array.isArray(value) ? value : value && Array.isArray(value.packs) ? value.packs : [];
    return packs.map(normalizePack).filter(function(pack, index, all) {
      return all.findIndex(function(candidate) { return candidate.id === pack.id; }) === index;
    });
  }

  function activeId(value) {
    if (value && typeof value === 'object') {
      return String(value.id || value.locale || value.code || value.language || '');
    }
    return value == null ? '' : String(value);
  }

  function cacheElements() {
    elements.current = byId('language-pack-current');
    elements.list = byId('language-pack-list');
    elements.install = byId('language-pack-install');
    elements.openFolder = byId('language-pack-open-folder');
    elements.refresh = byId('language-pack-refresh');
    elements.status = byId('language-pack-status');
    elements.activeMeta = byId('language-pack-active-meta');

    if (elements.current) {
      elements.current.classList.add('language-pack-select');
      if (!elements.current.getAttribute('aria-label')) elements.current.setAttribute('aria-label', tr('Display language'));
    }
    if (elements.list) {
      elements.list.classList.add('language-pack-list');
      elements.list.setAttribute('role', 'list');
      elements.list.setAttribute('aria-label', tr('Installed language packs'));
    }
    if (elements.status) {
      elements.status.classList.add('language-pack-status');
      elements.status.setAttribute('role', 'status');
      elements.status.setAttribute('aria-live', 'polite');
      elements.status.setAttribute('aria-atomic', 'true');
    }
    [elements.install, elements.openFolder, elements.refresh].forEach(function(button) {
      if (button) button.classList.add('language-pack-action');
    });
  }

  function setStatus(message, tone) {
    if (!elements.status) return;
    elements.status.textContent = message || '';
    elements.status.dataset.tone = tone || 'neutral';
  }

  function setBusy(busy) {
    busyCount = Math.max(0, busyCount + (busy ? 1 : -1));
    var active = busyCount > 0;
    [elements.install, elements.openFolder, elements.refresh].forEach(function(control) {
      if (control) control.disabled = active;
    });
    if (elements.current) elements.current.disabled = active || availablePackCount === 0;
    if (elements.list) {
      Array.prototype.forEach.call(elements.list.querySelectorAll('.language-pack-remove'), function(button) {
        button.disabled = active;
      });
    }
    if (elements.list) elements.list.setAttribute('aria-busy', active ? 'true' : 'false');
  }

  function appendText(parent, tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    parent.appendChild(node);
    return node;
  }

  function renderEmpty(message, error) {
    if (!elements.list) return;
    elements.list.replaceChildren();
    var empty = document.createElement('div');
    empty.className = 'language-pack-empty' + (error ? ' is-error' : '');
    empty.setAttribute('role', error ? 'alert' : 'note');
    appendText(empty, 'strong', 'language-pack-empty-title', error ? tr('Language packs unavailable') : tr('No language packs installed'));
    appendText(empty, 'span', 'language-pack-empty-detail', message);
    elements.list.appendChild(empty);
  }

  function sourceLabel(pack) { return pack.builtIn ? tr('Built in') : tr('User installed'); }

  function removeIcon() {
    if (BOBO.icons && BOBO.icons.trash) return BOBO.icons.trash;
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4m2 0-.6 9H4.6L4 4m2.3 2.5v4m3.4-4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function renderPack(pack, selected) {
    var row = document.createElement('div');
    row.className = 'language-pack-row' + (selected ? ' is-active' : '');
    row.setAttribute('role', 'listitem');
    row.dataset.packId = pack.id;

    var marker = document.createElement('span');
    marker.className = 'language-pack-marker';
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = selected ? 'A' : pack.nativeName.slice(0, 1).toUpperCase();
    row.appendChild(marker);

    var identity = document.createElement('div');
    identity.className = 'language-pack-identity';
    var title = appendText(identity, 'strong', 'language-pack-name', pack.nativeName);
    if (pack.name && pack.name !== pack.nativeName) appendText(title, 'span', 'language-pack-secondary-name', pack.name);
    var meta = document.createElement('div');
    meta.className = 'language-pack-meta';
    appendText(meta, 'span', 'language-pack-locale', pack.id);
    appendText(meta, 'span', 'language-pack-version', 'v' + pack.version);
    appendText(meta, 'span', 'language-pack-source', sourceLabel(pack));
    identity.appendChild(meta);
    row.appendChild(identity);

    var actions = document.createElement('div');
    actions.className = 'language-pack-row-actions';
    if (selected) {
      var active = appendText(actions, 'span', 'language-pack-active-label', tr('Current'));
      active.setAttribute('aria-label', tr('Current display language'));
    }
    if (pack.removable) {
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'language-pack-remove';
      remove.dataset.removePack = pack.id;
      remove.title = tr('Remove {name}', { name: pack.nativeName });
      remove.setAttribute('aria-label', remove.title);
      remove.disabled = busyCount > 0;
      remove.innerHTML = removeIcon();
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    return row;
  }

  function populateSelect(packs, selectedId) {
    availablePackCount = packs.length;
    if (!elements.current) return;
    var fragment = document.createDocumentFragment();
    packs.forEach(function(pack) {
      var option = document.createElement('option');
      option.value = pack.id;
      option.textContent = pack.nativeName + (pack.name !== pack.nativeName ? ' - ' + pack.name : '');
      fragment.appendChild(option);
    });
    elements.current.replaceChildren(fragment);
    elements.current.value = selectedId;
    elements.current.disabled = busyCount > 0 || packs.length === 0;
    if (elements.activeMeta) {
      var selected = packs.find(function(pack) { return pack.id === selectedId; });
      elements.activeMeta.textContent = selected
        ? selected.nativeName + ' / ' + selected.id + ' / v' + selected.version
        : '';
    }
  }

  async function render(options) {
    options = options || {};
    cacheElements();
    var service = i18n();
    if (!elements.list || !service) {
      renderEmpty(tr('The language service is not ready.'), true);
      setStatus(tr('Language service unavailable'), 'error');
      return [];
    }

    var sequence = ++renderSequence;
    if (!options.quiet) setStatus(tr('Loading language packs...'), 'neutral');
    try {
      var values = await Promise.all([
        asPromise(service.listPacks()),
        asPromise(service.getActive()),
        asPromise(typeof service.getErrors === 'function' ? service.getErrors() : [])
      ]);
      if (sequence !== renderSequence) return [];
      var packs = normalizePacks(values[0]);
      var selectedId = activeId(values[1]);
      populateSelect(packs, selectedId);
      elements.list.replaceChildren();
      if (!packs.length) {
        renderEmpty(tr('Install a language pack or open the pack folder to add one.'), false);
      } else {
        var fragment = document.createDocumentFragment();
        packs.forEach(function(pack) { fragment.appendChild(renderPack(pack, pack.id === selectedId)); });
        elements.list.appendChild(fragment);
      }
      if (!options.preserveStatus) {
        var packErrors = Array.isArray(values[2]) ? values[2] : [];
        if (packErrors.length) {
          setStatus(tr('{count} language packs could not be loaded', { count: packErrors.length }), 'warning');
        } else {
          setStatus(tr('{count} language packs available', { count: packs.length }), 'neutral');
        }
      }
      return packs;
    } catch (error) {
      if (sequence !== renderSequence) return [];
      var message = error && error.message ? error.message : tr('Unknown error');
      populateSelect([], '');
      renderEmpty(message, true);
      setStatus(tr('Could not load language packs: {message}', { message: message }), 'error');
      return [];
    }
  }

  async function changeLocale(event) {
    var service = i18n();
    if (!service || !elements.current) return;
    var nextId = elements.current.value;
    var previousId = activeId(await asPromise(service.getActive()));
    if (!nextId || nextId === previousId) return;
    setBusy(true);
    setStatus(tr('Switching display language...'), 'neutral');
    try {
      var result = await asPromise(service.setLocale(nextId));
      await render({ preserveStatus: true, quiet: true });
      if (result && result.editorReloadRecommended) {
        setStatus(tr('Display language changed. Editor menus update after reload.'), 'success');
      } else {
        setStatus(tr('Display language changed'), 'success');
      }
    } catch (error) {
      elements.current.value = previousId;
      setStatus(tr('Could not change language: {message}', { message: error && error.message || tr('Unknown error') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function installPack() {
    var service = i18n();
    if (!service) return;
    setBusy(true);
    setStatus(tr('Installing language pack...'), 'neutral');
    try {
      var result = await asPromise(service.install());
      if (result == null || result === false || result.canceled === true) {
        setStatus(tr('Installation cancelled'), 'neutral');
        return;
      }
      await render({ preserveStatus: true, quiet: true });
      setStatus(tr('Language pack installed'), 'success');
    } catch (error) {
      setStatus(tr('Could not install language pack: {message}', { message: error && error.message || tr('Unknown error') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removePack(packId) {
    var service = i18n();
    if (!service) return;
    var row = null;
    if (elements.list) {
      row = Array.prototype.find.call(elements.list.querySelectorAll('[data-pack-id]'), function(candidate) {
        return candidate.dataset.packId === packId;
      }) || null;
    }
    var nameNode = row && row.querySelector('.language-pack-name');
    var name = nameNode ? nameNode.childNodes[0].textContent : packId;
    if (!global.confirm(tr('Remove language pack "{name}"?', { name: name }))) return;
    setBusy(true);
    if (row) row.setAttribute('aria-busy', 'true');
    setStatus(tr('Removing language pack...'), 'neutral');
    try {
      await asPromise(service.remove(packId));
      await render({ preserveStatus: true, quiet: true });
      setStatus(tr('Language pack removed'), 'success');
    } catch (error) {
      if (row) row.removeAttribute('aria-busy');
      setStatus(tr('Could not remove language pack: {message}', { message: error && error.message || tr('Unknown error') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    var service = i18n();
    if (!service) return;
    setBusy(true);
    try {
      await asPromise(service.openFolder());
      setStatus(tr('Language pack folder opened'), 'success');
    } catch (error) {
      setStatus(tr('Could not open the language pack folder: {message}', { message: error && error.message || tr('Unknown error') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    var service = i18n();
    if (!service) return;
    setBusy(true);
    setStatus(tr('Reloading language packs...'), 'neutral');
    try {
      await asPromise(service.refresh());
      await render({ preserveStatus: true, quiet: true });
      var packErrors = typeof service.getErrors === 'function' ? await asPromise(service.getErrors()) : [];
      if (Array.isArray(packErrors) && packErrors.length) {
        setStatus(tr('{count} language packs could not be loaded', { count: packErrors.length }), 'warning');
      } else {
        setStatus(tr('Language packs reloaded'), 'success');
      }
    } catch (error) {
      setStatus(tr('Could not reload language packs: {message}', { message: error && error.message || tr('Unknown error') }), 'error');
    } finally {
      setBusy(false);
    }
  }

  function bindEvents() {
    if (bound) return;
    bound = true;
    if (elements.current) elements.current.addEventListener('change', changeLocale);
    if (elements.install) elements.install.addEventListener('click', installPack);
    if (elements.openFolder) elements.openFolder.addEventListener('click', openFolder);
    if (elements.refresh) elements.refresh.addEventListener('click', refresh);
    if (elements.list) {
      elements.list.addEventListener('click', function(event) {
        var button = event.target.closest('[data-remove-pack]');
        if (button && elements.list.contains(button)) removePack(button.dataset.removePack);
      });
    }
  }

  function subscribe() {
    var service = i18n();
    if (subscribed || !service || typeof service.onChange !== 'function') return;
    subscribed = true;
    service.onChange(function() { render({ quiet: true, preserveStatus: false }); });
  }

  async function init() {
    cacheElements();
    bindEvents();
    var service = i18n();
    if (!service) {
      await render();
      return false;
    }
    try {
      if (typeof service.init === 'function') await asPromise(service.init());
      subscribe();
      await render();
      return true;
    } catch (error) {
      renderEmpty(error && error.message || tr('Unknown error'), true);
      setStatus(tr('Could not initialize language packs: {message}', { message: error && error.message || tr('Unknown error') }), 'error');
      return false;
    }
  }

  BOBO.languagePacksPanel = {
    init: init,
    render: render,
    refresh: refresh
  };
})(window);
