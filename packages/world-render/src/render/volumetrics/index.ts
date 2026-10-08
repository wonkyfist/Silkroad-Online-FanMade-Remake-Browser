/** Volumetric lighting (wave 12): the sun shafts. Lane GODRAYS. */
export {
  GLOW_MAX_M,
  LightShafts,
  pickGlowLights,
  SHAFT_SETTINGS,
  SHAFT_TUNING,
  SHAFT_TUNING_V1,
  hazeTint,
  planShafts,
  shaftLook,
  shaftMarches,
  shaftRadial,
  shaftsState,
} from './shafts.ts'
export type { GlowLight, LightShaftsOptions, ShaftLook, ShaftLookInput, ShaftMode, ShaftPlan, ShaftPlanOptions, ShaftSettings, ShaftShadowSource, ShaftTuning } from './shafts.ts'
export {
  SHAFT_COMPOSITE_SHADER,
  SHAFT_GLOW_LIGHTS,
  SHAFT_MARCH_SHADER,
  SHAFT_MAX_CASCADES,
  SHAFT_RESOLVE_SHADER,
  SHAFT_MARCH_DEFINE,
  SHAFT_RADIAL_DEFINE,
  SHAFT_SHADERS,
} from './shaft-shaders.ts'
export type { ShaftShaderSource } from './shaft-shaders.ts'
