'use strict';

const SPECIAL_UI_GROUPS = Object.freeze({
  packages: Object.freeze([
    'package-center-ui.spec.js'
  ]),
  'plugin-compat': Object.freeze([
    'document-preview-plugin-ui.spec.js',
    'official-ai-agent-plugin-ui.spec.js',
    'official-local-scm-plugin-ui.spec.js'
  ]),
  packaged: Object.freeze([
    'onboarding-packaged-ui.spec.js'
  ])
});

const SPECIAL_UI_SPECS = Object.freeze(Object.values(SPECIAL_UI_GROUPS).flat());
const UI_GROUPS = Object.freeze(['core', ...Object.keys(SPECIAL_UI_GROUPS)]);

function groupForSpec(fileName) {
  const matches = Object.entries(SPECIAL_UI_GROUPS)
    .filter(([, files]) => files.includes(fileName))
    .map(([group]) => group);
  if (matches.length > 1) throw new Error(fileName + ' belongs to multiple UI groups: ' + matches.join(', '));
  return matches[0] || 'core';
}

function selectionForGroup(group) {
  if (!UI_GROUPS.includes(group)) throw new Error('Unknown BOBOCLOUD UI test group: ' + group);
  if (group === 'core') {
    return {
      testMatch: '**/*.spec.js',
      testIgnore: SPECIAL_UI_SPECS.map((fileName) => '**/' + fileName)
    };
  }
  return {
    testMatch: SPECIAL_UI_GROUPS[group].map((fileName) => '**/' + fileName),
    testIgnore: []
  };
}

module.exports = {
  SPECIAL_UI_GROUPS,
  SPECIAL_UI_SPECS,
  UI_GROUPS,
  groupForSpec,
  selectionForGroup
};
