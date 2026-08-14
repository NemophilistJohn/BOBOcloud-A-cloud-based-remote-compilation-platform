// Lazy AI presentation bundle. Core AI transport and inline completion stay in
// the startup bundle; these DOM-heavy modules load on the first visible AI UI.
import '../src/ai-settings-center.js';
import './temml-runtime.js';
import '../src/ai-markdown.js';
import '../src/stream-render-scheduler.js';
import '../src/ai-chat-panel.js';
