import {
  createSourceControlCommandPayload,
  normalizeSourceControlFormValues
} from '../renderer/core/source-control.js';
import { toDisposable } from '../renderer/core/disposable.js';
import type { Disposable } from '../types/lifecycle';
import type {
  SourceControlActionDto,
  SourceControlButtonActionDto,
  SourceControlChangeEvent,
  SourceControlCommandDetailsDto,
  SourceControlFormDto,
  SourceControlFormFieldDto,
  SourceControlFormValues,
  SourceControlMenuActionDto,
  SourceControlRawFormValues,
  SourceControlSectionDto,
  SourceControlSnapshot,
  SourceControlStateDto,
  SourceControlSummaryDto,
  SourceControlToolbarActionDto
} from '../types/source-control';
import type {
  SourceControlViewDependencies,
  SourceControlViewService
} from '../types/source-control-view';

type SourceControlFormActionDto = SourceControlActionDto & {
  readonly form: SourceControlFormDto;
};

interface FormDraft {
  readonly actionId: string;
  readonly values: SourceControlRawFormValues;
}

interface SourceControlPanel {
  readonly id: string;
  readonly view: string;
  readonly button: HTMLButtonElement;
  readonly section: HTMLElement;
  readonly heading: HTMLSpanElement;
  readonly hide: HTMLButtonElement;
  readonly tools: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly collapsed: Record<string, boolean>;
  readonly registration: Disposable;
  activeForm: string;
  renderedForm: string;
  formDraft: FormDraft | null;
  overflowOpen: boolean;
  overflowCleanup: (() => void) | null;
  overflowMenu: HTMLDivElement | null;
  busy: boolean;
  error: string;
  commandEpoch: number;
  disposed: boolean;
}

type FormValueControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const EMPTY_ACTIONS = Object.freeze([]) as readonly SourceControlActionDto[];

