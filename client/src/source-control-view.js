// Trusted, host-rendered source-control sidebar for installed extensions.
// Extensions publish data through the renderer core store; they never receive
// a DOM node, stylesheet, URL, or callback from this module.
(function(global) {
  var BOBO = global.BOBO = global.BOBO || {};
  var subscriptions = [];
  var panels = new Map();
  var initialized = false;

  function t(key, values) {
    var i18n = BOBO.i18n;
    return i18n && typeof i18n.t === 'function' ? i18n.t(key, values) : key;
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  function element(tagName, className, value) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function svgElement(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function svgPath(svg, d, width) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', width || '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }

  // A compact, conventional source-control branch mark. The host owns this
  // graphic; an extension can request only the semantic `git-branch` icon.
  function icon() {
    var svg = svgElement();
    svgPath(svg, 'M7 4v16M7 7h4a4 4 0 0 0 4-4V2M7 16h4a4 4 0 0 1 4 4v1');
    ['4', '20', '2'].forEach(function(cy) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      node.setAttribute('cx', cy === '2' ? '15' : '7');
      node.setAttribute('cy', cy);
      node.setAttribute('r', '2');
      node.setAttribute('fill', 'currentColor');
      svg.appendChild(node);
    });
    return svg;
  }

  function toolIcon(kind) {
    var svg = svgElement();
    svg.classList.add('source-control-tool-icon');
    if (kind === 'refresh') svgPath(svg, 'M19 7V3m0 4h-4M19 7a8 8 0 1 0 2 5');
    else if (kind === 'commit') svgPath(svg, 'M5 12.5 9.5 17 19 7.5');
    else if (kind === 'pull') svgPath(svg, 'M12 4v12m0 0-4-4m4 4 4-4M5 20h14');
    else if (kind === 'push') svgPath(svg, 'M12 15V4m0 0-4 4m4-4 4 4M5 16v4h14v-4');
    else if (kind === 'branch') svgPath(svg, 'M7 4v16M7 7h4a4 4 0 0 0 4-4M7 16h4a4 4 0 0 1 4 4M7 4a2 2 0 1 0 0 .01M7 20a2 2 0 1 0 0 .01M15 3a2 2 0 1 0 0 .01M15 21a2 2 0 1 0 0 .01');
    else if (kind === 'publish') svgPath(svg, 'M12 20V7m0 0-5 5m5-5 5 5M5 4h14M5 20h14');
    else if (kind === 'remote') svgPath(svg, 'M7 17 4 14a3 3 0 0 1 0-4l3-3m10 10 3-3a3 3 0 0 0 0-4l-3-3M9 15l6-6');
    else if (kind === 'stage-all') svgPath(svg, 'M5 5h14v14H5zM8 12l2.5 2.5L16 9');
    else if (kind === 'visibility') svgPath(svg, 'M3 12s3-5 9-5 9 5 9 5-3 5-9 5-9-5Zm9 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5');
    else svgPath(svg, 'M5 12h14');
    return svg;
  }

  function moreIcon() {
    var svg = svgElement();
    svg.classList.add('source-control-tool-icon');
    svgPath(svg, 'M5 7h14M5 12h14M5 17h14');
    return svg;
  }

  function viewId(id) {
    return 'source-control:' + id;
  }

  function sourceControl() {
    return BOBO.platform && BOBO.platform.sourceControl;
  }

  function stateLabel(state) {
    if (!state) return t('Waiting for source-control data');
    if (state.phase === 'loading') return t('Loading');
    if (state.phase === 'empty') return t('No data available');
    if (state.phase === 'error') return t('Error');
    if (state.phase === 'idle') return t('Idle');
    return t('Ready');
  }

  function panelTitle(record) {
    return text(record.state && record.state.title) || text(record.descriptor && record.descriptor.title) || t('Source Control');
  }

  function applyLabels(panel, record) {
    var title = panelTitle(record);
    panel.button.title = title;
    panel.button.setAttribute('aria-label', title);
    panel.section.setAttribute('aria-label', title);
    panel.heading.textContent = title;
    panel.hide.title = t('Hide primary sidebar');
    panel.hide.setAttribute('aria-label', t('Hide primary sidebar'));
  }

  function emptyNode(panel, message, kind) {
    var node = element('div', 'source-control-empty source-control-empty-' + kind);
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.textContent = message;
    panel.body.appendChild(node);
  }

  function makeCommandPayload(record, actionId, values, details) {
    var api = sourceControl();
    return api.createCommandPayload(record.id, actionId, values || {}, details || {});
  }

  function exceptionMessage(error) {
    var value = error && typeof error.message === 'string' ? error.message : String(error || '');
    return value.slice(0, 512) || t('Unknown error');
  }

  async function invoke(panel, record, command, actionId, values, details) {
    if (panel.busy) return;
    panel.busy = true;
    panel.error = '';
    renderPanel(panel, record);
    try {
      var result = await BOBO.platform.commands.executeIsolated(
        command,
        makeCommandPayload(record, actionId, values, details)
      );
      if (!result || result.ok !== true) throw (result && result.error) || new Error(t('Unknown error'));
    } catch (error) {
      var message = exceptionMessage(error);
      var current = sourceControl() && sourceControl().get(record.id);
      var stateMessage = current && current.state && typeof current.state.message === 'string'
        ? current.state.message
        : '';
      // A provider can publish a localized recoverable error before rejecting
      // its command. Do not render the same message twice in the narrow panel.
      panel.error = stateMessage === message
        ? ''
        : t('Source-control action failed: {message}', { message: message });
    } finally {
      panel.busy = false;
      var current = sourceControl() && sourceControl().get(record.id);
      if (current) renderPanel(panel, current);
    }
  }

  function button(label, className, title) {
    var node = element('button', className, label);
    node.type = 'button';
    if (title) node.title = title;
    return node;
  }

  function useAction(panel, record, action) {
    if (action.form) {
      panel.activeForm = panel.activeForm === action.id ? '' : action.id;
      panel.formDraft = null;
      closeOverflow(panel);
      renderPanel(panel, sourceControl().get(record.id) || record);
      return;
    }
    closeOverflow(panel);
    invoke(panel, record, action.command, action.id, {}, { kind: 'action' });
  }

  function closeOverflow(panel) {
    panel.overflowOpen = false;
    if (panel.overflowCleanup) {
      panel.overflowCleanup();
      panel.overflowCleanup = null;
    }
    if (panel.overflowMenu) {
      panel.overflowMenu.remove();
      panel.overflowMenu = null;
    }
  }

  function appendHeaderActions(panel, record, state) {
    // Re-rendering replaces the menu DOM. Keep the open state but release the
    // old document listeners before building the fresh host-owned menu.
    if (panel.overflowCleanup) {
      panel.overflowCleanup();
      panel.overflowCleanup = null;
    }
    if (panel.overflowMenu) {
      panel.overflowMenu.remove();
      panel.overflowMenu = null;
    }
    panel.tools.replaceChildren();
    var toolbar = state.actions.filter(function(action) { return action.placement === 'toolbar'; });
    var overflow = state.actions.filter(function(action) { return action.placement === 'menu'; });
    toolbar.forEach(function(action) {
      var actionButton = button('', 'source-control-tool-button', action.description || action.title);
      actionButton.setAttribute('aria-label', action.title);
      actionButton.appendChild(toolIcon(action.icon));
      actionButton.disabled = panel.busy || action.disabled === true;
      actionButton.addEventListener('click', function() { useAction(panel, record, action); });
      panel.tools.appendChild(actionButton);
    });
    if (!overflow.length) return;
    var menuButton = button('', 'source-control-tool-button source-control-more-button', t('More source-control actions'));
    menuButton.setAttribute('aria-label', t('More source-control actions'));
    menuButton.setAttribute('aria-expanded', panel.overflowOpen ? 'true' : 'false');
    menuButton.appendChild(moreIcon());
    menuButton.disabled = panel.busy;
    panel.tools.appendChild(menuButton);
    if (panel.overflowOpen) {
      var menu = element('div', 'source-control-overflow-menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', t('More source-control actions'));
      overflow.forEach(function(action) {
        var item = button('', 'source-control-overflow-item', action.description || action.title);
        item.setAttribute('role', 'menuitem');
        item.disabled = panel.busy || action.disabled === true;
        item.appendChild(toolIcon(action.icon));
        item.appendChild(element('span', 'source-control-overflow-label', action.title));
        item.addEventListener('click', function() { useAction(panel, record, action); });
        menu.appendChild(item);
      });
      document.body.appendChild(menu);
      panel.overflowMenu = menu;
      var placeMenu = function() {
        var trigger = menuButton.getBoundingClientRect();
        var bounds = menu.getBoundingClientRect();
        var margin = 8;
        // Keep the portal menu out of the activity rail. Before this lower
        // bound existed, a narrow source-control header could place the menu
        // at the very left edge and physically intercept every built-in
        // sidebar activity button beneath it.
        var activityBar = document.getElementById('activitybar');
        var activityRailRight = activityBar ? activityBar.getBoundingClientRect().right : 0;
        var minimumLeft = Math.max(margin, Math.ceil(activityRailRight + margin));
        var left = Math.max(minimumLeft, Math.min(trigger.right - bounds.width, global.innerWidth - bounds.width - margin));
        var top = Math.max(margin, Math.min(trigger.bottom + 4, global.innerHeight - bounds.height - margin));
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(top) + 'px';
      };
      placeMenu();
      var dismiss = function(event) {
        if (event.type === 'keydown' && event.key !== 'Escape') return;
        if (event.type === 'pointerdown' && (panel.tools.contains(event.target) || menu.contains(event.target))) return;
        closeOverflow(panel);
        renderPanel(panel, sourceControl().get(record.id) || record);
      };
      document.addEventListener('pointerdown', dismiss, true);
      document.addEventListener('keydown', dismiss, true);
      global.addEventListener('resize', placeMenu);
      panel.overflowCleanup = function() {
        document.removeEventListener('pointerdown', dismiss, true);
        document.removeEventListener('keydown', dismiss, true);
        global.removeEventListener('resize', placeMenu);
      };
    }
    menuButton.addEventListener('click', function() {
      panel.overflowOpen = !panel.overflowOpen;
      renderPanel(panel, sourceControl().get(record.id) || record);
    });
  }

  function appendSummary(body, summary) {
    if (!summary) return;
    var section = element('section', 'source-control-summary');
    if (summary.title) section.appendChild(element('h2', 'source-control-section-title', summary.title));
    var list = element('dl', 'source-control-summary-list');
    summary.items.forEach(function(item) {
      var row = element('div', 'source-control-summary-row');
      row.appendChild(element('dt', '', item.label));
      var value = element('dd', '', item.value);
      if (item.detail) value.title = item.detail;
      row.appendChild(value);
      list.appendChild(row);
    });
    section.appendChild(list);
    body.appendChild(section);
  }

  function collapseKey(record, section) {
    return record.id + ':' + section.id;
  }

  function isCollapsed(panel, record, section) {
    var key = collapseKey(record, section);
    return Object.prototype.hasOwnProperty.call(panel.collapsed, key) ? panel.collapsed[key] : section.collapsed === true;
  }

  function renderSection(panel, record, state, section) {
    var container = element('section', 'source-control-section');
    var collapsed = isCollapsed(panel, record, section);
    var toggle = button('', 'source-control-section-toggle');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('title', collapsed ? t('Expand section') : t('Collapse section'));
    var heading = element('span', 'source-control-section-title', section.title);
    toggle.appendChild(heading);
    var chevron = element('span', 'source-control-section-chevron', collapsed ? '>' : 'v');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.appendChild(chevron);
    toggle.addEventListener('click', function() {
      panel.collapsed[collapseKey(record, section)] = !collapsed;
      renderPanel(panel, sourceControl().get(record.id) || record);
    });
    container.appendChild(toggle);
    if (collapsed) return container;

    if (section.description) container.appendChild(element('p', 'source-control-section-description', section.description));
    var list = element('div', 'source-control-list');
    if (section.items.length === 0) {
      list.appendChild(element('div', 'source-control-list-empty', section.emptyMessage || t('No data available')));
    } else {
      section.items.forEach(function(item) {
        var itemNode = item.command
          ? button('', 'source-control-list-item source-control-list-item-action')
          : element('div', 'source-control-list-item');
        if (item.command) {
          itemNode.disabled = panel.busy || item.disabled === true;
          itemNode.addEventListener('click', function() {
            invoke(panel, record, item.command, item.id, {}, {
              sectionId: section.id,
              itemId: item.id,
              kind: 'item'
            });
          });
        }
        var copy = element('span', 'source-control-list-copy');
        copy.appendChild(element('strong', '', item.title));
        if (item.description) copy.appendChild(element('small', '', item.description));
        itemNode.appendChild(copy);
        if (item.badge || item.meta) {
          var metadata = element('span', 'source-control-list-meta');
          if (item.badge) metadata.appendChild(element('em', 'source-control-badge', item.badge));
          if (item.meta) {
            var stats = /^\+(\d+)\s+-(\d+)$/.exec(item.meta);
            if (stats) {
              var lineStats = element('span', 'source-control-line-stats');
              lineStats.appendChild(element('span', 'source-control-line-stat source-control-line-stat-added', '+' + stats[1]));
              lineStats.appendChild(element('span', 'source-control-line-stat source-control-line-stat-removed', '-' + stats[2]));
              metadata.appendChild(lineStats);
            } else {
              metadata.appendChild(element('small', '', item.meta));
            }
          }
          itemNode.appendChild(metadata);
        }
        list.appendChild(itemNode);
      });
    }
    container.appendChild(list);
    if (section.loadMore) {
      var more = button(section.loadMore.label || t('Load more'), 'source-control-load-more');
      more.disabled = panel.busy || section.loadMore.disabled === true;
      more.addEventListener('click', function() {
        invoke(panel, record, section.loadMore.command, 'loadMore', {}, {
          sectionId: section.id,
          kind: 'loadMore'
        });
      });
      container.appendChild(more);
    }
    return container;
  }

  function appendField(form, field, draft) {
    var wrapper = element('label', 'source-control-field');
    wrapper.htmlFor = form.id + '-' + field.id;
    wrapper.appendChild(element('span', 'source-control-field-label', field.label));
    var control;
    if (field.type === 'textarea') {
      control = element('textarea', 'source-control-textarea');
      control.rows = 4;
    } else if (field.type === 'select') {
      control = element('select', 'source-control-select');
      field.options.forEach(function(option) {
        var optionNode = element('option', '', option.label);
        optionNode.value = option.value;
        if (option.value === field.value) optionNode.selected = true;
        control.appendChild(optionNode);
      });
    } else {
      control = element('input', field.type === 'checkbox' ? 'source-control-checkbox' : 'source-control-input');
      control.type = field.type === 'checkbox' ? 'checkbox' : 'text';
    }
    control.id = form.id + '-' + field.id;
    control.name = field.id;
    control.maxLength = field.maxLength;
    control.required = field.required === true;
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.type === 'checkbox') control.checked = field.value === true;
    else if (field.type !== 'select') control.value = field.value || '';
    if (draft && Object.prototype.hasOwnProperty.call(draft, field.id)) {
      if (field.type === 'checkbox') control.checked = draft[field.id] === true;
      else control.value = String(draft[field.id] == null ? '' : draft[field.id]);
    }
    wrapper.appendChild(control);
    if (field.description) wrapper.appendChild(element('small', 'source-control-field-description', field.description));
    return wrapper;
  }

  function appendActionForm(panel, record, action) {
    var formSchema = action.form;
    var form = element('form', 'source-control-form');
    var draft = panel.formDraft && panel.formDraft.actionId === action.id ? panel.formDraft.values : null;
    form.id = 'source-control-form-' + record.id.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + action.id;
    form.noValidate = true;
    if (formSchema.title) form.appendChild(element('h2', 'source-control-form-title', formSchema.title));
    formSchema.fields.forEach(function(field) { form.appendChild(appendField(form, field, draft)); });
    var controls = element('div', 'source-control-form-actions');
    var submit = button(formSchema.submitLabel || action.title, 'source-control-action source-control-action-primary');
    submit.type = 'submit';
    submit.disabled = panel.busy || action.disabled === true;
    var cancel = button(t('Cancel'), 'source-control-action source-control-action-secondary');
    cancel.addEventListener('click', function() {
      panel.activeForm = '';
      panel.formDraft = null;
      renderPanel(panel, sourceControl().get(record.id) || record);
    });
    controls.appendChild(submit);
    controls.appendChild(cancel);
    form.appendChild(controls);
    form.addEventListener('submit', function(event) {
      event.preventDefault();
      var values = {};
      formSchema.fields.forEach(function(field) {
        var control = form.elements.namedItem(field.id);
        values[field.id] = field.type === 'checkbox' ? Boolean(control && control.checked) : (control ? control.value : '');
      });
      try {
        values = sourceControl().normalizeFormValues(formSchema, values);
      } catch (error) {
        panel.error = t('Source-control action failed: {message}', { message: exceptionMessage(error) });
        renderPanel(panel, sourceControl().get(record.id) || record);
        return;
      }
      invoke(panel, record, action.command, action.id, values, { kind: 'action' });
    });
    panel.body.appendChild(form);
  }

  function appendActions(panel, record, state) {
    var actions = state.actions.filter(function(action) { return action.placement === 'button'; });
    if (!actions.length) return;
    var dock = element('div', 'source-control-actions');
    actions.forEach(function(action) {
      var className = 'source-control-action source-control-action-' + action.kind;
      var actionButton = button(action.title, className, action.description || '');
      actionButton.disabled = panel.busy || action.disabled === true;
      actionButton.addEventListener('click', function() {
        useAction(panel, record, action);
      });
      dock.appendChild(actionButton);
    });
    panel.body.appendChild(dock);
  }

  function captureFormDraft(panel) {
    if (!panel.activeForm || !panel.body) return;
    var form = panel.body.querySelector('.source-control-form');
    if (!form) return;
    var values = Object.create(null);
    Array.prototype.forEach.call(form.elements, function(control) {
      if (!control || !control.name || control.type === 'submit' || control.type === 'button') return;
      values[control.name] = control.type === 'checkbox' ? control.checked === true : control.value;
    });
    panel.formDraft = { actionId: panel.activeForm, values: values };
  }

  function renderPanel(panel, record) {
    if (!panel || !record) return;
    captureFormDraft(panel);
    applyLabels(panel, record);
    appendHeaderActions(panel, record, record.state || { actions: [] });
    panel.body.replaceChildren();
    var state = record.state;
    if (!state) {
      emptyNode(panel, t('Waiting for source-control data'), 'waiting');
      return;
    }
    var status = element('div', 'source-control-status source-control-status-' + state.phase, stateLabel(state));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.body.appendChild(status);
    if (state.message) panel.body.appendChild(element('p', 'source-control-message', state.message));
    if (panel.error) {
      var error = element('div', 'source-control-host-error', panel.error);
      error.setAttribute('role', 'alert');
      panel.body.appendChild(error);
    }
    if (state.phase === 'loading' && !state.summary && !state.sections.length && !state.actions.length) return;
    if (state.phase === 'error' && !state.summary && !state.sections.length && !state.actions.length) return;
    var active = state.actions.find(function(action) { return action.id === panel.activeForm && action.form; });
    if (active) appendActionForm(panel, record, active);
    else if (panel.activeForm) {
      panel.activeForm = '';
      panel.formDraft = null;
    }
    appendSummary(panel.body, state.summary);
    state.sections.forEach(function(section) { panel.body.appendChild(renderSection(panel, record, state, section)); });
    appendActions(panel, record, state);
  }

  function createPanel(record) {
    var primary = document.querySelector('#activitybar .activity-primary');
    var sidebar = document.getElementById('sidebar');
    if (!primary || !sidebar || !BOBO.workbench) return null;
    var view = viewId(record.id);
    var buttonNode = element('button', 'activity-item source-control-activity');
    buttonNode.type = 'button';
    buttonNode.setAttribute('data-workbench-view', view);
    buttonNode.setAttribute('data-i18n-skip', '');
    buttonNode.setAttribute('aria-pressed', 'false');
    buttonNode.appendChild(icon());

    var section = element('section', 'sidebar-view source-control-sidebar');
    section.setAttribute('data-sidebar-view', view);
    section.setAttribute('data-i18n-skip', '');
    var header = element('div', 'sidebar-header source-control-header');
    var heading = element('span', 'source-control-heading');
    var headerActions = element('div', 'sidebar-header-actions source-control-header-actions');
    var tools = element('div', 'source-control-tools');
    var hide = button('', 'sidebar-hide');
    hide.appendChild((function() {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('aria-hidden', 'true');
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'm10 3-5 5 5 5');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      return svg;
    })());
    headerActions.appendChild(tools);
    headerActions.appendChild(hide);
    header.appendChild(heading);
    header.appendChild(headerActions);
    var body = element('div', 'source-control-body sidebar-scroll');
    section.appendChild(header);
    section.appendChild(body);
    primary.appendChild(buttonNode);
    sidebar.appendChild(section);

    var panel = {
      id: record.id,
      view: view,
      button: buttonNode,
      section: section,
      heading: heading,
      hide: hide,
      tools: tools,
      body: body,
      activeForm: '',
      formDraft: null,
      overflowOpen: false,
      overflowCleanup: null,
      overflowMenu: null,
      busy: false,
      error: '',
      collapsed: Object.create(null),
      registration: BOBO.workbench.registerPrimaryView(view)
    };
    hide.addEventListener('click', function() { BOBO.workbench.setPrimaryVisible(false); });
    buttonNode.addEventListener('click', function() {
      BOBO.workbench.setPrimaryView(view);
      var current = sourceControl().get(record.id);
      if (current && current.descriptor.openCommand) {
        invoke(panel, current, current.descriptor.openCommand, 'open', {}, { kind: 'open' });
      }
    });
    panels.set(record.id, panel);
    renderPanel(panel, record);
    return panel;
  }

  function removePanel(id) {
    var panel = panels.get(id);
    if (!panel) return;
    panels.delete(id);
    closeOverflow(panel);
    try { if (panel.registration && panel.registration.dispose) panel.registration.dispose(); } catch (_) {}
    panel.button.remove();
    panel.section.remove();
  }

  function sync() {
    var api = sourceControl();
    if (!api || typeof api.list !== 'function') return;
    var records = api.list();
    var known = new Set(records.map(function(record) { return record.id; }));
    Array.from(panels.keys()).forEach(function(id) { if (!known.has(id)) removePanel(id); });
    records.forEach(function(record) {
      var panel = panels.get(record.id) || createPanel(record);
      if (panel) renderPanel(panel, record);
    });
    if (BOBO.workbench && BOBO.workbench.refreshControls) BOBO.workbench.refreshControls();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    var api = sourceControl();
    if (!api || typeof api.onDidChange !== 'function') return;
    subscriptions.push(api.onDidChange(function() { sync(); }));
    if (BOBO.i18n && typeof BOBO.i18n.onChange === 'function') {
      var disposeLanguage = BOBO.i18n.onChange(function() { sync(); });
      if (typeof disposeLanguage === 'function') subscriptions.push({ dispose: disposeLanguage });
    } else {
      global.addEventListener('bobo:language-changed', sync);
      subscriptions.push({ dispose: function() { global.removeEventListener('bobo:language-changed', sync); } });
    }
    sync();
  }

  function dispose() {
    subscriptions.splice(0).reverse().forEach(function(subscription) {
      try { if (subscription && subscription.dispose) subscription.dispose(); } catch (_) {}
    });
    Array.from(panels.keys()).forEach(removePanel);
    initialized = false;
  }

  BOBO.sourceControlView = { init: init, dispose: dispose, refresh: sync };
  if (document.documentElement && document.documentElement.getAttribute('data-bobo-ready') === 'true') init();
  else global.addEventListener('bobo:ready', init, { once: true });
})(window);
