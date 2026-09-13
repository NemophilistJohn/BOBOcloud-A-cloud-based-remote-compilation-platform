import { rendererPlatform } from '../core/bootstrap';
import type { EditorRuleRegistryPort } from '../../types/editor-rules';

export const EDITOR_RULES_SERVICE_ID = 'workbench.editorRules' as const;

type EditorRulesWindow = Window & {
  editorRuleRegistry?: EditorRuleRegistryPort;
};

const legacyWindow = window as EditorRulesWindow;
const editorRules = legacyWindow.editorRuleRegistry;
if (!editorRules) {
  throw new Error('Editor rules registry must be loaded before its service adapter.');
}

// Keep the historical global projection for the editor/diagnostics bridges,
// while making the registry available through the typed private service map.
rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  EDITOR_RULES_SERVICE_ID,
  editorRules,
  {
    owner: 'core.editor-rules',
    exposeToPlugins: false,
    dispose: (registry) => registry.dispose()
  }
));
