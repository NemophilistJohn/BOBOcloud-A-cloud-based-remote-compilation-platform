"use strict";
const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
test("account manager slides actions, preserves its view on logout, blocks last-device removal, and splits add choices", async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(
    path.join(os.tmpdir(), "bobo-account-manager-"),
  );
  let app;
  try {
    app = await electron.launch({
      executablePath: path.join(
        process.cwd(),
        "node_modules/electron/dist",
        process.platform === "win32" ? "electron.exe" : "electron",
      ),
      args: [".", "--user-data-dir=" + path.join(sandbox, "chromium")],
      env: {
        ...process.env,
        APPDATA: path.join(sandbox, "appdata"),
        HOME: path.join(sandbox, "home"),
        USERPROFILE: path.join(sandbox, "home"),
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => document.documentElement.dataset.boboReady === "true",
    );
    await expect(page.locator("#auth-menu-accounts")).toContainText(
      "Account management",
    );
    await expect(page.locator("#auth-menu-logout")).toHaveCount(0);
    await app.evaluate(({ ipcMain }) => {
      const accounts = [
        {
          id: "a".repeat(64),
          username: "root",
          userId: "root",
          uid: "uid_root",
          name: "Root Builder",
          avatar: "forest",
          role: "root",
          server: "cloud.example",
          online: true,
          authorized: true,
          savedAt: 2,
        },
        {
          id: "b".repeat(64),
          username: "member",
          userId: "member-id",
          uid: "uid_member",
          name: "Member Builder",
          avatar: "ocean",
          role: "member",
          server: "cloud.example",
          online: false,
          authorized: true,
          savedAt: 1,
        },
      ];
      for (const key of [
        "accounts:list",
        "accounts:logout",
        "accounts:switch",
        "accounts:remove",
      ])
        ipcMain.removeHandler(key);
      ipcMain.handle("accounts:list", () => accounts);
      ipcMain.handle("accounts:logout", () => {
        accounts.forEach((a) => (a.online = false));
      });
      ipcMain.handle("accounts:switch", (_e, id) => {
        accounts.forEach((a) => (a.online = a.id === id));
        const a = accounts.find((a) => a.id === id);
        return {
          success: true,
          user: {
            id: a.userId,
            uid: a.uid,
            username: a.username,
            role: a.role,
          },
          token: "test-token",
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          syncReady: true,
        };
      });
      ipcMain.handle("accounts:remove", () => {
        throw Error("accounts.error.lastDevice");
      });
    });
    await page.evaluate(() => {
      const b = window.BOBO;
      b.auth.prepareAccountTransition = async () => true;
      b.auth.completeAccountTransition = async () => {};
      b.auth.accountLoggedOut = () => {};
      b.accountManager.open();
    });
    await expect(page.locator("#account-manager")).toBeVisible();
    await expect(page.locator(".managed-account")).toHaveCount(2);
    await expect(page.locator(".managed-account").first()).toContainText(
      "uid_root",
    );
    const current = page.locator(".managed-account.is-online");
    await current.hover();
    await expect(
      current.locator('[data-account-action="logout"]'),
    ).toBeVisible();
    await current.locator('[data-account-action="logout"]').click();
    await expect(page.locator("#account-manager")).toBeVisible();
    await expect(page.locator(".managed-account.is-online")).toHaveCount(0);
    const member = page.locator(
      '[data-saved-account="' + "b".repeat(64) + '"]',
    );
    await member.hover();
    await member.locator(".account-row-main").click();
    await expect(member).toHaveClass(/is-online/);
    const root = page.locator('[data-saved-account="' + "a".repeat(64) + '"]');
    await root.hover();
    await root.locator('[data-account-action="delete"]').click();
    await page.locator("#confirm-dialog .confirm-btn-danger").click();
    await expect(page.locator("#confirm-dialog")).toContainText(
      "only authorized device",
    );
    await page.locator("#confirm-dialog .confirm-btn-primary").click();
    await expect(page.locator(".managed-account")).toHaveCount(2);
    await page.evaluate(() => window.BOBO.i18n.setLocale("ja"));
    await expect(page.locator("#account-manager-title")).toHaveText("アカウント管理");
    await page.evaluate(() => window.BOBO.i18n.setLocale("zh-CN"));
    await expect(page.locator("#account-manager-title")).toHaveText("账号管理");
    await page.evaluate(() => window.BOBO.i18n.setLocale("en"));
    await page.setViewportSize({ width: 820, height: 740 });
    await page.locator(".account-add-row").hover();
    await expect(page.locator(".account-add-half.existing")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(page.locator(".account-add-half.register")).toHaveCSS(
      "opacity",
      "1",
    );
    fs.mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: path.join(process.cwd(), "test-results/account-manager.png"),
    });
    await page
      .locator(".account-add-half.existing")
      .click({ position: { x: 65, y: 50 } });
    await expect(page.locator("#welcome-page")).toBeVisible();
    await expect(page.locator("#welcome-title")).toHaveText(
      "Add an authorized account",
    );
    await expect(page.locator("#account-manager")).toBeHidden();
    await page.evaluate(() => {
      window.BOBO.welcome.close();
      window.BOBO.accountManager.open();
    });
    await page.locator(".account-add-row").hover();
    await page.locator(".account-add-half.register").click({ position: { x: 430, y: 50 } });
    await expect(page.locator("#welcome-title")).toHaveText(
      "Create an account with an invitation",
    );
  } finally {
    if (app) {
      try {
        await app.evaluate(({ app }) => app.exit(0));
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 200));
    await fs.promises.rm(sandbox, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});
