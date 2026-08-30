const { test, expect, _electron: electron } = require('playwright/test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  if (process.platform === 'win32') return path.join(dist, 'electron.exe');
  if (process.platform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

async function launchIsolatedApp(prefix) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath(),
    args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
    env: Object.assign({}, process.env, {
      APPDATA: appData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config')
    })
  });
  const page = await app.firstWindow();
  const issues = [];
  page.on('pageerror', error => issues.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.text());
  });
  await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true', null, { timeout: 20000 });
  return { app, page, sandbox, issues };
}

async function closeIsolatedApp(fixture) {
  if (!fixture) return;
  try { await fixture.app.evaluate(({ app }) => app.exit(0)); } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
  await fs.promises.rm(fixture.sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
}

function evidencePath(name) {
  const root = process.env.BOBO_UI_EVIDENCE_DIR || path.join(os.tmpdir(), 'bobo-ui-evidence');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, name);
}

async function settingsGeometry(page) {
  return page.evaluate(() => {
    const card = document.querySelector('#settings-modal .settings-card');
    const head = card.querySelector('.ss-head');
    const tabs = card.querySelector('.settings-tabs');
    const body = card.querySelector('.settings-body');
    const foot = card.querySelector('.settings-foot.active');
    const close = card.querySelector('#settings-close-x');
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, right: box.right, bottom: box.bottom, left: box.left };
    };
    const closeRect = rect(close);
    const topElement = document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2);
    return {
      card: rect(card), head: rect(head), tabs: rect(tabs), body: rect(body), foot: rect(foot), close: closeRect,
      cardOverflow: getComputedStyle(card).overflowY,
      bodyOverflow: getComputedStyle(body).overflowY,
      cardScrolls: card.scrollHeight > card.clientHeight + 1,
      bodyScrolls: body.scrollHeight > body.clientHeight + 1,
      closeOnTop: topElement === close || close.contains(topElement),
      bodyScrollTop: body.scrollTop
    };
  });
}

test('settings keeps a stable frame and scrolls only the active pane region', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launchIsolatedApp('bobo-settings-layout-');
    const { page } = fixture;
    await page.setViewportSize({ width: 900, height: 640 });
    await page.evaluate(() => window.BOBO.settings.open('local'));
    await expect(page.locator('#settings-modal')).toBeVisible();

    const tabs = await page.locator('.settings-tab[data-stab]').evaluateAll(items =>
      items.map(item => item.getAttribute('data-stab'))
    );
    expect(tabs.length).toBeGreaterThan(1);
    const snapshots = [];
    for (const tab of tabs) {
      await page.locator(`.settings-tab[data-stab="${tab}"]`).click();
      await expect(page.locator(`.settings-pane[data-spane="${tab}"]`)).toBeVisible();
      snapshots.push({ tab, geometry: await settingsGeometry(page) });
    }

    const baseline = snapshots[0].geometry.card;
    for (const { tab, geometry } of snapshots) {
      expect.soft(Math.abs(geometry.card.x - baseline.x), `${tab} x`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(geometry.card.y - baseline.y), `${tab} y`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(geometry.card.width - baseline.width), `${tab} width`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(geometry.card.height - baseline.height), `${tab} height`).toBeLessThanOrEqual(1);
      expect.soft(geometry.cardScrolls, `${tab} card scroll`).toBe(false);
      expect.soft(geometry.cardOverflow, `${tab} card overflow`).toBe('hidden');
      expect.soft(geometry.bodyOverflow, `${tab} body overflow`).toBe('auto');
      expect.soft(geometry.closeOnTop, `${tab} close accessible`).toBe(true);
      expect.soft(geometry.head.top, `${tab} header top`).toBeGreaterThanOrEqual(geometry.card.top - 1);
      expect.soft(geometry.foot.bottom, `${tab} footer bottom`).toBeLessThanOrEqual(geometry.card.bottom + 1);
    }

    const scrollable = snapshots.find(snapshot => snapshot.geometry.bodyScrolls);
    expect(scrollable, 'at least one settings pane should exercise body scrolling').toBeTruthy();
    await page.locator(`.settings-tab[data-stab="${scrollable.tab}"]`).click();
    const beforeScroll = await settingsGeometry(page);
    await page.evaluate(() => {
      const body = document.querySelector('#settings-modal .settings-body');
      body.scrollTop = body.scrollHeight;
    });
    const afterScroll = await settingsGeometry(page);
    expect(afterScroll.bodyScrollTop).toBeGreaterThan(0);
    expect(afterScroll.head).toEqual(beforeScroll.head);
    expect(afterScroll.tabs).toEqual(beforeScroll.tabs);
    expect(afterScroll.foot).toEqual(beforeScroll.foot);

    const otherTab = tabs.find(tab => tab !== scrollable.tab);
    await page.locator(`.settings-tab[data-stab="${otherTab}"]`).click();
    await page.locator(`.settings-tab[data-stab="${scrollable.tab}"]`).click();
    expect((await settingsGeometry(page)).bodyScrollTop).toBe(0);
    await page.evaluate(() => {
      const body = document.querySelector('#settings-modal .settings-body');
      body.scrollTop = body.scrollHeight;
    });
    await page.screenshot({ path: evidencePath('settings-stable-layout.png'), fullPage: false });

    await page.locator('#settings-close-x').click();
    await expect(page.locator('#settings-modal')).toBeHidden();
    expect(fixture.issues).toEqual([]);
  } finally {
    await closeIsolatedApp(fixture);
  }
});

