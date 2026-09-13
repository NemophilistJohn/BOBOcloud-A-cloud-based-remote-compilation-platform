// Lazy AI presentation bundle. Core AI transport and inline completion stay in
// the startup bundle; these DOM-heavy modules load on the first visible AI UI.
import './compat/ai-settings-center-adapter';
import './temml-runtime';
import './compat/ai-markdown-adapter';
import './compat/stream-render-scheduler-adapter';
import './compat/ai-chat-panel-adapter';

