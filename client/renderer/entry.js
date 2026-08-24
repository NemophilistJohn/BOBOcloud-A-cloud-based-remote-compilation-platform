// Renderer composition root.
//
// These side-effect imports preserve the legacy BOBO/global registration order
// while giving the renderer a single, auditable build entry. Keep Monaco's AMD
// loader outside this bundle: src/app.js configures and invokes it at runtime.

// Theme and editor-rule foundations.
import './core/bootstrap.js';
import './compat/platform-adapter.js';
import '../theme-manager.js';
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
import '../src/i18n.js';
import '../src/workspace-launch.js';
import '../src/icons.js';
import '../src/confirm-dialog.js';
import '../src/toast.js';
import '../src/command-palette.js';
import './core/plugin-extension-bootstrap.js';
import '../src/workbench-layout.js';
import '../src/source-control-view.js';
import '../src/file-search.js';
import '../src/settings.js';
import '../src/plugin-manager-ui.js';
import '../src/language-packs-panel.js';
import '../src/utils.js';
import '../src/server-transport.js';
import '../src/server-comm.js';
import '../src/server-capabilities.js';
import '../src/cloud-feature-policy.js';
import '../src/lsp-client.js';
import '../src/output-panel.js';
import '../src/terminal.js';
import '../src/runtime.js';
import './compat/file-icons-adapter.js';
import '../src/workspace-sync-status.js';
import '../src/workspace-settings.js';
import '../src/editor-core.js';
import '../src/document-views.js';
import '../src/workspace.js';
import '../src/agent-workbench.js';
import '../src/plugin-details.js';
import '../src/rclone-client.js';
import '../src/run-config.js';
import '../src/task-problem-matcher.js';
import '../src/runner.js';
import '../src/project-tasks.js';
import './compat/project-tasks-adapter.js';
import '../src/dap-client.js';
import './compat/dap-adapter.js';
import '../src/environment-activity.js';
import '../src/cache-model.js';
import '../src/cache-store.js';
import '../src/cache-center.js';
import '../src/environment-center.js';
import '../src/package-center.js';
import '../src/views.js';
import '../src/diagnostics-settings.js';
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
