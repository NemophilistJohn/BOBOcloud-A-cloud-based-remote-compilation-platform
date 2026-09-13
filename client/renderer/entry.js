// Renderer composition root.
//
// These side-effect imports preserve the legacy BOBO/global registration order
// while giving the renderer a single, auditable build entry. Keep Monaco's AMD
// loader outside this bundle: src/app.js configures and invokes it at runtime.

// Theme and editor-rule foundations.
import './core/bootstrap.ts';
import './core/native-host-adapter.ts';
import './compat/platform-adapter.ts';
import './compat/theme-manager-adapter.ts';
import '../editor-rules/completion-engine.ts';
import '../completion-rules.js';
import '../editor-rules/symbol-extractor.js';
import '../editor-rules/diagnostics/c-family-checker.js';
import '../editor-rules/plugins/python.js';
import '../editor-rules/plugins/c.js';
import '../editor-rules/plugins/cpp.js';
import '../editor-rules/plugins/java.js';
import '../editor-rules/plugins/go.js';
import '../editor-rules/plugins/rust.js';

// Workbench modules.
import './compat/state-adapter.ts';
import './compat/tab-order-adapter.ts';
import './compat/i18n-adapter.ts';
import './compat/diagnostics-settings-adapter.ts';
import './compat/workspace-launch-adapter.ts';
import './compat/icons-adapter.ts';
import './compat/confirm-dialog-adapter.ts';
import './compat/toast-adapter.ts';
import './compat/command-palette-adapter.ts';
import './core/plugin-extension-bootstrap.ts';
import './compat/workbench-layout-adapter.ts';
import './compat/source-control-view-adapter.ts';
import './compat/file-search-adapter.ts';
import './compat/settings-adapter.ts';
import './compat/plugin-manager-ui-adapter.ts';
import './compat/language-packs-panel-adapter.ts';
import './compat/utils-adapter.ts';
import './compat/server-transport-adapter.ts';
import './compat/server-comm-adapter.ts';
import './compat/run-output-adapter.ts';
import './compat/server-capabilities-adapter.ts';
import './compat/cloud-feature-policy-adapter.ts';
import '../src/lsp-client.js';
import './compat/output-panel-adapter.ts';
import '../src/terminal.js';
import './compat/runtime-adapter.ts';
import './compat/file-icons-adapter.ts';
import './compat/workspace-sync-status-adapter.ts';
import './compat/workspace-settings-adapter.ts';
import './compat/editor-core-adapter.ts';
import './compat/document-views-adapter.ts';
import '../src/workspace.js';
import './compat/agent-workbench-adapter.ts';
import './compat/plugin-details-adapter.ts';
import './compat/rclone-client-adapter.ts';
import './compat/rclone-settings-adapter.ts';
import './compat/run-config-adapter.ts';
import './compat/task-problem-matcher-adapter.ts';
import '../src/runner.js';
import './compat/project-tasks-adapter.ts';
import '../src/dap-client.js';
import './compat/dap-adapter.js';
import './compat/environment-activity-adapter.ts';
import './compat/cache-model-adapter.ts';
import './compat/cache-store-adapter.ts';
import './compat/cache-center-adapter.ts';
import './compat/environment-center-adapter.ts';
import '../src/package-center.js';
import './compat/views-adapter.ts';
import '../src/auth.js';
import './compat/projects-adapter.ts';
import './compat/collaboration-adapter.ts';
import './compat/account-profile-adapter.ts';

// AI modules.
import './compat/ai-settings-schema-adapter.ts';
import './compat/ai-prompts-adapter.ts';
import './compat/ai-service-adapter.ts';
import './compat/ai-context-adapter.ts';
import './ai-ui-loader.ts';
import './compat/ai-agent-button-adapter.ts';
import './compat/ai-inline-adapter.ts';

// Bootstrap must execute after every registration above.
import '../src/app.js';
