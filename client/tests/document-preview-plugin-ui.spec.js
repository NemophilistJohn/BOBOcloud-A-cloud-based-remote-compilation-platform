const { test, expect, _electron: electron } = require('playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginController } = require('../main/plugins');
const { resolvePluginArtifact, shouldSkipMissingArtifact } = require('./support/plugin-artifact');

const PLUGIN_ID = 'bobocloud.document-preview';
const PLUGIN_REPOSITORY = process.env.BOBO_DOCUMENT_PREVIEW_PLUGIN_DIR
  ? path.resolve(process.env.BOBO_DOCUMENT_PREVIEW_PLUGIN_DIR)
  : path.resolve(__dirname, '..', '..', '..', 'bobocloud-document-preview');
const ARTIFACT_INFO = resolvePluginArtifact({
  artifactEnv: 'BOBO_DOCUMENT_PREVIEW_PLUGIN_ARTIFACT',
  pluginId: PLUGIN_ID,
  repositoryRoot: PLUGIN_REPOSITORY,
  versionEnv: 'BOBO_DOCUMENT_PREVIEW_PLUGIN_VERSION'
});
const ARTIFACT = ARTIFACT_INFO.artifactPath;

function electronPath() {
  const dist = path.join(process.cwd(), 'node_modules', 'electron', 'dist');
  return process.platform === 'win32' ? path.join(dist, 'electron.exe') : path.join(dist, 'electron');
}

function makePdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 33} >>\nstream\nBT /F1 24 Tf 72 700 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += String(offset).padStart(10, '0') + ' 00000 n \n';
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, 'ascii');
}

function makeXlsx() {
  const { zipSync, strToU8 } = require(path.join(PLUGIN_REPOSITORY, 'node_modules', 'fflate'));
  const entries = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Overview" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Project</t></is></c><c r="B1" t="inlineStr"><is><t>Status</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>BOBOCloud</t></is></c><c r="B2" t="inlineStr"><is><t>Ready</t></is></c></row></sheetData></worksheet>'
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)]))));
}

function createWorkspace(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'guide.md'), '# BOBOCloud Guide\n\n<script>window.parent.__unsafe = true</script>\n\n## Preview section\n', 'utf8');
  fs.writeFileSync(path.join(root, 'records.csv'), 'Name,Status\nAlpha,Ready\nBeta,Pending\n', 'utf8');
  fs.writeFileSync(path.join(root, 'workbook.xlsx'), makeXlsx());
  fs.writeFileSync(path.join(root, 'sample.pdf'), makePdf('BOBOCloud PDF Preview'));
}

