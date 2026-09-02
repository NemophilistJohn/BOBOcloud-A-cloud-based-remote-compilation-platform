import { createCloudFeaturePolicy } from '../../src/cloud-feature-policy';
import type {
  CloudFeaturePolicyService,
  ServerCapabilityState
} from '../../types/server-runtime';
import { rendererPlatform } from '../core/typed-platform';

export const CLOUD_FEATURE_POLICY_SERVICE_ID = 'workbench.cloudFeaturePolicy';

interface LegacyBobo {
  state?: ServerCapabilityState;
  cloudFeaturePolicy?: Readonly<CloudFeaturePolicyService>;
}

const legacyWindow = window as Window & { BOBO?: LegacyBobo };
const BOBO = legacyWindow.BOBO = legacyWindow.BOBO || {};
const cloudFeaturePolicy = createCloudFeaturePolicy({
  getSnapshot: () => BOBO.state?.serverCapabilities
});

rendererPlatform.lifecycle.add(rendererPlatform.services.register(
  CLOUD_FEATURE_POLICY_SERVICE_ID,
  cloudFeaturePolicy,
  { owner: 'core.serverRuntime', exposeToPlugins: false }
));

BOBO.cloudFeaturePolicy = cloudFeaturePolicy;