// Trusted, host-rendered source-control sidebar for installed extensions.
// Extensions publish data through the renderer core store; they never receive
// a DOM node, stylesheet, URL, or callback from this module.
export function createSourceControlViewService(
  dependencies: SourceControlViewDependencies
): SourceControlViewService {
  const {
    document: hostDocument,
    window: hostWindow,
    i18n,
    workbench,
    sourceControls,
    commands
  } = dependencies;
  const subscriptions: Disposable[] = [];
  const panels = new Map<string, SourceControlPanel>();
  let initialized = false;
  let readyListenerAttached = false;
  let lifecycleEpoch = 0;

  function t(key: string, values?: Readonly<Record<string, string | number>>): string {
    return i18n.t(key, values);
  }

  function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  function element<TagName extends keyof HTMLElementTagNameMap>(
    tagName: TagName,
    className: string,
    value?: string | number
  ): HTMLElementTagNameMap[TagName] {
    const node = hostDocument.createElement(tagName);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function svgElement(): SVGSVGElement {
    const svg = hostDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function svgPath(svg: SVGSVGElement, d: string, width = '1.8'): void {
    const path = hostDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', width);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }

  // A compact, conventional source-control branch mark. The host owns this
  // graphic; an extension can request only the semantic `git-branch` icon.
  function icon(): SVGSVGElement {
    const svg = svgElement();
    svgPath(svg, 'M7 4v16M7 7h4a4 4 0 0 0 4-4V2M7 16h4a4 4 0 0 1 4 4v1');
    ['4', '20', '2'].forEach((cy) => {
      const node = hostDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
      node.setAttribute('cx', cy === '2' ? '15' : '7');
      node.setAttribute('cy', cy);
      node.setAttribute('r', '2');
      node.setAttribute('fill', 'currentColor');
      svg.appendChild(node);
    });
    return svg;
  }

  function toolIcon(kind: SourceControlActionDto['icon']): SVGSVGElement {
    const svg = svgElement();
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

  function moreIcon(): SVGSVGElement {
    const svg = svgElement();
    svg.classList.add('source-control-tool-icon');
    svgPath(svg, 'M5 7h14M5 12h14M5 17h14');
    return svg;
  }

  function viewId(id: string): string {
    return 'source-control:' + id;
  }

  function stateLabel(state: SourceControlStateDto | null): string {
    if (!state) return t('Waiting for source-control data');
    if (state.phase === 'loading') return t('Loading');
    if (state.phase === 'empty') return t('No data available');
    if (state.phase === 'error') return t('Error');
    if (state.phase === 'idle') return t('Idle');
    return t('Ready');
  }

  function panelTitle(record: SourceControlSnapshot): string {
    return text(record.state && record.state.title) || text(record.descriptor.title) || t('Source Control');
  }

  function applyLabels(panel: SourceControlPanel, record: SourceControlSnapshot): void {
    const title = panelTitle(record);
    panel.button.title = title;
    panel.button.setAttribute('aria-label', title);
    panel.section.setAttribute('aria-label', title);
    panel.heading.textContent = title;
    panel.hide.title = t('Hide primary sidebar');
    panel.hide.setAttribute('aria-label', t('Hide primary sidebar'));
  }

  function emptyNode(panel: SourceControlPanel, message: string, kind: string): void {
    const node = element('div', 'source-control-empty source-control-empty-' + kind);
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.textContent = message;
    panel.body.appendChild(node);
  }

  function makeCommandPayload(
    record: SourceControlSnapshot,
    actionId: string,
    values: SourceControlFormValues = Object.freeze({}),
    details: SourceControlCommandDetailsDto = Object.freeze({})
  ) {
    return createSourceControlCommandPayload(record.id, actionId, values, details);
  }

  function exceptionMessage(error: unknown): string {
    let value = '';
    if (error !== null && typeof error === 'object' && 'message' in error) {
      const message = (error as { readonly message?: unknown }).message;
      if (typeof message === 'string') value = message;
    }
    if (!value && error) value = String(error);
    return value.slice(0, 512) || t('Unknown error');
  }

  function isCurrentInvocation(
    panel: SourceControlPanel,
    expectedLifecycleEpoch: number,
    expectedCommandEpoch: number
  ): boolean {
    return lifecycleEpoch === expectedLifecycleEpoch &&
      panel.commandEpoch === expectedCommandEpoch &&
      panel.disposed === false &&
      panels.get(panel.id) === panel;
  }

  async function invoke(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    command: string,
    actionId: string,
    values: SourceControlFormValues,
    details: SourceControlCommandDetailsDto
  ): Promise<void> {
    if (panel.busy || panel.disposed) return;
    panel.busy = true;
    panel.error = '';
    const expectedLifecycleEpoch = lifecycleEpoch;
    const expectedCommandEpoch = ++panel.commandEpoch;
    renderPanel(panel, record);
    let failed = false;
    let failure: unknown;
    try {
      const result = await commands.executeDynamicIsolated(
        command,
        makeCommandPayload(record, actionId, values, details)
      );
      if (result.ok !== true) throw result.error || new Error(t('Unknown error'));
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (!isCurrentInvocation(panel, expectedLifecycleEpoch, expectedCommandEpoch)) return;
      if (failed) {
        const message = exceptionMessage(failure);
        const current = sourceControls.get(record.id);
        const stateMessage = current && current.state && typeof current.state.message === 'string'
          ? current.state.message
          : '';
        // A provider can publish a localized recoverable error before rejecting
        // its command. Do not render the same message twice in the narrow panel.
        panel.error = stateMessage === message
          ? ''
          : t('Source-control action failed: {message}', { message });
      }
      panel.busy = false;
      const current = sourceControls.get(record.id);
      if (current) renderPanel(panel, current);
    }
  }

  function button(label: string, className: string, title?: string): HTMLButtonElement {
    const node = element('button', className, label);
    node.type = 'button';
    if (title) node.title = title;
    return node;
  }

  function useAction(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    action: SourceControlActionDto
  ): void {
    if (action.form) {
      panel.activeForm = panel.activeForm === action.id ? '' : action.id;
      panel.formDraft = null;
      closeOverflow(panel);
      renderPanel(panel, sourceControls.get(record.id) || record);
      return;
    }
    closeOverflow(panel);
    void invoke(panel, record, action.command, action.id, {}, { kind: 'action' });
  }

  function closeOverflow(panel: SourceControlPanel): void {
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

  function isToolbarAction(action: SourceControlActionDto): action is SourceControlToolbarActionDto {
    return action.placement === 'toolbar';
  }

  function isMenuAction(action: SourceControlActionDto): action is SourceControlMenuActionDto {
    return action.placement === 'menu';
  }

  function isButtonAction(action: SourceControlActionDto): action is SourceControlButtonActionDto {
    return action.placement === 'button';
  }

  function appendHeaderActions(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    actions: readonly SourceControlActionDto[]
  ): void {
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
    const toolbar = actions.filter(isToolbarAction);
    const overflow = actions.filter(isMenuAction);
    toolbar.forEach((action) => {
      const actionButton = button('', 'source-control-tool-button', action.description || action.title);
      actionButton.setAttribute('aria-label', action.title);
      actionButton.appendChild(toolIcon(action.icon));
      actionButton.disabled = panel.busy || action.disabled === true;
      actionButton.addEventListener('click', () => { useAction(panel, record, action); });
      panel.tools.appendChild(actionButton);
    });
    if (!overflow.length) return;
    const menuButton = button('', 'source-control-tool-button source-control-more-button', t('More source-control actions'));
    menuButton.setAttribute('aria-label', t('More source-control actions'));
    menuButton.setAttribute('aria-expanded', panel.overflowOpen ? 'true' : 'false');
    menuButton.appendChild(moreIcon());
    menuButton.disabled = panel.busy;
    panel.tools.appendChild(menuButton);
    if (panel.overflowOpen) {
      const menu = element('div', 'source-control-overflow-menu');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', t('More source-control actions'));
      overflow.forEach((action) => {
        const item = button('', 'source-control-overflow-item', action.description || action.title);
        item.setAttribute('role', 'menuitem');
        item.disabled = panel.busy || action.disabled === true;
        item.appendChild(toolIcon(action.icon));
        item.appendChild(element('span', 'source-control-overflow-label', action.title));
        item.addEventListener('click', () => { useAction(panel, record, action); });
        menu.appendChild(item);
      });
      hostDocument.body.appendChild(menu);
      panel.overflowMenu = menu;
      const placeMenu = (): void => {
        const trigger = menuButton.getBoundingClientRect();
        const bounds = menu.getBoundingClientRect();
        const margin = 8;
        // Keep the portal menu out of the activity rail. Before this lower
        // bound existed, a narrow source-control header could place the menu
        // at the very left edge and physically intercept every built-in
        // sidebar activity button beneath it.
        const activityBar = hostDocument.getElementById('activitybar');
        const activityRailRight = activityBar ? activityBar.getBoundingClientRect().right : 0;
        const minimumLeft = Math.max(margin, Math.ceil(activityRailRight + margin));
        const left = Math.max(minimumLeft, Math.min(trigger.right - bounds.width, hostWindow.innerWidth - bounds.width - margin));
        const top = Math.max(margin, Math.min(trigger.bottom + 4, hostWindow.innerHeight - bounds.height - margin));
        menu.style.left = Math.round(left) + 'px';
        menu.style.top = Math.round(top) + 'px';
      };
      placeMenu();
      const dismiss = (event: Event): void => {
        if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
        const target = event.target as Node | null;
        if (event.type === 'pointerdown' && target && (panel.tools.contains(target) || menu.contains(target))) return;
        closeOverflow(panel);
        renderPanel(panel, sourceControls.get(record.id) || record);
      };
      hostDocument.addEventListener('pointerdown', dismiss, true);
      hostDocument.addEventListener('keydown', dismiss, true);
      hostWindow.addEventListener('resize', placeMenu);
      panel.overflowCleanup = (): void => {
        hostDocument.removeEventListener('pointerdown', dismiss, true);
        hostDocument.removeEventListener('keydown', dismiss, true);
        hostWindow.removeEventListener('resize', placeMenu);
      };
    }
    menuButton.addEventListener('click', () => {
      panel.overflowOpen = !panel.overflowOpen;
      renderPanel(panel, sourceControls.get(record.id) || record);
    });
  }

  function appendSummary(body: HTMLElement, summary: SourceControlSummaryDto | null): void {
    if (!summary) return;
    const section = element('section', 'source-control-summary');
    if (summary.title) section.appendChild(element('h2', 'source-control-section-title', summary.title));
    const list = element('dl', 'source-control-summary-list');
    summary.items.forEach((item) => {
      const row = element('div', 'source-control-summary-row');
      row.appendChild(element('dt', '', item.label));
      const value = element('dd', '', item.value);
      if (item.detail) value.title = item.detail;
      row.appendChild(value);
      list.appendChild(row);
    });
    section.appendChild(list);
    body.appendChild(section);
  }

  function collapseKey(record: SourceControlSnapshot, section: SourceControlSectionDto): string {
    return record.id + ':' + section.id;
  }

  function isCollapsed(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    section: SourceControlSectionDto
  ): boolean {
    const key = collapseKey(record, section);
    return Object.prototype.hasOwnProperty.call(panel.collapsed, key)
      ? panel.collapsed[key] === true
      : section.collapsed === true;
  }

  function renderSection(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    section: SourceControlSectionDto
  ): HTMLElement {
    const container = element('section', 'source-control-section');
    const collapsed = isCollapsed(panel, record, section);
    const toggle = button('', 'source-control-section-toggle');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.setAttribute('title', collapsed ? t('Expand section') : t('Collapse section'));
    const heading = element('span', 'source-control-section-title', section.title);
    toggle.appendChild(heading);
    const chevron = element('span', 'source-control-section-chevron', collapsed ? '>' : 'v');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.appendChild(chevron);
    toggle.addEventListener('click', () => {
      panel.collapsed[collapseKey(record, section)] = !collapsed;
      renderPanel(panel, sourceControls.get(record.id) || record);
    });
    container.appendChild(toggle);
    if (collapsed) return container;

    if (section.description) container.appendChild(element('p', 'source-control-section-description', section.description));
    const list = element('div', 'source-control-list');
    if (section.items.length === 0) {
      list.appendChild(element('div', 'source-control-list-empty', section.emptyMessage || t('No data available')));
    } else {
      section.items.forEach((item) => {
        const command = item.command;
        let itemNode: HTMLElement;
        if (command) {
          const itemButton = button('', 'source-control-list-item source-control-list-item-action');
          itemButton.disabled = panel.busy || item.disabled === true;
          itemButton.addEventListener('click', () => {
            void invoke(panel, record, command, item.id, {}, {
              sectionId: section.id,
              itemId: item.id,
              kind: 'item'
            });
          });
          itemNode = itemButton;
        } else {
          itemNode = element('div', 'source-control-list-item');
        }
        const copy = element('span', 'source-control-list-copy');
        copy.appendChild(element('strong', '', item.title));
        if (item.description) copy.appendChild(element('small', '', item.description));
        itemNode.appendChild(copy);
        if (item.badge || item.meta) {
          const metadata = element('span', 'source-control-list-meta');
          if (item.badge) metadata.appendChild(element('em', 'source-control-badge', item.badge));
          if (item.meta) {
            const stats = /^\+(\d+)\s+-(\d+)$/.exec(item.meta);
            if (stats) {
              const lineStats = element('span', 'source-control-line-stats');
              lineStats.appendChild(element('span', 'source-control-line-stat source-control-line-stat-added', '+' + stats[1]!));
              lineStats.appendChild(element('span', 'source-control-line-stat source-control-line-stat-removed', '-' + stats[2]!));
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
      const loadMore = section.loadMore;
      const more = button(loadMore.label || t('Load more'), 'source-control-load-more');
      more.disabled = panel.busy || loadMore.disabled === true;
      more.addEventListener('click', () => {
        void invoke(panel, record, loadMore.command, 'loadMore', {}, {
          sectionId: section.id,
          kind: 'loadMore'
        });
      });
      container.appendChild(more);
    }
    return container;
  }

  function appendField(
    form: HTMLFormElement,
    field: SourceControlFormFieldDto,
    draft: SourceControlRawFormValues | null
  ): HTMLLabelElement {
    const wrapper = element('label', 'source-control-field');
    wrapper.htmlFor = form.id + '-' + field.id;
    wrapper.appendChild(element('span', 'source-control-field-label', field.label));
    let control: FormValueControl;
    if (field.type === 'textarea') {
      const textarea = element('textarea', 'source-control-textarea');
      textarea.rows = 4;
      textarea.maxLength = field.maxLength;
      control = textarea;
    } else if (field.type === 'select') {
      const select = element('select', 'source-control-select');
      field.options.forEach((option) => {
        const optionNode = element('option', '', option.label);
        optionNode.value = option.value;
        if (option.value === field.value) optionNode.selected = true;
        select.appendChild(optionNode);
      });
      control = select;
    } else {
      const input = element('input', field.type === 'checkbox' ? 'source-control-checkbox' : 'source-control-input');
      input.type = field.type === 'checkbox' ? 'checkbox' : 'text';
      input.maxLength = field.maxLength;
      control = input;
    }
    control.id = form.id + '-' + field.id;
    control.name = field.id;
    control.required = field.required === true;
    if (field.placeholder && 'placeholder' in control) control.placeholder = field.placeholder;
    if (field.type === 'checkbox') {
      (control as HTMLInputElement).checked = field.value === true;
    } else if (field.type !== 'select') {
      control.value = field.value || '';
    }
    if (draft && Object.prototype.hasOwnProperty.call(draft, field.id)) {
      if (field.type === 'checkbox') {
        (control as HTMLInputElement).checked = draft[field.id] === true;
      } else {
        control.value = String(draft[field.id] == null ? '' : draft[field.id]);
      }
    }
    wrapper.appendChild(control);
    if (field.description) wrapper.appendChild(element('small', 'source-control-field-description', field.description));
    return wrapper;
  }

  function asFormValueControl(value: Element | RadioNodeList | null): FormValueControl | null {
    if (!value || !('tagName' in value)) return null;
    const tagName = value.tagName;
    if (tagName !== 'INPUT' && tagName !== 'SELECT' && tagName !== 'TEXTAREA') return null;
    return value as FormValueControl;
  }

  function isFormAction(action: SourceControlActionDto): action is SourceControlFormActionDto {
    return action.form !== null;
  }

  function appendActionForm(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    action: SourceControlFormActionDto
  ): void {
    const formSchema = action.form;
    const form = element('form', 'source-control-form');
    const draft = panel.formDraft && panel.formDraft.actionId === action.id
      ? panel.formDraft.values
      : null;
    form.id = 'source-control-form-' + record.id.replace(/[^A-Za-z0-9_-]/g, '-') + '-' + action.id;
    form.noValidate = true;
    if (formSchema.title) form.appendChild(element('h2', 'source-control-form-title', formSchema.title));
    formSchema.fields.forEach((field) => { form.appendChild(appendField(form, field, draft)); });
    const controls = element('div', 'source-control-form-actions');
    const submit = button(formSchema.submitLabel || action.title, 'source-control-action source-control-action-primary');
    submit.type = 'submit';
    submit.disabled = panel.busy || action.disabled === true;
    const cancel = button(t('Cancel'), 'source-control-action source-control-action-secondary');
    cancel.addEventListener('click', () => {
      panel.activeForm = '';
      panel.formDraft = null;
      renderPanel(panel, sourceControls.get(record.id) || record);
    });
    controls.appendChild(submit);
    controls.appendChild(cancel);
    form.appendChild(controls);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const rawValues: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      formSchema.fields.forEach((field) => {
        const control = asFormValueControl(form.elements.namedItem(field.id));
        rawValues[field.id] = field.type === 'checkbox'
          ? Boolean(control && 'checked' in control && control.checked)
          : (control ? control.value : '');
      });
      let values: SourceControlFormValues;
      try {
        values = normalizeSourceControlFormValues(formSchema, rawValues);
      } catch (error) {
        panel.error = t('Source-control action failed: {message}', { message: exceptionMessage(error) });
        renderPanel(panel, sourceControls.get(record.id) || record);
        return;
      }
      void invoke(panel, record, action.command, action.id, values, { kind: 'action' });
    });
    panel.renderedForm = action.id;
    panel.body.appendChild(form);
  }

  function appendActions(
    panel: SourceControlPanel,
    record: SourceControlSnapshot,
    state: SourceControlStateDto
  ): void {
    const actions = state.actions.filter(isButtonAction);
    if (!actions.length) return;
    const dock = element('div', 'source-control-actions');
    actions.forEach((action) => {
      const className = 'source-control-action source-control-action-' + action.kind;
      const actionButton = button(action.title, className, action.description || '');
      actionButton.disabled = panel.busy || action.disabled === true;
      actionButton.addEventListener('click', () => { useAction(panel, record, action); });
      dock.appendChild(actionButton);
    });
    panel.body.appendChild(dock);
  }

  function captureFormDraft(panel: SourceControlPanel): void {
    if (!panel.renderedForm) return;
    const form = panel.body.querySelector<HTMLFormElement>('.source-control-form');
    if (!form) return;
    const values: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
    Array.from(form.elements).forEach((formElement) => {
      const control = asFormValueControl(formElement);
      if (!control || !control.name || control.type === 'submit' || control.type === 'button') return;
      values[control.name] = 'checked' in control && control.type === 'checkbox'
        ? control.checked === true
        : control.value;
    });
    panel.formDraft = { actionId: panel.renderedForm, values };
  }

  function renderPanel(panel: SourceControlPanel, record: SourceControlSnapshot): void {
    if (panel.disposed) return;
    captureFormDraft(panel);
    applyLabels(panel, record);
    appendHeaderActions(panel, record, record.state ? record.state.actions : EMPTY_ACTIONS);
    panel.body.replaceChildren();
    panel.renderedForm = '';
    const state = record.state;
    if (!state) {
      emptyNode(panel, t('Waiting for source-control data'), 'waiting');
      return;
    }
    const status = element('div', 'source-control-status source-control-status-' + state.phase, stateLabel(state));
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    panel.body.appendChild(status);
    if (state.message) panel.body.appendChild(element('p', 'source-control-message', state.message));
    if (panel.error) {
      const error = element('div', 'source-control-host-error', panel.error);
      error.setAttribute('role', 'alert');
      panel.body.appendChild(error);
    }
    if (state.phase === 'loading' && !state.summary && !state.sections.length && !state.actions.length) return;
    if (state.phase === 'error' && !state.summary && !state.sections.length && !state.actions.length) return;
    const active = state.actions.find((action): action is SourceControlFormActionDto => (
      action.id === panel.activeForm && isFormAction(action)
    ));
    if (active) appendActionForm(panel, record, active);
    else if (panel.activeForm) {
      panel.activeForm = '';
      panel.formDraft = null;
    }
    appendSummary(panel.body, state.summary);
    state.sections.forEach((section) => { panel.body.appendChild(renderSection(panel, record, section)); });
    appendActions(panel, record, state);
  }

  function createPanel(record: SourceControlSnapshot): SourceControlPanel | null {
    const primary = hostDocument.querySelector<HTMLElement>('#activitybar .activity-primary');
    const sidebar = hostDocument.getElementById('sidebar');
    if (!primary || !sidebar) return null;
    const view = viewId(record.id);
    const buttonNode = element('button', 'activity-item source-control-activity');
    buttonNode.type = 'button';
    buttonNode.setAttribute('data-workbench-view', view);
    buttonNode.setAttribute('data-i18n-skip', '');
    buttonNode.setAttribute('aria-pressed', 'false');
    buttonNode.appendChild(icon());

    const section = element('section', 'sidebar-view source-control-sidebar');
    section.setAttribute('data-sidebar-view', view);
    section.setAttribute('data-i18n-skip', '');
    const header = element('div', 'sidebar-header source-control-header');
    const heading = element('span', 'source-control-heading');
    const headerActions = element('div', 'sidebar-header-actions source-control-header-actions');
    const tools = element('div', 'source-control-tools');
    const hide = button('', 'sidebar-hide');
    const hideIcon = hostDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    hideIcon.setAttribute('viewBox', '0 0 16 16');
    hideIcon.setAttribute('fill', 'none');
    hideIcon.setAttribute('aria-hidden', 'true');
    const hidePath = hostDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
    hidePath.setAttribute('d', 'm10 3-5 5 5 5');
    hidePath.setAttribute('stroke', 'currentColor');
    hidePath.setAttribute('stroke-width', '1.5');
    hidePath.setAttribute('stroke-linecap', 'round');
    hidePath.setAttribute('stroke-linejoin', 'round');
    hideIcon.appendChild(hidePath);
    hide.appendChild(hideIcon);
    headerActions.appendChild(tools);
    headerActions.appendChild(hide);
    header.appendChild(heading);
    header.appendChild(headerActions);
    const body = element('div', 'source-control-body sidebar-scroll');
    section.appendChild(header);
    section.appendChild(body);
    primary.appendChild(buttonNode);
    sidebar.appendChild(section);

    const panel: SourceControlPanel = {
      id: record.id,
      view,
      button: buttonNode,
      section,
      heading,
      hide,
      tools,
      body,
      activeForm: '',
      renderedForm: '',
      formDraft: null,
      overflowOpen: false,
      overflowCleanup: null,
      overflowMenu: null,
      busy: false,
      error: '',
      collapsed: Object.create(null) as Record<string, boolean>,
      registration: workbench.registerPrimaryView(view),
      commandEpoch: 0,
      disposed: false
    };
    hide.addEventListener('click', () => { workbench.setPrimaryVisible(false); });
    buttonNode.addEventListener('click', () => {
      workbench.setPrimaryView(view);
      const current = sourceControls.get(record.id);
      if (current && current.descriptor.openCommand) {
        void invoke(panel, current, current.descriptor.openCommand, 'open', {}, { kind: 'open' });
      }
    });
    panels.set(record.id, panel);
    return panel;
  }

  function removePanel(id: string): void {
    const panel = panels.get(id);
    if (!panel) return;
    panels.delete(id);
    panel.disposed = true;
    panel.commandEpoch += 1;
    closeOverflow(panel);
    try {
      panel.registration.dispose();
    } catch (_) {
      // Workbench teardown must not leave host-owned source-control DOM behind.
    }
    panel.button.remove();
    panel.section.remove();
  }

  function placeInStableOrder(parent: Element, nodes: readonly HTMLElement[]): void {
    let next: ChildNode | null = null;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (!node || node.parentNode !== parent) continue;
      if (node.nextSibling !== next) parent.insertBefore(node, next);
      next = node;
    }
  }

  function reorderPanels(records: readonly SourceControlSnapshot[]): void {
    const primary = hostDocument.querySelector<HTMLElement>('#activitybar .activity-primary');
    const sidebar = hostDocument.getElementById('sidebar');
    if (!primary || !sidebar) return;
    const orderedPanels = records
      .map((record) => panels.get(record.id))
      .filter((panel): panel is SourceControlPanel => panel !== undefined);
    placeInStableOrder(primary, orderedPanels.map((panel) => panel.button));
    placeInStableOrder(sidebar, orderedPanels.map((panel) => panel.section));
  }

  function sync(renderExisting: boolean): void {
    const records = sourceControls.list();
    const known = new Set(records.map((record) => record.id));
    Array.from(panels.keys()).forEach((id) => { if (!known.has(id)) removePanel(id); });
    records.forEach((record) => {
      let panel = panels.get(record.id);
      const created = !panel;
      if (!panel) panel = createPanel(record) || undefined;
      if (panel && (renderExisting || created)) renderPanel(panel, record);
    });
    reorderPanels(records);
  }

  function syncTopology(): void {
    sync(false);
  }

  function refresh(): void {
    sync(true);
  }

  function onSourceControlChange(event: SourceControlChangeEvent): void {
    if (event.type === 'added') {
      // An added event denotes a new provider identity. Reentrant replacement
      // must not reuse a panel that still has an older command invocation.
      if (panels.has(event.id)) removePanel(event.id);
      syncTopology();
      return;
    }
    if (event.type === 'removed') {
      removePanel(event.id);
      syncTopology();
      return;
    }
    const panel = panels.get(event.id);
    const current = sourceControls.get(event.id);
    if (panel && current) {
      // Other host listeners may synchronously publish a newer state while an
      // older event is still being delivered. Always render the current DTO.
      renderPanel(panel, current);
      return;
    }
    // A state event may arrive after an earlier panel creation attempt ran
    // before the workbench DOM existed. Reconcile once using the latest store.
    syncTopology();
  }

  function isWorkbenchReady(): boolean {
    return hostDocument.documentElement?.getAttribute('data-bobo-ready') === 'true';
  }

  function removeReadyListener(): void {
    if (!readyListenerAttached) return;
    readyListenerAttached = false;
    hostWindow.removeEventListener('bobo:ready', onReady);
  }

  function onReady(): void {
    readyListenerAttached = false;
    if (initialized) refresh();
    else init();
  }

  function ensureReadyListener(): void {
    if (readyListenerAttached || isWorkbenchReady()) return;
    readyListenerAttached = true;
    hostWindow.addEventListener('bobo:ready', onReady, { once: true });
  }

  function init(): void {
    if (initialized) return;
    initialized = true;
    lifecycleEpoch += 1;
    try {
      subscriptions.push(sourceControls.onDidChange(onSourceControlChange));
      if (typeof i18n.onChange === 'function') {
        const disposeLanguage = i18n.onChange(refresh);
        if (typeof disposeLanguage === 'function') subscriptions.push(toDisposable(disposeLanguage));
      } else {
        hostWindow.addEventListener('bobo:language-changed', refresh);
        subscriptions.push(toDisposable(() => {
          hostWindow.removeEventListener('bobo:language-changed', refresh);
        }));
      }
      ensureReadyListener();
      refresh();
    } catch (error) {
      initialized = false;
      lifecycleEpoch += 1;
      removeReadyListener();
      subscriptions.splice(0).reverse().forEach((subscription) => {
        try { subscription.dispose(); } catch (_) {}
      });
      Array.from(panels.keys()).forEach(removePanel);
      throw error;
    }
  }

  function dispose(): void {
    removeReadyListener();
    initialized = false;
    lifecycleEpoch += 1;
    subscriptions.splice(0).reverse().forEach((subscription) => {
      try { subscription.dispose(); } catch (_) {}
    });
    Array.from(panels.keys()).forEach(removePanel);
  }

  const service: SourceControlViewService = { init, dispose, refresh };
  if (isWorkbenchReady()) init();
  else ensureReadyListener();
  return service;
}