test('theme choices show real palette colors and apply only after confirmation', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launchIsolatedApp('bobo-theme-choices-');
    const { page } = fixture;
    await page.setViewportSize({ width: 1200, height: 800 });
    expect(page.url()).toMatch(/^file:.*\/index\.html$/i);
    await expect(page).toHaveTitle('BOBOCLOUD Editor');
    await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay, nextjs-portal')).toHaveCount(0);
    await page.evaluate(() => window.BOBO.settings.open('local'));

    const list = page.locator('#settings-theme-list');
    const rows = page.locator('.theme-choice');
    await expect(list).toBeVisible();
    await expect(page.locator('#settings-theme-select')).toHaveCount(0);
    await expect(rows).toHaveCount(5);
    await expect(page.locator('.theme-choice-radio:checked')).toHaveCount(1);
    await expect(page.locator('.theme-choice[data-theme-id="cloud-forge"] .theme-choice-radio')).toBeChecked();
    const layout = await list.evaluate(element => ({
      fits: element.scrollWidth <= element.clientWidth + 1,
      rows: Array.from(element.querySelectorAll('.theme-choice')).map(row => {
        const name = row.querySelector('.theme-choice-name').getBoundingClientRect();
        const swatches = row.querySelector('.theme-choice-swatches').getBoundingClientRect();
        const radio = row.querySelector('.theme-choice-radio').getBoundingClientRect();
        return {
          height: row.getBoundingClientRect().height,
          ordered: name.right <= swatches.left + 1 && swatches.right <= radio.left + 1,
          swatchCount: row.querySelectorAll('.theme-choice-swatch').length,
          colorsVisible: Array.from(row.querySelectorAll('.theme-choice-swatch')).every(swatch => getComputedStyle(swatch).backgroundColor !== 'rgba(0, 0, 0, 0)'),
          radioRadius: getComputedStyle(row.querySelector('.theme-choice-radio')).borderRadius
        };
      })
    }));
    expect(layout.fits).toBe(true);
    for (const row of layout.rows) {
      expect(row.height).toBeGreaterThanOrEqual(47);
      expect(row.height).toBeLessThanOrEqual(49);
      expect(row.ordered).toBe(true);
      expect(row.swatchCount).toBe(5);
      expect(row.colorsVisible).toBe(true);
      expect(row.radioRadius).toBe('50%');
    }

    await page.locator('.theme-choice[data-theme-id="monokai"]').click();
    await expect(page.locator('.theme-choice[data-theme-id="monokai"] .theme-choice-radio')).toBeChecked();
    expect(await page.evaluate(() => ({
      current: window.themeManager.getCurrentTheme(),
      stored: localStorage.getItem('bobocloud.theme')
    }))).toEqual({ current: 'cloud-forge', stored: 'cloud-forge' });

    await page.locator('#settings-save-local').click();
    await expect(page.locator('#settings-modal')).toBeHidden();
    expect(await page.evaluate(() => ({
      current: window.themeManager.getCurrentTheme(),
      stored: localStorage.getItem('bobocloud.theme'),
      background: document.documentElement.style.getPropertyValue('--bg-deep'),
      brand: document.documentElement.style.getPropertyValue('--brand')
    }))).toEqual({ current: 'monokai', stored: 'monokai', background: '#272822', brand: '#A6E22E' });

    await page.evaluate(() => window.BOBO.settings.open('local'));
    await expect(page.locator('.theme-choice[data-theme-id="monokai"] .theme-choice-radio')).toBeChecked();
    await page.screenshot({ path: evidencePath('theme-choice-list-monokai.png'), fullPage: false });

    await page.locator('.theme-choice[data-theme-id="monokai"] .theme-choice-radio').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.theme-choice[data-theme-id="dracula"] .theme-choice-radio')).toBeChecked();
    await page.locator('.theme-choice[data-theme-id="monokai"]').click();
    const toast = page.locator('#toast-container .toast');
    if (await toast.count()) await toast.click();
    await expect(toast).toHaveCount(0);
    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await expect(page.locator('.theme-choice[data-theme-id="light"] .theme-choice-name')).toHaveText('浅色');
    await page.evaluate(() => window.BOBO.i18n.setLocale('ja'));
    await expect(page.locator('.theme-choice[data-theme-id="light"] .theme-choice-name')).toHaveText('ライト');
    await page.evaluate(() => window.BOBO.i18n.setLocale('zh-CN'));
    await page.setViewportSize({ width: 650, height: 640 });
    const compact = await list.evaluate(element => ({
      fits: element.scrollWidth <= element.clientWidth + 1,
      viewportFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      rowsOrdered: Array.from(element.querySelectorAll('.theme-choice')).every(row => {
        const name = row.querySelector('.theme-choice-name').getBoundingClientRect();
        const swatches = row.querySelector('.theme-choice-swatches').getBoundingClientRect();
        const radio = row.querySelector('.theme-choice-radio').getBoundingClientRect();
        return name.right <= swatches.left + 1 && swatches.right <= radio.left + 1;
      })
    }));
    expect(compact).toEqual({ fits: true, viewportFits: true, rowsOrdered: true });
    await page.screenshot({ path: evidencePath('theme-choice-list-compact-zh.png'), fullPage: false });

    await page.locator('.theme-choice[data-theme-id="light"]').click();
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-modal')).toBeHidden();
    expect(await page.evaluate(() => ({
      current: window.themeManager.getCurrentTheme(),
      stored: localStorage.getItem('bobocloud.theme')
    }))).toEqual({ current: 'monokai', stored: 'monokai' });
    expect(fixture.issues).toEqual([]);
  } finally {
    await closeIsolatedApp(fixture);
  }
});

