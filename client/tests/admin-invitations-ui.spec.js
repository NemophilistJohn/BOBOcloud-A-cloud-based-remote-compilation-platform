"use strict";
const { test, expect, _electron: electron } = require("@playwright/test");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
test("invitation center separates live links and history and prevents duplicate creation and stale revocation", async () => {
  test.setTimeout(60000);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bobo-invitations-"));
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
    await page.evaluate(() => {
      window.__inviteCalls = [];
      const b = window.BOBO;
      b.state.auth.mode = "multi";
      b.state.auth.token = "fixture";
      b.state.auth.user = {
        id: "root",
        uid: "root-uid",
        username: "root",
        role: "root",
      };
      const base = {
        kind: "register",
        syncMode: "restricted",
        role: "member",
        createdBy: "root",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      const rows = [
        {
          ...base,
          id: "a".repeat(64),
          state: "available",
          label: "Design team",
        },
        {
          ...base,
          id: "b".repeat(64),
          state: "revoked",
          label: "Old invitation",
        },
        {
          ...base,
          id: "c".repeat(64),
          kind: "device",
          targetUserId: "member",
          state: "available",
        },
      ];
      b.sendToServer = async (action, payload) => {
        window.__inviteCalls.push(action);
        if (action === "listEnrollments")
          return { success: true, data: { enrollments: rows } };
        if (action === "createEnrollment") {
          await new Promise((r) => setTimeout(r, 150));
          return {
            success: true,
            data: {
              link: "bobocloud://enroll#fake-fixture-only",
              expiresAt: base.expiresAt,
            },
          };
        }
        if (action === "revokeEnrollment") {
          rows.find((r) => r.id === payload.enrollmentId).state = "revoked";
          return {
            success: false,
            error: "enrollment.error.noLongerAvailable",
          };
        }
        return { success: true, users: [] };
      };
      document.getElementById("auth-menu-admin").click();
    });
    await page.locator('.admin-tab[data-pane="invites"]').click();
    await expect(page.locator(".invitation-table tbody tr")).toHaveCount(1);
    await expect(page.locator("[data-revoke-invitation]")).toHaveCount(1);
    await page.locator('[data-invite-filter="history"]').click();
    await expect(page.locator(".invitation-table tbody tr")).toHaveCount(1);
    await expect(page.locator("[data-revoke-invitation]")).toHaveCount(0);
    await page.locator("#invite-create").dblclick();
    await expect(page.locator("#invite-new-box")).toContainText(
      "Your invitation is ready",
    );
    await expect(page.locator("#invite-new-box")).toContainText(
      "This link expires",
    );
    await expect(page.locator("#invite-search")).toHaveAttribute(
      "placeholder",
      "Search invitations",
    );
    expect(
      await page.evaluate(
        () =>
          window.__inviteCalls.filter((a) => a === "createEnrollment").length,
      ),
    ).toBe(1);
    await expect(page.locator("#invite-new-box code")).toBeHidden();
    await page.locator("[data-revoke-invitation]").click();
    await expect(page.locator("#invite-status")).toContainText(
      "already expired or been used",
    );
    await expect(page.locator("[data-revoke-invitation]")).toHaveCount(0);
    await expect(page.locator(".invitation-empty")).toBeVisible();
    await page.locator('[data-invite-filter="history"]').click();
    await expect(page.locator(".invitation-table tbody tr")).toHaveCount(2);
    await page.evaluate(() => window.BOBO.i18n.setLocale("zh-CN"));
    await expect(page.locator(".invitation-center-head h2")).toHaveText(
      "邀请链接",
    );
    fs.mkdirSync("test-results", { recursive: true });
    await page.screenshot({
      path: path.join(process.cwd(), "test-results/admin-invitations.png"),
    });
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
