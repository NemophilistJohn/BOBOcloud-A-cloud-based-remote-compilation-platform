'use strict';

const path = require('node:path');
const test = require('node:test');
const { assertTypeScriptContract } = require('./support/typescript-contract');

const ROOT = path.resolve(__dirname, '..');

test('Agent workbench keeps its six-key facade, typed host port, and private disposable service contract', () => {
  const source = [
    "import { createAgentWorkbenchService, AGENT_WORKBENCH_SERVICE_ID } from '../src/agent-workbench';",
    "import type { Disposable } from '../types/lifecycle';",
    "import type { RendererPlatform, RendererPluginServiceMap, RendererServiceMap, AgentWorkbenchAccessIdentityDto, AgentWorkbenchApprovalDecisionRequestDto, AgentWorkbenchDependencies, AgentWorkbenchFacade, AgentWorkbenchHostPort, AgentWorkbenchService } from '../types/renderer-platform';",
    'type Equal<Left, Right> =',
    '  (<Value>() => Value extends Left ? 1 : 2) extends',
    '  (<Value>() => Value extends Right ? 1 : 2) ?',
    '    ((<Value>() => Value extends Right ? 1 : 2) extends',
    '      (<Value>() => Value extends Left ? 1 : 2) ? true : false)',
    '    : false;',
    'type AssertTrue<Value extends true> = Value;',
    'type AssertFalse<Value extends false> = Value;',
    'type IsAny<Value> = 0 extends (1 & Value) ? true : false;',
    "type FacadeKeys = 'init' | 'dispose' | 'open' | 'openConfiguration' | 'refresh' | 'refreshModels';",
    "type ServiceIsExact = AssertTrue<Equal<keyof AgentWorkbenchService, FacadeKeys | 'disposed'>>;",
    "type FacadeIsExact = AssertTrue<Equal<keyof AgentWorkbenchFacade, FacadeKeys>>;",
    'type ServiceIsDisposable = AssertTrue<AgentWorkbenchService extends Disposable ? true : false>;',
    "type ServiceMapIsExact = AssertTrue<Equal<RendererServiceMap['workbench.agentWorkbench'], AgentWorkbenchService>>;",
    "type HostMapIsExact = AssertTrue<Equal<RendererServiceMap['host.agentWorkbench'], Readonly<AgentWorkbenchHostPort>>>;",
    "type PluginServiceAbsent = AssertFalse<'workbench.agentWorkbench' extends keyof RendererPluginServiceMap ? true : false>;",
    "type HostPluginAbsent = AssertFalse<'host.agentWorkbench' extends keyof RendererPluginServiceMap ? true : false>;",
    "type DependencyKeys = 'document' | 'eventTarget' | 'state' | 'getI18n' | 'getAgents' | 'getCommands' | 'getConfirm' | 'getAiSettingsCenter' | 'getWorkspace' | 'getWorkbench' | 'getViews' | 'getDocumentViews' | 'host' | 'navigator' | 'setTimer' | 'clearTimer' | 'requestAnimationFrame' | 'logger';",
    'type DependenciesAreExact = AssertTrue<Equal<keyof AgentWorkbenchDependencies, DependencyKeys>>;',
    'type HostIsNotAny = AssertFalse<IsAny<AgentWorkbenchHostPort>>;',
    'type FactoryReturnIsTyped = AssertFalse<IsAny<ReturnType<typeof createAgentWorkbenchService>>>;',
    "const serviceId: 'workbench.agentWorkbench' = AGENT_WORKBENCH_SERVICE_ID;",
    'declare const dependencies: AgentWorkbenchDependencies;',
    'declare const identity: AgentWorkbenchAccessIdentityDto;',
    'declare const decision: AgentWorkbenchApprovalDecisionRequestDto;',
    'const service: AgentWorkbenchService = createAgentWorkbenchService(dependencies);',
    'const facade: AgentWorkbenchFacade = service;',
    'const host: Readonly<AgentWorkbenchHostPort> = (null as unknown as RendererPlatform).services.require(\'host.agentWorkbench\');',
    'void host.getAccessMode(identity); void host.decideApproval(decision);',
    'service.init(); service.open("acme.agent.main"); void service.openConfiguration(); service.refresh(); void service.refreshModels(); service.dispose();',
    'void serviceId; void facade;',
    '// @ts-expect-error Agent workbench exposes a closed compatibility surface.',
    'service.renderSidebar();',
    '// @ts-expect-error Agent workbench is intentionally absent from downloaded plugins.',
    "(null as unknown as RendererPlatform).services.getForPlugin('workbench.agentWorkbench');",
    '// @ts-expect-error Agent workbench host authority is private to the trusted renderer.',
    "(null as unknown as RendererPlatform).services.getForPlugin('host.agentWorkbench');"
  ].join('\n');

  assertTypeScriptContract({
    root: ROOT,
    fileName: '__agent-workbench-types-contract.ts',
    source
  });
});