test('Monaco suggest rows and find action tooltips stay fully visible', async () => {
  test.setTimeout(60000);
  let fixture;
  try {
    fixture = await launchIsolatedApp('bobo-editor-widgets-');
    const { page } = fixture;
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.evaluate(() => {
      const editor = window.BOBO.state.editor;
      document.getElementById('editor').classList.remove('empty');
      const model = editor.getModel();
      window.monaco.editor.setModelLanguage(model, 'javascript');
      model.setValue('const completionTarget = item');
      editor.setPosition({ lineNumber: 1, column: model.getLineMaxColumn(1) });
      window.__visualCompletionProvider = window.monaco.languages.registerCompletionItemProvider('javascript', {
        provideCompletionItems: function(currentModel, position) {
          const word = currentModel.getWordUntilPosition(position);
          return {
            suggestions: Array.from({ length: 30 }, (_, index) => ({
              label: `item_visual_${String(index + 1).padStart(2, '0')}`,
              kind: window.monaco.languages.CompletionItemKind.Variable,
              insertText: `item_visual_${String(index + 1).padStart(2, '0')}`,
              range: {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn
              }
            }))
          };
        }
      });
      editor.focus();
      editor.trigger('visual-regression-test', 'editor.action.triggerSuggest', {});
    });
    const suggest = page.locator('.suggest-widget.visible');
    await expect(suggest).toBeVisible();
    await expect(suggest).toContainText('item_visual_01');
    const suggestionGeometry = await page.evaluate(() => {
      const widget = document.querySelector('.suggest-widget.visible');
      const list = widget.querySelector('.monaco-list');
      const rows = Array.from(widget.querySelectorAll('.monaco-list-row'));
      const listRect = list.getBoundingClientRect();
      const visibleRows = rows.map(row => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height, text: row.textContent.trim() };
      }).filter(row => row.bottom > listRect.top + 0.5 && row.top < listRect.bottom - 0.5);
      return {
        list: listRect.toJSON(),
        visibleRows,
        lastVisible: visibleRows[visibleRows.length - 1],
        treePaddingTop: getComputedStyle(widget.querySelector('.tree')).paddingTop,
        treePaddingBottom: getComputedStyle(widget.querySelector('.tree')).paddingBottom
      };
    });
    expect(suggestionGeometry.visibleRows.length).toBeGreaterThan(1);
    expect(suggestionGeometry.treePaddingTop).toBe('0px');
    expect(suggestionGeometry.treePaddingBottom).toBe('0px');
    expect(suggestionGeometry.lastVisible.bottom).toBeLessThanOrEqual(suggestionGeometry.list.bottom + 0.5);
    await page.screenshot({ path: evidencePath('monaco-suggest-complete-rows.png'), fullPage: false });

    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+f');
    const findWidget = page.locator('.find-widget').filter({ visible: true });
    await expect(findWidget).toBeVisible();
    const action = findWidget.locator('.codicon-replace, .codicon-preserve-case, .codicon-regex').first();
    await expect(action).toBeVisible();
    await action.hover();
    const hover = page.locator('.monaco-hover.workbench-hover').filter({ visible: true }).last();
    await expect(hover).toBeVisible({ timeout: 3000 });
    const tooltipGeometry = await page.evaluate(() => {
      const editor = document.querySelector('#container .monaco-editor');
      const hover = Array.from(document.querySelectorAll('.monaco-hover.workbench-hover')).find(item => {
        const style = getComputedStyle(item);
        const rect = item.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
      const rect = hover.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const hitInsideHover = [rect.top + 2, rect.top + rect.height / 2, rect.bottom - 2].every(y => {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, y);
        return hit === hover || hover.contains(hit);
      });
      return {
        hover: rect.toJSON(),
        editor: editorRect.toJSON(),
        viewport: { width: innerWidth, height: innerHeight },
        hitInsideHover
      };
    });
    expect(tooltipGeometry.hover.top).toBeLessThan(tooltipGeometry.editor.top);
    expect(tooltipGeometry.hover.top).toBeGreaterThanOrEqual(0);
    expect(tooltipGeometry.hover.left).toBeGreaterThanOrEqual(0);
    expect(tooltipGeometry.hover.right).toBeLessThanOrEqual(tooltipGeometry.viewport.width + 0.5);
    expect(tooltipGeometry.hover.bottom).toBeLessThanOrEqual(tooltipGeometry.viewport.height + 0.5);
    expect(tooltipGeometry.hitInsideHover).toBe(true);
    await page.screenshot({ path: evidencePath('monaco-find-tooltip.png'), fullPage: false });
    expect(fixture.issues).toEqual([]);
  } finally {
    if (fixture) {
      try { await fixture.page.evaluate(() => window.__visualCompletionProvider && window.__visualCompletionProvider.dispose()); } catch {}
    }
    await closeIsolatedApp(fixture);
  }
});
