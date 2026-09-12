// Lazy AI presentation bundle. Core AI transport and inline completion stay in
// the startup bundle; these DOM-heavy modules load on the first visible AI UI.
import './compat/ai-settings-center-adapter.ts';
import './temml-runtime.js';
import './compat/ai-markdown-adapter.ts';
import './compat/stream-render-scheduler-adapter.ts';
import '../src/ai-chat-panel.js';
