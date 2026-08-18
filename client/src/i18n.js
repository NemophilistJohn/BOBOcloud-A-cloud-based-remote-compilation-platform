// src/i18n.js - Dependency-free, hot-reloadable UI language pack runtime.
(function(global) {
  var BOBO = global.BOBO || {};
  global.BOBO = BOBO;

  var DEFAULT_LOCALE = 'en';
  var SKIP_SELECTOR = [
    '[data-i18n-skip]',
    '#container',
    '#file-tree',
    '#run-log',
    '#terminal-output',
    '#terminal-host',
    '#history-detail-output',
    '#ai-chat-messages',
    '#workspace-label',
    '#sidebar-workspace-name',
    '#team-sidebar-project',
    '#team-sidebar-branch',
    '#collab-account-id',
    '#profile-name',
    '#profile-uid',
    '.monaco-editor',
    '.tab-title',
    '.team-diff-output',
    '.commit-hash',
    'pre',
    'code',
    'script',
    'style'
  ].join(',');
  var TRANSLATED_ATTRIBUTES = ['title', 'aria-label', 'placeholder'];

  var initialized = false;
  var initPromise = null;
  var activeId = DEFAULT_LOCALE;
  var activePack = null;
  var packs = [];
  var errors = [];
  var messages = Object.create(null);
  var fallbackMessages = Object.create(null);
  var originalText = new WeakMap();
  var originalAttributes = new WeakMap();
  var observer = null;
  var applyTimer = null;
  var pendingRoots = new Set();
  var boundElements = new Set();
  var elementBindings = new WeakMap();
  var subscribers = [];
  var loadedMonacoLocale = '';

  function interpolate(value, params) {
    if (!params) return value;
    return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, function(match, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
    });
  }

  function t(source, params) {
    var key = String(source == null ? '' : source);
    var value = Object.prototype.hasOwnProperty.call(messages, key) ? messages[key]
      : Object.prototype.hasOwnProperty.call(fallbackMessages, key) ? fallbackMessages[key]
      : key;
    return interpolate(value, params);
  }

  function shouldSkip(element) {
    return !element || Boolean(element.closest && element.closest(SKIP_SELECTOR));
  }

  function cloneParams(params) {
    return params && typeof params === 'object' ? Object.assign({}, params) : null;
  }

  function applyBinding(element, binding) {
    if (!element || !binding) return;
    var value = String(binding.prefix || '') + t(binding.source, binding.params) + String(binding.suffix || '');
    if (binding.attribute) {
      if (element.getAttribute(binding.attribute) !== value) element.setAttribute(binding.attribute, value);
    } else if (element.textContent !== value) {
      element.textContent = value;
    }
  }

  function bindText(element, source, params, options) {
    if (!element) return element;
    options = options || {};
    var bindings = elementBindings.get(element) || { text: null, attributes: Object.create(null) };
    bindings.text = {
      source: String(source == null ? '' : source),
      params: cloneParams(params),
      prefix: options.prefix || '',
      suffix: options.suffix || ''
    };
    elementBindings.set(element, bindings);
    boundElements.add(element);
    if (element.setAttribute) element.setAttribute('data-i18n-bound', '');
    applyBinding(element, bindings.text);
    return element;
  }

  function bindAttribute(element, attribute, source, params) {
    if (!element || TRANSLATED_ATTRIBUTES.indexOf(attribute) < 0) return element;
    var bindings = elementBindings.get(element) || { text: null, attributes: Object.create(null) };
    bindings.attributes[attribute] = {
      attribute: attribute,
      source: String(source == null ? '' : source),
      params: cloneParams(params)
    };
    elementBindings.set(element, bindings);
    boundElements.add(element);
    if (element.setAttribute) element.setAttribute('data-i18n-bound', '');
    applyBinding(element, bindings.attributes[attribute]);
    return element;
  }

  function unbind(element, attribute) {
    var bindings = element && elementBindings.get(element);
    if (!bindings) return element;
    if (attribute) delete bindings.attributes[attribute];
    else bindings.text = null;
    if (!bindings.text && Object.keys(bindings.attributes).length === 0) {
      boundElements.delete(element);
      elementBindings.delete(element);
      if (element.removeAttribute) element.removeAttribute('data-i18n-bound');
    }
    return element;
  }

  function applyElementBindings(element) {
    var bindings = elementBindings.get(element);
    if (!bindings) return;
    boundElements.add(element);
    if (bindings.text) applyBinding(element, bindings.text);
    Object.keys(bindings.attributes).forEach(function(attribute) {
      applyBinding(element, bindings.attributes[attribute]);
    });
  }

  function applyAllBindings() {
    boundElements.forEach(function(element) {
      if (!element || (typeof element.isConnected === 'boolean' && !element.isConnected)) {
        boundElements.delete(element);
        return;
      }
      applyElementBindings(element);
    });
  }

  function releaseBoundTree(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    boundElements.delete(root);
    if (!root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-i18n-bound]'), function(element) {
      boundElements.delete(element);
    });
  }

  function translatedText(original) {
    var leading = (original.match(/^\s*/) || [''])[0];
    var trailing = (original.match(/\s*$/) || [''])[0];
    var source = original.slice(leading.length, original.length - trailing.length);
    if (!source || (!Object.prototype.hasOwnProperty.call(messages, source) &&
        !Object.prototype.hasOwnProperty.call(fallbackMessages, source))) return original;
    return leading + t(source) + trailing;
  }

  function translateTextNode(node) {
    if (!node || !node.parentElement || shouldSkip(node.parentElement)) return;
    if (!originalText.has(node)) originalText.set(node, node.nodeValue || '');
    var original = originalText.get(node);
    var translated = translatedText(original);
    if (node.nodeValue !== translated) node.nodeValue = translated;
  }

  function translateElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE || shouldSkip(element)) return;

    var bindings = elementBindings.get(element);
    applyElementBindings(element);

    var explicit = element.getAttribute('data-i18n');
    if (explicit && !(bindings && bindings.text)) element.textContent = t(explicit);

    var originals = originalAttributes.get(element);
    if (!originals) {
      originals = Object.create(null);
      originalAttributes.set(element, originals);
    }
    TRANSLATED_ATTRIBUTES.forEach(function(attribute) {
      if (!element.hasAttribute(attribute)) return;
      if (bindings && bindings.attributes[attribute]) return;
      if (!Object.prototype.hasOwnProperty.call(originals, attribute)) originals[attribute] = element.getAttribute(attribute);
      var source = originals[attribute];
      var translated = Object.prototype.hasOwnProperty.call(messages, source) ||
        Object.prototype.hasOwnProperty.call(fallbackMessages, source) ? t(source) : source;
      if (element.getAttribute(attribute) !== translated) element.setAttribute(attribute, translated);
    });
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);
    if (root.nodeType === Node.ELEMENT_NODE && shouldSkip(root)) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        if (node.nodeType === Node.ELEMENT_NODE && shouldSkip(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        translateElement(node);
      } else {
        translateTextNode(node);
      }
    }
  }

  function observe() {
    if (!document.body || !global.MutationObserver) return;
    if (!observer) {
      observer = new MutationObserver(function(mutations) {
        var needsApply = false;
        mutations.forEach(function(mutation) {
          if (mutation.type === 'childList') {
            Array.prototype.forEach.call(mutation.removedNodes || [], releaseBoundTree);
            Array.prototype.forEach.call(mutation.addedNodes || [], function(node) {
              if (!node || (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.TEXT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) return;
              pendingRoots.add(node);
              needsApply = true;
            });
            return;
          }
          if (mutation.type === 'characterData') {
            if (mutation.target && mutation.target.parentElement && mutation.target.parentElement.hasAttribute &&
                mutation.target.parentElement.hasAttribute('data-i18n-bound')) return;
            if (originalText.has(mutation.target) &&
                mutation.target.nodeValue === translatedText(originalText.get(mutation.target))) return;
            originalText.set(mutation.target, mutation.target.nodeValue || '');
            pendingRoots.add(mutation.target);
            needsApply = true;
          }
          if (mutation.type === 'attributes') {
            var bindings = elementBindings.get(mutation.target);
            if (bindings && bindings.attributes[mutation.attributeName]) return;
            var knownOriginals = originalAttributes.get(mutation.target);
            var currentValue = mutation.target.getAttribute(mutation.attributeName);
            if (knownOriginals && Object.prototype.hasOwnProperty.call(knownOriginals, mutation.attributeName)) {
              var sourceValue = knownOriginals[mutation.attributeName];
              var translatedValue = Object.prototype.hasOwnProperty.call(messages, sourceValue) ||
                Object.prototype.hasOwnProperty.call(fallbackMessages, sourceValue) ? t(sourceValue) : sourceValue;
              if (currentValue === translatedValue) return;
            }
            var map = originalAttributes.get(mutation.target) || Object.create(null);
            map[mutation.attributeName] = currentValue;
            originalAttributes.set(mutation.target, map);
            pendingRoots.add(mutation.target);
            needsApply = true;
          }
        });
        if (needsApply) scheduleApply();
      });
    }
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATED_ATTRIBUTES
    });
  }

  function applyDocument() {
    if (!document.body) return;
    if (applyTimer) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    pendingRoots.clear();
    if (observer) observer.disconnect();
    document.documentElement.lang = activePack && activePack.manifest.locale || activeId;
    document.documentElement.dir = activePack && activePack.manifest.direction || 'ltr';
    walk(document.body);
    applyAllBindings();
    observe();
  }

  function applyPending() {
    applyTimer = null;
    if (!pendingRoots.size) return;

    var roots = Array.from(pendingRoots);
    pendingRoots.clear();
    roots = roots.filter(function(candidate, index) {
      return !roots.some(function(other, otherIndex) {
        if (index === otherIndex || !other || typeof other.contains !== 'function') return false;
        return other.contains(candidate);
      });
    });

    if (observer) observer.disconnect();
    roots.forEach(walk);
    observe();
  }

  function scheduleApply() {
    if (applyTimer) return;
    applyTimer = setTimeout(applyPending, 16);
  }

  function emit(reason) {
    var detail = { activeId: activeId, pack: activePack, packs: packs.slice(), reason: reason || 'change' };
    subscribers.slice().forEach(function(callback) {
      try { callback(detail); } catch (error) { console.error('language pack subscriber:', error); }
    });
    try { global.dispatchEvent(new CustomEvent('bobo:language-changed', { detail: detail })); } catch (error) {}
  }

  async function loadFallback() {
    if (!global.api || !global.api.languagePackLoad) {
      fallbackMessages = activeId === DEFAULT_LOCALE ? messages : Object.create(null);
      return;
    }

    var chain = [];
    var visited = Object.create(null);
    visited[activeId] = true;
    var fallbackId = activePack && activePack.manifest && activePack.manifest.fallback;
    while (fallbackId && !visited[fallbackId]) {
      visited[fallbackId] = true;
      try {
        var fallback = await global.api.languagePackLoad(fallbackId);
        if (!fallback) break;
        chain.push(fallback.messages || Object.create(null));
        fallbackId = fallback.manifest && fallback.manifest.fallback;
      } catch (error) {
        break;
      }
    }
    fallbackMessages = Object.create(null);
    for (var i = chain.length - 1; i >= 0; i--) Object.assign(fallbackMessages, chain[i]);
  }

  async function adopt(startup, reason) {
    if (!startup) throw new Error('Language pack service returned no data');
    packs = Array.isArray(startup.packs) ? startup.packs : packs;
    errors = Array.isArray(startup.errors) ? startup.errors : [];
    activeId = startup.activeId || activeId || DEFAULT_LOCALE;
    activePack = startup.pack || await global.api.languagePackLoad(activeId);
    messages = activePack && activePack.messages || Object.create(null);
    await loadFallback();
    applyDocument();
    emit(reason);
    return getSnapshot();
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async function() {
      if (!global.api || !global.api.languagePacksStartup) {
        activePack = { manifest: { id: DEFAULT_LOCALE, locale: 'en', direction: 'ltr', monacoLocale: '' }, messages: {} };
        initialized = true;
        applyDocument();
        return getSnapshot();
      }
      var startup = await global.api.languagePacksStartup();
      await adopt(startup, 'startup');
      loadedMonacoLocale = getMonacoLocale();
      if (global.api.onLanguagePacksChanged) {
        global.api.onLanguagePacksChanged(async function(payload) {
          try {
            var latest = await global.api.languagePacksStartup();
            await adopt(latest, payload && payload.reason || 'hot-reload');
            if (payload && payload.reason === 'filesystem' && BOBO.toast && BOBO.toast.info) {
              BOBO.toast.info(t('Language pack reloaded'));
            }
          } catch (error) {
            console.error('language pack hot reload:', error);
          }
        });
      }
      initialized = true;
      return getSnapshot();
    })().catch(function(error) {
      initPromise = null;
      console.error('i18n init:', error);
      activePack = { manifest: { id: DEFAULT_LOCALE, locale: 'en', direction: 'ltr', monacoLocale: '' }, messages: {} };
      initialized = true;
      applyDocument();
      return getSnapshot();
    });
    return initPromise;
  }

  async function listPacks() {
    await init();
    if (global.api && global.api.languagePacksList) {
      var result = await global.api.languagePacksList();
      packs = Array.isArray(result) ? result : result && Array.isArray(result.packs) ? result.packs : [];
      errors = result && Array.isArray(result.errors) ? result.errors : [];
    }
    return packs.slice();
  }

  async function setLocale(id) {
    await init();
    var result = await global.api.languagePackSetActive(id);
    await adopt(result, 'selection');
    return { snapshot: getSnapshot(), editorReloadRecommended: loadedMonacoLocale !== getMonacoLocale() };
  }

  async function install() {
    var result = await global.api.languagePackInstall();
    if (result && result.canceled) return result;
    await adopt(await global.api.languagePacksStartup(), 'install');
    return result;
  }

  async function remove(id) {
    var result = await global.api.languagePackRemove(id);
    await adopt(await global.api.languagePacksStartup(), 'remove');
    return result;
  }

  async function refresh() {
    if (global.api.languagePacksRefresh) await global.api.languagePacksRefresh();
    return adopt(await global.api.languagePacksStartup(), 'refresh');
  }

  async function openFolder() { return global.api.languagePacksOpenFolder(); }

  function getMonacoLocale() {
    return activePack && activePack.manifest && activePack.manifest.monacoLocale || '';
  }

  function getSnapshot() {
    return {
      initialized: initialized,
      activeId: activeId,
      pack: activePack,
      packs: packs.slice(),
      errors: errors.slice(),
      monacoLocale: getMonacoLocale()
    };
  }

  function onChange(callback) {
    if (typeof callback !== 'function') return function() {};
    subscribers.push(callback);
    return function() {
      var index = subscribers.indexOf(callback);
      if (index >= 0) subscribers.splice(index, 1);
    };
  }

  BOBO.i18n = {
    init: init,
    t: t,
    bindText: bindText,
    bindAttribute: bindAttribute,
    unbind: unbind,
    apply: applyDocument,
    listPacks: listPacks,
    getActive: function() { return activeId; },
    getErrors: function() { return errors.slice(); },
    getSnapshot: getSnapshot,
    getMonacoLocale: getMonacoLocale,
    setLocale: setLocale,
    install: install,
    remove: remove,
    openFolder: openFolder,
    refresh: refresh,
    onChange: onChange
  };
})(window);
