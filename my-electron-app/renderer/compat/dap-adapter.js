import { rendererPlatform } from '../core/bootstrap.js';

const BOBO = window.BOBO = window.BOBO || {};
const service = BOBO.dap;
const t = value => BOBO.i18n && BOBO.i18n.t ? BOBO.i18n.t(value) : value;

if (service) {
  const pluginView = Object.freeze({
    getState: () => Object.freeze({ ...service.getState() }),
    getConfigurations: () => Object.freeze(service.getConfigurations().map((item) => Object.freeze({
      id: item.id,
      name: item.name,
      type: item.type,
      request: item.request,
      executable: item.executable === true
    }))),
    getBreakpoints: () => Object.freeze(service.getBreakpoints().map((entry) => Object.freeze({
      path: entry.path,
      breakpoints: Object.freeze(entry.breakpoints.map((breakpoint) => Object.freeze({ ...breakpoint })))
    })))
  });

  rendererPlatform.lifecycle.add(rendererPlatform.services.register('debug', service, {
    owner: 'core.debug',
    exposeToPlugins: true,
    pluginView,
    dispose: () => service.dispose()
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.start', () => service.start(), {
    owner: 'core.debug', title: t('Start Debugging'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.continue', () => service.execute('continue'), {
    owner: 'core.debug', title: t('Continue'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.pause', () => service.execute('pause'), {
    owner: 'core.debug', title: t('Pause'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.stepOver', () => service.execute('next'), {
    owner: 'core.debug', title: t('Step Over'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.stepInto', () => service.execute('stepIn'), {
    owner: 'core.debug', title: t('Step Into'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.stepOut', () => service.execute('stepOut'), {
    owner: 'core.debug', title: t('Step Out'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.restart', () => service.execute('restart'), {
    owner: 'core.debug', title: t('Restart Debugging'), category: t('Debug')
  }));
  rendererPlatform.lifecycle.add(rendererPlatform.commands.register('debug.stop', () => service.stop('command'), {
    owner: 'core.debug', title: t('Stop Debugging'), category: t('Debug')
  }));
}
