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
import '../editor-rules/completion-engine.js';
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
import '../src/state.js';
import '../src/tab-order.js';
import './compat/i18n-adapter.ts';
import './compat/diagnostics-settings-adapter.ts';
import '../src/workspace-launch.js';
import '../src/icons.js';
import './compat/confirm-dialog-adapter.ts';
import '../src/toast.js';
import './compat/command-palette-adapter.ts';
import './core/plugin-extension-bootstrap.ts';
import '../src/workbench-layout.js';
import './compat/source-control-view-adapter.ts';
import '../src/file-search.js';
import '../src/settings.js';
import './compat/plugin-manager-ui-adapter.ts';
import './compat/language-packs-panel-adapter.ts';
import './compat/utils-adapter.ts';
import './compat/server-transport-adapter.ts';
import '../src/server-comm.js';
import '../src/run-output.js';
import './compat/server-capabilities-adapter.ts';
import './compat/cloud-feature-policy-adapter.ts';
import '../src/lsp-client.js';
import '../src/output-panel.js';
import '../src/terminal.js';
import '../src/runtime.js';
import './compat/file-icons-adapter.ts';
import '../src/workspace-sync-status.js';
import '../src/workspace-settings.js';
import '../src/editor-core.js';
import './compat/document-views-adapter.ts';
import '../src/workspace.js';
import '../src/agent-workbench.js';
import './compat/plugin-details-adapter.ts';
import './compat/rclone-client-adapter.ts';
import './compat/rclone-settings-adapter.ts';
import '../src/run-config.js';
import '../src/task-problem-matcher.js';
import '../src/runner.js';
import './compat/project-tasks-adapter.ts';
import '../src/dap-client.js';
import './compat/dap-adapter.js';
import '../src/environment-activity.js';
import '../src/cache-model.js';
import '../src/cache-store.js';
import '../src/cache-center.js';
import '../src/environment-center.js';
import '../src/package-center.js';
import '../src/views.js';
import '../src/auth.js';
import '../src/projects.js';
import '../src/collaboration.js';
import '../src/account-profile.js';

// AI modules.
import '../src/ai-settings-schema.js';
import '../src/ai-prompts.js';
import '../src/ai-service.js';
import '../src/ai-context.js';
import './ai-ui-loader.js';
import '../src/ai-agent-button.js';
import '../src/ai-inline.js';

// Bootstrap must execute after every registration above.
import '../src/app.js';
