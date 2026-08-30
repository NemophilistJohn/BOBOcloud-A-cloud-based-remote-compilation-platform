'use strict';

const { defineConfig } = require('@playwright/test');
const { UI_GROUPS, selectionForGroup } = require('./tests/ui-test-groups');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: 'test-results/playwright',
  reporter: process.env.CI
    ? [
        ['line'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/playwright.xml' }]
      ]
    : [['line']],
  projects: UI_GROUPS.map((group) => ({
    name: group,
    ...selectionForGroup(group)
  })),
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});
