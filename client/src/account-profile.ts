// Personal identity and compile activity center.
//
// The DOM contract remains the historical account-profile markup.  All
// browser/BOBO collaborators enter through the typed dependency object so the
// compatibility adapter is the only place that projects legacy globals.

import { DisposableStore, toDisposable } from '../renderer/core/disposable.js';
import type {
  AccountProfileActivityDayWireDto,
  AccountProfileAuthPort,
  AccountProfileCollaborationPort,
  AccountProfileConfirmPort,
  AccountProfileDependencies,
  AccountProfileFacade,
  AccountProfileI18nPort,
  AccountProfileImagePort,
  AccountProfileService,
  AccountProfileTabDto,
  AccountProfileToastPort,
  AccountProfileUserDto
} from '../types/account-profile';

export const ACCOUNT_PROFILE_SERVICE_ID = 'workbench.accountProfile' as const;

const AVATAR_PRESETS = ['ocean', 'forest', 'coral', 'violet', 'graphite', 'amber'] as const;
const AVATAR_PRESET_NAMES: Readonly<Record<(typeof AVATAR_PRESETS)[number], string>> = {
  ocean: 'Ocean',
  forest: 'Forest',
  coral: 'Coral',
  violet: 'Violet',
  graphite: 'Graphite',
  amber: 'Amber'
};

interface FocusableElement extends Element {
  focus?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function stringValue(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value) return value;
  if (isRecord(value) && typeof value.message === 'string' && value.message) return value.message;
  return fallback;
}

function dateValue(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'string') return new Date(value);
  return new Date(stringValue(value));
}

