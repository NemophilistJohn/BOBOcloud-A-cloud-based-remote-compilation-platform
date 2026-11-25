import { createWelcome, WELCOME_SERVICE_ID } from '../../src/welcome';
import { rendererPlatform } from '../core/bootstrap';
import { ENROLLMENT_HOST_SERVICE_ID } from '../core/native-host-adapter';
import type { I18nService } from '../../types/i18n';
import type { EnrollmentHostPort } from '../../types/enrollment';
declare module '../../types/renderer-platform' {
  interface RendererServiceMap { readonly 'workbench.welcome': ReturnType<typeof createWelcome>; }
}

// Host-only compatibility projection. Plugins receive no enrollment bridge.
type HostWindow = Window & { BOBO: {
  i18n: I18nService; state: { serverSettings: Record<string, unknown> };
  auth: { openEnrollment(kind: string, id: string): void };
  workspace: { canLeaveWorkspace(options: Record<string, unknown>): Promise<boolean>; closeWorkspace(options: Record<string, unknown>): Promise<unknown> };
  welcome?: ReturnType<typeof createWelcome>;
  enrollmentHost?: Readonly<Pick<EnrollmentHostPort, 'enrollmentAuthenticate' | 'enrollmentLogin' | 'enrollmentRefreshSync' | 'readServerSettings'>>;
} };
const host = window as unknown as HostWindow;
const enrollmentHost = rendererPlatform.services.require(ENROLLMENT_HOST_SERVICE_ID);
host.BOBO.enrollmentHost = Object.freeze({
  enrollmentAuthenticate: enrollmentHost.enrollmentAuthenticate,
  enrollmentLogin: enrollmentHost.enrollmentLogin,
  enrollmentRefreshSync: enrollmentHost.enrollmentRefreshSync,
  readServerSettings: enrollmentHost.readServerSettings
});
const service = createWelcome({ document, host: enrollmentHost, t: (key, params) => host.BOBO.i18n.t(key, params), locale: () => host.BOBO.i18n.getActive(),
  setLocale: id => host.BOBO.i18n.setLocale(id),
  beforeServerChange: async () => {
    if (!await host.BOBO.workspace.canLeaveWorkspace({ reason: 'server-change' })) return false;
    await host.BOBO.workspace.closeWorkspace({ approved: true, reason: 'server-change' }); return true;
  },
  applySettings: value => { host.BOBO.state.serverSettings = value; },
  authenticate: (kind,id) => host.BOBO.auth.openEnrollment(kind,id),
  completeLocal: async () => {
    const settings = Object.assign({},host.BOBO.state.serverSettings,{setupCompleted:true,firstRunRequired:false});
    await enrollmentHost.writeServerSettings(settings); await enrollmentHost.commitServerSettings(); host.BOBO.state.serverSettings=settings;
  }
});
rendererPlatform.lifecycle.add(rendererPlatform.services.register(WELCOME_SERVICE_ID,service,{owner:'core.welcome',exposeToPlugins:false}));
rendererPlatform.lifecycle.add({ dispose: host.BOBO.i18n.onChange(() => service.render()) });
window.addEventListener('bobo:workspace-changed', () => service.close());
host.BOBO.welcome = service;