async function stop(app) {
  if (!app) return;
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function activeDocumentFrame(page) {
  const iframe = page.locator('#document-view-host iframe.document-view-frame:not([hidden])').last();
  await expect(iframe).toBeVisible({ timeout: 20000 });
  const handle = await iframe.elementHandle();
  return { iframe, frame: await handle.contentFrame() };
}

test('official document preview renders four formats while retaining an opaque isolated boundary', async () => {
  test.skip(shouldSkipMissingArtifact(ARTIFACT_INFO, 'Document preview plugin artifact'), 'Document preview artifact is not present beside the app repository.');
  test.setTimeout(120000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bobo-document-preview-ui-'));
  const workspace = path.join(sandbox, 'workspace');
  const appData = path.join(sandbox, 'appdata');
  const home = path.join(sandbox, 'home');
  const evidence = path.join(os.tmpdir(), 'bobo-ui-evidence');
  createWorkspace(workspace);
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  let app;

  try {
    app = await electron.launch({
      executablePath: electronPath(),
      args: ['.', '--user-data-dir=' + path.join(sandbox, 'chromium')],
      env: Object.assign({}, process.env, {
        APPDATA: appData,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(sandbox, 'xdg-config'),
        BOBO_FORCE_FIRST_RUN: '0',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      })
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.waitForFunction(() => document.documentElement.dataset.boboReady === 'true' && window.BOBO.documentViews, null, { timeout: 25000 });
    await page.evaluate(async (workspacePath) => {
      const opened = await window.api.pickWorkspace(workspacePath);
      await window.BOBO.workspace.applyWorkspace(opened.rootPath, opened.tree, opened.workspaceIdentity, opened.leaveToken);
    }, workspace);

    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
    const installer = createPluginController({
      app: { getPath: () => userData, getVersion: () => '2.6.1' },
      ipcMain: { handle() {} },
      getWindow: () => null,
      getWorkspaceIdentity: () => ({ rootPath: workspace, workspaceIdentity: 1 }),
      hostVersion: '2.6.1'
    });
    await installer.installArchiveFromPath(ARTIFACT);
    await page.evaluate(async (id) => {
      await window.api.plugins.refresh();
      await window.api.plugins.enable(id);
    }, PLUGIN_ID);
    await page.waitForFunction(() => Boolean(window.BOBO.documentViews.find('guide.md')), null, { timeout: 20000 });

    await page.evaluate(({ filePath, name }) => window.BOBO.workspace.openFile(filePath, name), {
      filePath: path.join(workspace, 'guide.md'),
      name: 'guide.md'
    });
    let active = await activeDocumentFrame(page);
    await expect(active.frame.locator('.markdown-preview h1')).toHaveText('BOBOCloud Guide');
    await expect(active.frame.locator('.markdown-preview script')).toHaveCount(0);
    expect(await active.iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(await active.frame.evaluate(() => ({
      api: typeof window.api,
      bobo: typeof window.BOBO,
      origin: location.origin,
      parentBlocked: (() => { try { void window.parent.document; return false; } catch (_) { return true; } })()
    }))).toEqual({ api: 'undefined', bobo: 'undefined', origin: 'null', parentBlocked: true });
    expect(await active.frame.evaluate(async () => {
      try { await fetch('https://example.com/'); return false; } catch (_) { return true; }
    })).toBe(true);

    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('zh-CN'); });
    await expect(active.frame.locator('.segmented-control button').first()).toHaveText('预览');
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('ja'); });
    await expect(active.frame.locator('.segmented-control button').first()).toHaveText('プレビュー');
    await page.evaluate(async () => { await window.BOBO.i18n.setLocale('en'); });
    await page.screenshot({ path: path.join(evidence, 'official-document-preview-markdown.png'), fullPage: false });

    await page.evaluate(({ filePath, name }) => window.BOBO.workspace.openFile(filePath, name), {
      filePath: path.join(workspace, 'records.csv'),
      name: 'records.csv'
    });
    active = await activeDocumentFrame(page);
    await expect(active.frame.locator('.grid-header').first()).toHaveText('Name');
    await expect(active.frame.locator('.grid-value').filter({ hasText: 'Alpha' })).toHaveCount(1);

    await page.evaluate(({ filePath, name }) => window.BOBO.workspace.openFile(filePath, name), {
      filePath: path.join(workspace, 'workbook.xlsx'),
      name: 'workbook.xlsx'
    });
    active = await activeDocumentFrame(page);
    await expect(active.frame.locator('.sheet-tab.active')).toHaveText('Overview');
    await expect(active.frame.locator('.grid-value').filter({ hasText: 'BOBOCloud' })).toHaveCount(1);
    await page.screenshot({ path: path.join(evidence, 'official-document-preview-excel.png'), fullPage: false });

    await page.evaluate(({ filePath, name }) => window.BOBO.workspace.openFile(filePath, name), {
      filePath: path.join(workspace, 'sample.pdf'),
      name: 'sample.pdf'
    });
    active = await activeDocumentFrame(page);
    const canvas = active.frame.locator('.pdf-page canvas');
    await expect.poll(async () => {
      if (await canvas.count()) return 'ready';
      return await active.frame.locator('.preview-state').getAttribute('title') || 'pending';
    }, { timeout: 30000, message: 'PDF viewer should render a canvas; a localized failure state reports its parser detail.' }).toBe('ready');
    await expect(canvas).toBeVisible({ timeout: 30000 });
    expect(await canvas.evaluate((node) => {
      const context = node.getContext('2d');
      const pixels = context.getImageData(0, 0, node.width, node.height).data;
      let nonWhite = 0;
      for (let index = 0; index < pixels.length; index += 64) {
        if (pixels[index] < 245 || pixels[index + 1] < 245 || pixels[index + 2] < 245) nonWhite += 1;
      }
      return { width: node.width, height: node.height, nonWhite };
    })).toMatchObject({ width: expect.any(Number), height: expect.any(Number), nonWhite: expect.any(Number) });
    expect(await canvas.evaluate((node) => node.width > 100 && node.height > 100)).toBe(true);
    expect(await canvas.evaluate((node) => {
      const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
      for (let index = 0; index < data.length; index += 64) {
        if (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245) return true;
      }
      return false;
    })).toBe(true);
    await page.screenshot({ path: path.join(evidence, 'official-document-preview-pdf.png'), fullPage: false });

    await page.evaluate((id) => window.api.plugins.disable(id), PLUGIN_ID);
    await expect(page.locator('#document-view-host iframe.document-view-frame')).toHaveCount(0, { timeout: 20000 });
    expect(pageErrors).toEqual([]);
  } finally {
    await stop(app);
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});