export function createAccountProfileService(
  dependencies: AccountProfileDependencies
): AccountProfileService {
  const { document, state } = dependencies;
  const lifecycle = new DisposableStore({
    onError: (event) => {
      dependencies.logger?.error('account profile disposal:', event.error);
    }
  });
  const pendingTimers = new Set<number>();
  const activeObjectUrls = new Set<string>();

  let chosenAvatar = 'graphite';
  let initialName = '';
  let initialAvatar = 'graphite';
  let previousFocus: FocusableElement | null = null;
  let activityDays: AccountProfileActivityDayWireDto[] = [];
  let activityOwner = '';
  let activityLoadingOwner = '';
  let activityRequestGeneration = 0;
  let profileSaveGeneration = 0;
  let profileDraftRevision = 0;
  let avatarLoadGeneration = 0;
  let profileSaving = false;
  let initialized = false;
  let disposed = false;
  let collaborationOwner: AccountProfileCollaborationPort | null = null;
  let previousCollaborationOpenProfile: ((tab?: AccountProfileTabDto) => void) | undefined;

  function $(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
  }

  function input(id: string): HTMLInputElement {
    return $(id) as HTMLInputElement;
  }

  function t(key: unknown, params?: Readonly<Record<string, unknown>> | null): string {
    const i18n = dependencies.getI18n();
    if (i18n && typeof i18n.t === 'function') return i18n.t(key, params);
    return String(key).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
      return params && Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : match;
    });
  }

  function notify(message: string, type?: string): void {
    const toast = dependencies.getToast();
    if (!toast) return;
    const translated = t(message);
    if (type === 'error') {
      toast.error?.(translated);
    } else if (type === 'success') {
      toast.success?.(translated);
    } else {
      toast.info?.(translated);
    }
  }

  function currentUser(): AccountProfileUserDto | null {
    return state.auth?.user || null;
  }

  function currentOwner(): string {
    const user = currentUser();
    const auth = state.auth;
    if (!user || !(auth && auth.token)) return '';
    return stringValue(user.id || user.uid || user.username) + '|' + stringValue(auth.token);
  }

  function isDirty(): boolean {
    const name = document.getElementById('profile-name') as HTMLInputElement | null;
    if (!name) return false;
    return name.value.trim() !== initialName || chosenAvatar !== initialAvatar;
  }

  function schedule(callback: () => void, delayMs: number): number {
    let timer: number | null = null;
    timer = dependencies.setTimeout(() => {
      if (timer !== null) pendingTimers.delete(timer);
      if (!disposed) callback();
    }, delayMs);
    pendingTimers.add(timer);
    return timer;
  }

  function listen(
    target: EventTarget,
    type: string,
    callback: EventListener,
    options?: AddEventListenerOptions | boolean
  ): void {
    target.addEventListener(type, callback, options);
    lifecycle.add(toDisposable(() => target.removeEventListener(type, callback, options)));
  }

  function markDraftChanged(): void {
    if (disposed) return;
    profileDraftRevision++;
    renderSummary();
    setStatus(isDirty() ? 'Unsaved changes' : '', false);
  }

  function setProfileSaving(value: unknown): void {
    profileSaving = Boolean(value);
    const saveButton = document.getElementById('profile-save') as HTMLButtonElement | null;
    const closeButton = document.getElementById('profile-close-x') as HTMLButtonElement | null;
    const cancelButton = document.getElementById('profile-cancel') as HTMLButtonElement | null;
    if (saveButton) saveButton.disabled = profileSaving;
    if (closeButton) closeButton.disabled = profileSaving;
    if (cancelButton) cancelButton.disabled = profileSaving;
    const modal = document.getElementById('profile-modal');
    if (modal) {
      if (profileSaving) modal.setAttribute('aria-busy', 'true');
      else modal.removeAttribute('aria-busy');
    }
  }

  function initials(value: unknown): string {
    const parts = stringValue(value, '?').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?').charAt(0) +
      (parts.length > 1 ? (parts[parts.length - 1] || '').charAt(0) : '')).toUpperCase();
  }

  function renderAvatar(element: HTMLElement | null, avatar: unknown, name: unknown): void {
    if (!element) return;
    element.className = element.id === 'profile-avatar-preview'
      ? 'profile-avatar-preview'
      : 'account-summary-avatar';
    element.textContent = '';
    const avatarValue = stringValue(avatar);
    if (avatarValue.indexOf('data:image/') === 0) {
      const image = document.createElement('img');
      image.src = avatarValue;
      image.alt = '';
      element.appendChild(image);
      return;
    }
    const preset = /^(ocean|forest|coral|violet|graphite|amber)$/.test(avatarValue)
      ? avatarValue
      : 'graphite';
    element.classList.add('avatar-' + preset);
    element.textContent = initials(name);
  }

  function setStatus(message: string, error: boolean): void {
    const element = $('profile-save-status');
    element.textContent = message ? t(message) : '';
    element.classList.toggle('error', Boolean(error));
  }

  function setActivityStatus(message: string, error: boolean): void {
    const element = $('account-activity-status');
    element.textContent = message ? t(message) : '';
    element.classList.toggle('error', Boolean(error));
  }

  function utcDate(date: Date): string {
    return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(date.getUTCDate()).padStart(2, '0');
  }

  function utcMidnight(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  function addUTCDays(date: Date, count: number): Date {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + count);
    return result;
  }

  function activeLocale(): string {
    const locale = dependencies.getI18n()?.getActive?.() || 'en';
    return locale === 'zh-CN' ? 'zh-CN' : locale === 'ja' ? 'ja-JP' : 'en-US';
  }

  function activityLevel(count: number): number {
    if (!count) return 0;
    if (count <= 1) return 1;
    if (count <= 3) return 2;
    if (count <= 7) return 3;
    return 4;
  }

  function renderSummary(): void {
    const user = currentUser() || {};
    const profileName = input('profile-name');
    const draftName = stringValue(profileName.value || user.name || user.username);
    renderAvatar(document.getElementById('profile-avatar-preview'), chosenAvatar, draftName);
    renderAvatar(document.getElementById('account-summary-avatar'), chosenAvatar, draftName);
    $('account-summary-name').textContent = draftName || stringValue(user.username);
    $('account-summary-username').textContent = user.username ? '@' + stringValue(user.username) : '';
    $('account-summary-uid').textContent = stringValue(user.uid);
    const roleKey = user.role === 'root'
      ? 'Root administrator'
      : user.role === 'admin' ? 'Administrator' : 'Member';
    $('account-summary-role').textContent = t(roleKey);
    document.querySelectorAll<HTMLElement>('.profile-avatar-swatch').forEach((element) => {
      const active = element.dataset.avatar === chosenAvatar;
      element.classList.toggle('selected', active);
      element.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function renderProfile(): void {
    const user = currentUser() || {};
    const profileName = input('profile-name');
    profileName.value = stringValue(user.name || user.username);
    $('profile-uid').textContent = stringValue(user.uid);
    $('account-info-username').textContent = stringValue(user.username) || t('Not available');
    $('account-info-email').textContent = stringValue(user.email) || t('Not available');
    $('account-info-created').textContent = user.created_at
      ? dateValue(user.created_at).toLocaleDateString(activeLocale())
      : t('Not available');
    chosenAvatar = stringValue(user.avatar || 'graphite');
    initialName = profileName.value.trim();
    initialAvatar = chosenAvatar;
    const options = $('profile-avatar-options');
    options.textContent = '';
    AVATAR_PRESETS.forEach((preset) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'profile-avatar-swatch avatar-' + preset;
      button.dataset.avatar = preset;
      const name = t(AVATAR_PRESET_NAMES[preset]);
      button.title = t('Use {name} avatar', { name });
      button.setAttribute('aria-label', t('Use {name} avatar', { name }));
      options.appendChild(button);
    });
    renderSummary();
  }

  function renderActivity(): void {
    if (disposed) return;
    const counts: Record<string, number> = Object.create(null) as Record<string, number>;
    activityDays.forEach((day) => {
      counts[String(day.date)] = Number(day.count || 0);
    });
    const today = utcMidnight(new Date());
    const startOfWeek = addUTCDays(today, -today.getUTCDay());
    const start = addUTCDays(startOfWeek, -52 * 7);
    const heatmap = $('account-heatmap');
    const months = $('account-heatmap-months');
    heatmap.textContent = '';
    months.textContent = '';
    let lastMonth = -1;
    for (let column = 0; column < 53; column++) {
      const weekStart = addUTCDays(start, column * 7);
      if (weekStart.getUTCMonth() !== lastMonth) {
        lastMonth = weekStart.getUTCMonth();
        const label = document.createElement('span');
        label.style.gridColumn = String(column + 2);
        label.textContent = new Intl.DateTimeFormat(activeLocale(), {
          month: 'short', timeZone: 'UTC'
        }).format(weekStart);
        months.appendChild(label);
      }
      for (let row = 0; row < 7; row++) {
        const date = addUTCDays(weekStart, row);
        const key = utcDate(date);
        const count = counts[key] || 0;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'account-heatmap-cell';
        cell.dataset.level = String(activityLevel(count));
        cell.dataset.date = key;
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', t('{date}: {count} compile requests', { date: key, count }));
        cell.title = t('{date}: {count} compile requests', { date: key, count });
        if (date > today) {
          cell.classList.add('future');
          cell.tabIndex = -1;
          cell.setAttribute('aria-hidden', 'true');
        }
        heatmap.appendChild(cell);
      }
    }
    const todayKey = utcDate(today);
    const visibleStartKey = utcDate(start);
    const monthStart = utcDate(addUTCDays(today, -29));
    const todayCount = counts[todayKey] || 0;
    let monthCount = 0;
    let activeCount = 0;
    Object.keys(counts).forEach((date) => {
      if (date >= monthStart && date <= todayKey) monthCount += counts[date] || 0;
      if (date >= visibleStartKey && date <= todayKey && (counts[date] || 0) > 0) activeCount++;
    });
    $('account-activity-today').textContent = String(todayCount);
    $('account-activity-month').textContent = String(monthCount);
    $('account-activity-days').textContent = String(activeCount);
  }

  async function loadActivity(): Promise<void> {
    if (disposed) return;
    const owner = currentOwner();
    if (!owner || owner !== activityOwner || activityLoadingOwner === owner) return;
    const generation = ++activityRequestGeneration;
    activityLoadingOwner = owner;
    setActivityStatus('Loading activity...', false);
    try {
      const result = await dependencies.sendToServer(
        'getCompileActivity', {}, { quiet: true }
      );
      if (generation !== activityRequestGeneration || owner !== activityOwner || owner !== currentOwner()) return;
      if (!result || !result.success) {
        throw new Error(errorMessage(result?.error, t('Activity is unavailable')));
      }
      const days = result.data && Array.isArray(result.data.days)
        ? result.data.days
        : [];
      activityDays = days as AccountProfileActivityDayWireDto[];
      renderActivity();
      setActivityStatus('', false);
    } catch (error) {
      if (generation !== activityRequestGeneration || owner !== activityOwner || owner !== currentOwner()) return;
      activityDays = [];
      renderActivity();
      setActivityStatus('Activity is unavailable', true);
    } finally {
      if (generation === activityRequestGeneration) activityLoadingOwner = '';
    }
  }

  function switchTab(tab: AccountProfileTabDto): void {
    if (disposed) return;
    const activeTab = tab === 'activity' ? 'activity' : 'profile';
    document.querySelectorAll<HTMLElement>('[data-account-tab]').forEach((button) => {
      const active = button.dataset.accountTab === activeTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll<HTMLElement>('[data-account-pane]').forEach((pane) => {
      pane.classList.toggle('active', pane.dataset.accountPane === activeTab);
    });
    ($('profile-save') as HTMLElement).style.visibility = activeTab === 'profile' ? '' : 'hidden';
    setStatus('', false);
    if (activeTab === 'activity') void loadActivity();
  }

  function open(tab?: AccountProfileTabDto): void {
    if (disposed) return;
    const user = currentUser();
    const auth = state.auth;
    if (!user || !(auth && auth.token)) {
      dependencies.getAuth()?.openAuthModal?.(t('Sign in to view your personal profile'));
      return;
    }
    const owner = currentOwner();
    const modal = $('profile-modal');
    if (modal.classList.contains('open') && owner === activityOwner) {
      switchTab(tab || 'profile');
      return;
    }
    if (owner !== activityOwner) {
      activityOwner = owner;
      activityDays = [];
      activityLoadingOwner = '';
      activityRequestGeneration++;
      profileSaveGeneration++;
      profileDraftRevision = 0;
      avatarLoadGeneration++;
      setProfileSaving(false);
    }
    previousFocus = document.activeElement as FocusableElement | null;
    renderProfile();
    renderActivity();
    const requestedTab = tab === 'activity' ? 'activity' : 'profile';
    switchTab(requestedTab);
    modal.classList.add('open');
    schedule(() => {
      const button = document.querySelector<HTMLElement>(
        '[data-account-tab="' + requestedTab + '"]'
      );
      button?.focus();
    }, 30);
    void loadActivity();
  }

  function closeImmediate(): void {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.classList.remove('open');
    if (document.getElementById('profile-save-status')) setStatus('', false);
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    previousFocus = null;
  }

  async function requestClose(): Promise<void> {
    if (disposed || profileSaving) return;
    if (!isDirty()) {
      closeImmediate();
      return;
    }
    const confirm = dependencies.getConfirm();
    const discard = confirm ? await confirm({
      title: t('Discard profile changes?'),
      message: t('Your unsaved profile changes will be lost.'),
      confirmLabel: t('Discard changes'),
      cancelLabel: t('Keep editing'),
      danger: true
    }) : false;
    if (discard) closeImmediate();
  }

  function releaseObjectUrl(url: string): void {
    if (!activeObjectUrls.delete(url)) return;
    dependencies.revokeObjectURL(url);
  }

  function reset(): void {
    if (disposed) return;
    activityRequestGeneration++;
    profileSaveGeneration++;
    profileDraftRevision = 0;
    avatarLoadGeneration++;
    activityDays = [];
    activityOwner = '';
    activityLoadingOwner = '';
    chosenAvatar = 'graphite';
    initialAvatar = 'graphite';
    initialName = '';
    setProfileSaving(false);
    if (document.getElementById('profile-modal')) closeImmediate();
  }

  function chooseAvatarFile(file: File | null | undefined): void {
    if (disposed || !file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      notify('Choose a PNG, JPEG, WebP or GIF image under 5 MB', 'error');
      return;
    }
    const owner = currentOwner();
    const generation = ++avatarLoadGeneration;
    const objectURL = dependencies.createObjectURL(file);
    activeObjectUrls.add(objectURL);
    const image: AccountProfileImagePort = dependencies.createImage();
    image.onload = () => {
      if (generation !== avatarLoadGeneration || owner !== currentOwner() || disposed) {
        releaseObjectUrl(objectURL);
        return;
      }
      try {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable');
        context.fillStyle = '#1c222b';
        context.fillRect(0, 0, size, size);
        const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image as unknown as CanvasImageSource, (size - width) / 2,
          (size - height) / 2, width, height);
        chosenAvatar = canvas.toDataURL('image/jpeg', 0.82);
        markDraftChanged();
      } finally {
        releaseObjectUrl(objectURL);
      }
    };
    image.onerror = () => {
      releaseObjectUrl(objectURL);
      if (generation !== avatarLoadGeneration || owner !== currentOwner() || disposed) return;
      notify('The selected image could not be read', 'error');
    };
    image.src = objectURL;
  }

  async function save(): Promise<void> {
    const button = $('profile-save');
    void button;
    const owner = currentOwner();
    const generation = ++profileSaveGeneration;
    const savedRevision = profileDraftRevision;
    const submittedName = input('profile-name').value.trim();
    const submittedAvatar = chosenAvatar;
    setProfileSaving(true);
    setStatus('Saving...', false);
    try {
      const result = await dependencies.sendToServer(
        'updateProfile',
        { name: submittedName, avatar: submittedAvatar },
        { quiet: true }
      );
      if (generation !== profileSaveGeneration || owner !== currentOwner()) return;
      if (!result || !result.success) {
        throw new Error(errorMessage(result?.error, t('Update failed')));
      }
      const auth = state.auth;
      const savedUser = result.user as AccountProfileUserDto;
      if (auth) auth.user = savedUser;
      dependencies.getAuth()?.renderChip?.();
      if (profileDraftRevision === savedRevision) {
        renderProfile();
        setStatus('Profile updated', false);
      } else {
        initialName = stringValue(savedUser.name || savedUser.username, submittedName);
        initialAvatar = stringValue(savedUser.avatar, submittedAvatar);
        renderSummary();
        setStatus(isDirty() ? 'Unsaved changes' : 'Profile updated', false);
      }
      notify('Profile updated', 'success');
    } catch (error) {
      if (generation !== profileSaveGeneration || owner !== currentOwner()) return;
      setStatus(errorMessage(error, t('Update failed')), true);
    } finally {
      if (generation === profileSaveGeneration && owner === currentOwner()) setProfileSaving(false);
    }
  }

  function trapFocus(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const modal = $('profile-modal');
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled])'
    )).filter((element) => element.offsetParent !== null && element.style.visibility !== 'hidden');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function init(): void {
    if (disposed || initialized) return;
    initialized = true;
    const authMenuProfile = document.getElementById('auth-menu-profile');
    if (authMenuProfile) listen(authMenuProfile, 'click', () => {
      ($('auth-menu') as HTMLElement).style.display = 'none';
      open('profile');
    });
    const closeButton = document.getElementById('profile-close-x');
    if (closeButton) listen(closeButton, 'click', () => { void requestClose(); });
    const cancelButton = document.getElementById('profile-cancel');
    if (cancelButton) listen(cancelButton, 'click', () => { void requestClose(); });
    const saveButton = document.getElementById('profile-save');
    if (saveButton) listen(saveButton, 'click', () => { void save(); });
    const nameInput = document.getElementById('profile-name');
    if (nameInput) listen(nameInput, 'input', () => markDraftChanged());
    const avatarOptions = document.getElementById('profile-avatar-options');
    if (avatarOptions) listen(avatarOptions, 'click', (event) => {
      const target = event.target as Element | null;
      const button = target?.closest<HTMLElement>('[data-avatar]');
      if (!button) return;
      avatarLoadGeneration++;
      chosenAvatar = button.dataset.avatar || '';
      markDraftChanged();
    });
    const avatarUpload = document.getElementById('profile-avatar-upload');
    if (avatarUpload) listen(avatarUpload, 'click', () => input('profile-avatar-file').click());
    const avatarFile = document.getElementById('profile-avatar-file') as HTMLInputElement | null;
    if (avatarFile) listen(avatarFile, 'change', () => {
      chooseAvatarFile(avatarFile.files?.[0]);
      avatarFile.value = '';
    });
    const copyUid = document.getElementById('profile-copy-uid');
    if (copyUid) listen(copyUid, 'click', async () => {
      try {
        const clipboard = dependencies.clipboard;
        if (!clipboard) throw new Error('Clipboard unavailable');
        await clipboard.writeText($('profile-uid').textContent || '');
        notify('User ID copied', 'success');
      } catch (_) {
        notify('Copy failed', 'error');
      }
    });
    document.querySelectorAll<HTMLElement>('[data-account-tab]').forEach((button) => {
      listen(button, 'click', () => switchTab(button.dataset.accountTab || 'profile'));
    });
    const modal = document.getElementById('profile-modal');
    if (modal) {
      listen(modal, 'click', (event) => {
        if (event.target === modal) void requestClose();
      });
      listen(modal, 'keydown', (event) => trapFocus(event as KeyboardEvent));
    }
    listen(document, 'keydown', (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== 'Escape' || !document.getElementById('profile-modal')?.classList.contains('open')) return;
      const confirmDialog = document.getElementById('confirm-dialog');
      if (confirmDialog?.classList.contains('open')) return;
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      void requestClose();
    }, true);
    const collaboration = dependencies.getCollaboration();
    if (collaboration) {
      collaborationOwner = collaboration;
      previousCollaborationOpenProfile = collaboration.openProfile;
      collaboration.openProfile = open;
    }
    const i18n = dependencies.getI18n();
    if (i18n?.onChange) {
      const unsubscribe = i18n.onChange(() => {
        if (disposed || !document.getElementById('profile-modal')?.classList.contains('open')) return;
        renderSummary();
        renderActivity();
      });
      lifecycle.add(toDisposable(unsubscribe));
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    pendingTimers.forEach((timer) => dependencies.clearTimeout(timer));
    pendingTimers.clear();
    avatarLoadGeneration++;
    activeObjectUrls.forEach((url) => dependencies.revokeObjectURL(url));
    activeObjectUrls.clear();
    lifecycle.dispose();
    if (collaborationOwner && collaborationOwner.openProfile === open) {
      if (previousCollaborationOpenProfile) {
        collaborationOwner.openProfile = previousCollaborationOpenProfile;
      } else {
        delete collaborationOwner.openProfile;
      }
    }
    collaborationOwner = null;
    previousCollaborationOpenProfile = undefined;
    activityRequestGeneration++;
    profileSaveGeneration++;
    activityDays = [];
    activityOwner = '';
    activityLoadingOwner = '';
    profileSaving = false;
    closeImmediate();
    previousFocus = null;
  }

  const service: AccountProfileFacade & AccountProfileService = {
    get disposed(): boolean { return disposed; },
    init,
    open,
    close: requestClose,
    reset,
    renderActivity,
    dispose
  };
  return Object.freeze(service);
}
