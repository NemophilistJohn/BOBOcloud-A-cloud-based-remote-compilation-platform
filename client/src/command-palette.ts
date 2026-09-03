import type { Disposable } from '../types/lifecycle';
import type {
  CommandPaletteCommandDto,
  CommandPaletteCommandHandler,
  CommandPaletteDependencies,
  CommandPaletteService
} from '../types/command-palette';

export const COMMAND_PALETTE_SERVICE_ID = 'workbench.commandPalette';

interface CommandPaletteCommand {
  readonly descriptor: CommandPaletteCommandDto;
  readonly handler: CommandPaletteCommandHandler;
}

interface CommandPaletteDisplayItem {
  readonly command: CommandPaletteCommand;
  readonly label: string;
  readonly category: string;
}

interface CommandPaletteDom {
  readonly overlay: HTMLDivElement;
  readonly input: HTMLInputElement;
  readonly list: HTMLDivElement;
}

export function createCommandPalette(
  dependencies: CommandPaletteDependencies
): CommandPaletteService {
  const hostDocument = dependencies.document;
  const commands = new Map<string, CommandPaletteCommand>();
  const focusTimers = new Set<number>();
  let dom: CommandPaletteDom | null = null;
  let selectedIndex = 0;
  let filtered: CommandPaletteDisplayItem[] = [];
  let disposed = false;

  function t(source: string): string {
    const i18n = dependencies.getI18n();
    return i18n && typeof i18n.t === 'function' ? i18n.t(source) : source;
  }

  function onOverlayClick(event: MouseEvent): void {
    if (dom && event.target === dom.overlay) hide();
  }

  function onInput(): void {
    filter();
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      navigate(1);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      navigate(-1);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      executeSelected();
    }
  }

  function ensureDOM(): CommandPaletteDom | null {
    if (disposed) return null;
    if (dom) return dom;

    const overlay = hostDocument.createElement('div');
    overlay.className = 'cmd-palette-overlay';

    const palette = hostDocument.createElement('div');
    palette.className = 'cmd-palette';

    const inputWrap = hostDocument.createElement('div');
    inputWrap.className = 'cmd-input-wrap';
    const input = hostDocument.createElement('input');
    input.className = 'cmd-input';
    input.placeholder = t('Type a command...');
    inputWrap.appendChild(input);

    const list = hostDocument.createElement('div');
    list.className = 'cmd-list';

    palette.appendChild(inputWrap);
    palette.appendChild(list);
    overlay.appendChild(palette);
    overlay.addEventListener('click', onOverlayClick);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    hostDocument.body.appendChild(overlay);

    dom = { overlay, input, list };
    return dom;
  }

  function register(
    id: string,
    label: string,
    hint: string,
    category: string,
    handler: CommandPaletteCommandHandler
  ): Disposable {
    if (disposed) throw new Error('Command palette has been disposed.');
    if (typeof id !== 'string' || !id) throw new TypeError('Command id is required');
    const command: CommandPaletteCommand = {
      descriptor: {
        id,
        label: typeof label === 'string' && label ? label : id,
        hint: hint || '',
        category: category || 'General'
      },
      handler
    };
    commands.set(id, command);
    let active = true;
    return {
      dispose(): void {
        if (!active) return;
        active = false;
        if (commands.get(id) === command) commands.delete(id);
      }
    };
  }

  function unregister(id: string): boolean {
    return commands.delete(id);
  }

  function has(id: string): boolean {
    return commands.has(id);
  }

  function filter(): void {
    if (!dom) return;
    const query = dom.input.value.toLowerCase().trim();
    const next: CommandPaletteDisplayItem[] = [];
    for (const command of commands.values()) {
      const descriptor = command.descriptor;
      const localizedLabel = t(descriptor.label);
      const localizedCategory = t(descriptor.category);
      if (!query || localizedLabel.toLowerCase().indexOf(query) !== -1 ||
          localizedCategory.toLowerCase().indexOf(query) !== -1 ||
          descriptor.label.toLowerCase().indexOf(query) !== -1 ||
          descriptor.id.indexOf(query) !== -1) {
        next.push({ command, label: localizedLabel, category: localizedCategory });
      }
    }
    filtered = next;
    selectedIndex = 0;
    render();
  }

  function render(): void {
    if (!dom) return;
    if (filtered.length === 0) {
      const empty = hostDocument.createElement('div');
      empty.className = 'cmd-empty';
      empty.textContent = t('No matching commands');
      dom.list.replaceChildren(empty);
      return;
    }

    const fragment = hostDocument.createDocumentFragment();
    filtered.forEach((item, index) => {
      const element = hostDocument.createElement('div');
      element.className = 'cmd-item' + (index === selectedIndex ? ' selected' : '');
      const category = hostDocument.createElement('span');
      category.className = 'cmd-category';
      category.textContent = item.category;
      const label = hostDocument.createElement('span');
      label.className = 'cmd-label';
      label.textContent = item.label;
      element.appendChild(category);
      element.appendChild(label);
      if (item.command.descriptor.hint) {
        const hint = hostDocument.createElement('span');
        hint.className = 'cmd-hint';
        hint.textContent = t(item.command.descriptor.hint);
        element.appendChild(hint);
      }
      element.addEventListener('click', () => {
        selectedIndex = index;
        executeSelected();
      });
      fragment.appendChild(element);
    });
    dom.list.replaceChildren(fragment);
  }

  function navigate(direction: number): void {
    if (filtered.length === 0) return;
    selectedIndex += direction;
    if (selectedIndex < 0) selectedIndex = filtered.length - 1;
    if (selectedIndex >= filtered.length) selectedIndex = 0;
    render();
  }

  function executeSelected(): void {
    const item = filtered[selectedIndex];
    if (!item) return;
    hide();
    if (item.command.handler) item.command.handler();
  }

  function show(): void {
    const currentDom = ensureDOM();
    if (!currentDom) return;
    currentDom.input.placeholder = t('Type a command...');
    currentDom.input.value = '';
    filter();
    currentDom.overlay.classList.add('open');
    let timer = 0;
    timer = dependencies.setTimer(() => {
      focusTimers.delete(timer);
      if (!disposed && dom?.input === currentDom.input) currentDom.input.focus();
    }, 50);
    focusTimers.add(timer);
  }

  function hide(): void {
    dom?.overlay.classList.remove('open');
  }

  function onLanguageChanged(): void {
    if (!dom) return;
    dom.input.placeholder = t('Type a command...');
    if (dom.overlay.classList.contains('open')) filter();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    dependencies.eventTarget.removeEventListener('bobo:language-changed', onLanguageChanged);
    focusTimers.forEach((timer) => dependencies.clearTimer(timer));
    focusTimers.clear();
    if (dom) {
      dom.overlay.removeEventListener('click', onOverlayClick);
      dom.input.removeEventListener('input', onInput);
      dom.input.removeEventListener('keydown', onInputKeydown);
      dom.overlay.remove();
      dom = null;
    }
    commands.clear();
    filtered = [];
    selectedIndex = 0;
  }

  dependencies.eventTarget.addEventListener('bobo:language-changed', onLanguageChanged);

  return {
    get disposed() {
      return disposed;
    },
    register,
    unregister,
    has,
    supportsDisposables: true,
    show,
    hide,
    dispose
  };
}
