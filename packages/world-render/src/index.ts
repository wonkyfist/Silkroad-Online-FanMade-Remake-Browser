/**
 * @sro/world-render: Babylon.js renderer for converted Silkroad world regions (terrain splatting, instanced objects,
 * water, sky, environment/fog, lightmaps, draw distance, minimap tiles) plus @sro/nav loading and ray picking.
 * Browser-side; shared by the game client and the world viewer. The high-level entry is loadWorld() (whole world, or
 * region streaming through world.stream, docs/FIELDS.md §3); the building blocks are exported for the viewer's debug
 * controls.
 */
export { loadWorld, resolveAssetBase, World, QUALITY_PRESETS } from './world.ts'
export type { LoadWorldOptions, QualitySettings, WorldLoadProgress, WorldLoadStage, WorldPick, WorldQuality } from './world.ts'
export { Assets, abortError, browserIO, decodeImage, errorText, isAbort, mapLimit, mimeOf } from './assets.ts'
export type { DecodedImage, WorldIO } from './assets.ts'
export { installMeshoptDecoder } from './meshopt.ts'
export { WorldRegions } from './regions.ts'
export type { RegionData } from './regions.ts'
export { TERRAIN_MESH_TAG, TERRAIN_REGION_SLOTS, TerrainRenderer, isTerrainMesh, loadTerrainLightmap, missingTile, textureFromBytes } from './terrain.ts'
export type { TerrainParams, TerrainRegionGpu, TerrainRegionSlot, TerrainRegionUpdate, TerrainRegionUpdated } from './terrain.ts'
// W12-SB (S-TERR): the terrain's edit maths (the editor's commit step for regions streaming in re-uses them).
export { FULL_GRID_RECT, bakeNormalAt, blockLayersOf, clampGridRect, editHeights, relayer, renormalRing } from './terrain-edit.ts'
export type { GridRect, LayerPlanes, NeighbourHeights, RelayerResult } from './terrain-edit.ts'
export { WaterRenderer } from './water.ts'
export type { WaterParams } from './water.ts'
export { Sky } from './sky.ts'
export { ObjectMaterials } from './materials.ts'
export type {
  ConvertModelInfo,
  ConvertedMaterials,
  LightmapMode,
  MaterialDecorator,
  MaterialDecoratorInfo,
  MaterialPath,
  SidecarLite,
  SidecarMaterialLite,
} from './materials.ts'
export { GROUP_RANGE_M, WORLD_OBJECT_LAYER, WorldObjects, loadGlb, prepareStatic } from './objects.ts'
export { WORLD_GROUND_LAYER } from './layers.ts'
export { installEffectCacheFix } from './render/babylon-fixes.ts'
export { installGlErrorProbe, installLinkSettle, installVaryingBudgetCheck, settleProgram, wgslInterStageCount } from './render/gpu-guards.ts'
export type { GlErrorStats, InterStageCount } from './render/gpu-guards.ts'
export type { ObjectStats, PlacedModelInfo, RegionListener, StaticPrep } from './objects.ts'
export { MINIMAP_FILL, Minimap, OPEN_SEA_TONE, minimapFill } from './minimap.ts'
export type { MinimapMarker, MinimapTile, MinimapView } from './minimap.ts'
export { Limiter, RegionStreamer, STREAM_DEFAULTS, rectDistance, regionInfos } from './stream.ts'
export type { CachedModel, CommitStep, CommitStepAfter, RegionEvent, RegionInfo, RegionState, StreamHooks, StreamSettings, StreamStats } from './stream.ts'
export { RegionChunk } from './region-chunk.ts'
export {
  CHUNKS_PER_REGION,
  SCATTER_LEVELS,
  SCATTER_PRESETS,
  TILE_TYPE_DENSITY,
  WorldScatter,
  chunkSeed,
  scatterChunk,
  scatterSource,
  tileDensityTable,
  tileScatterDensity,
} from './scatter.ts'
export type { ScatterChunkData, ScatterHost, ScatterLevel, ScatterPreset, ScatterSource, ScatterStats } from './scatter.ts'
export { SCATTER_KINDS, loadScatterKinds, retailModelFor } from './scatter-assets.ts'
export type { ScatterKindAsset, ScatterKindDef, ScatterKindId } from './scatter-assets.ts'
export { ModelCache } from './model-cache.ts'
export type { ModelCacheOptions, ModelCacheStats } from './model-cache.ts'
export { TileAtlas } from './tile-atlas.ts'
export type { TileAtlasOptions } from './tile-atlas.ts'
export {
  FOG_RANGE_M,
  approachEnv,
  clamp01,
  evaluateProfile,
  formatTime,
  sampleColor,
  sampleFloat,
  saturate,
} from './environment.ts'
export type { ColorKey, EnvProfile, EnvValues, EnvironmentFile, FloatKey, RGB } from './environment.ts'
export { NavWalker, loadNav, loadNavStreamed, manifestNavFile, manifestSpawn, pickNav, spawnAt, surfaceLabel, terrainOnlyNavData } from './nav.ts'
export type { LoadedNav, LoadedStreamNav, NavChunkSource, NavPick, NavSource } from './nav.ts'
export { createEmptyTextureArray, createTextureArray, mipLevels, solidTexture, uploadTextureLayer } from './textures.ts'
export { NavTrack } from './track.ts'

// ---- wave 9 seams (docs/WAVE_PLAN3.md §4) ---------------------------------------------------------------------
export { ChunkSet, DefineSet, SharedUniforms, bindAllShared, bindShared } from './shader-chunks.ts'
export type { GrassPoint, ShaderChunk, ShaderLang, SharedValue, TerrainPoint, WaterPoint, WorldShaderChunks } from './shader-chunks.ts'
export { WORLD_SHADER_CHUNKS, terrainShaders, waterShaders } from './shaders.ts'
export type { ShaderSources } from './shaders.ts'
export { scatterShaders } from './scatter-assets.ts'
export {
  MATERIAL_CLASSES,
  MATERIAL_CLASS_PARAMS,
  SURFACE_CLASS_MATERIAL,
  TERRAIN_SURFACE,
  TERRAIN_SURFACE_COUNT,
  TERRAIN_SURFACE_PARAMS,
  classParams,
  classify,
  isFoliageModel,
  surfaceAlpha,
  surfaceFromAlpha,
  terrainSurfaceClass,
} from './pbr/classes.ts'
export type { ClassifyHints, MaterialClass, MaterialClassParams, TerrainSurfaceClass } from './pbr/classes.ts'
// RND-M (docs/WAVE_PLAN3.md §6.10): class overrides, the map loader, the surface plugin.
export { MATERIAL_OVERRIDES_FORMAT, isMaterialClass, overrideKey, parseClassOverrides, resolveClass } from './pbr/classes.ts'
export type { ClassOverrides } from './pbr/classes.ts'
export {
  ActorMaps,
  MapDecoder,
  PBR_INDEX_PATH,
  PbrMapIndex,
  PbrTextureCache,
  TEXTURE_SETTINGS,
  frameScheduler,
  isTextureSetting,
  ktx2MapsAvailable,
  pageRemasterSets,
  pageTextureSetting,
  policyForTier,
  setPageRemasterSets,
  setPageTextureSetting,
  sharedMapDecoder,
  textureTierFor,
  REMASTER_FORMAT,
  REMASTER_MANIFEST,
  applyMapRecord,
  keyOf,
  loadPbrMapIndex,
  mapPolicy,
  normalInvert,
  packNormalPlanes,
  packOrmhPlanes,
  parsePbrIndex,
  parseRemasterManifest,
  pickSize,
  pickTier,
  releaseMaps,
  resampleNearest,
  sizedUrl,
  urlMapSource,
} from './pbr/maps.ts'
export type {
  ActorSidecar,
  AppliedMaps,
  MapFetcher,
  MapScheduler,
  TextureSetting,
  TextureTier,
  MapKind,
  MapPolicy,
  MapQuery,
  MapTextureSource,
  MapTier,
  NormalGreen,
  NormalSource,
  OrmSource,
  PbrIndexLoaded,
  PbrMapRecord,
  RemasterAlpha,
  RemasterExtraMap,
  RemasterManifest,
  RemasterMaps,
  Rgba,
} from './pbr/maps.ts'
export {
  LAMP_EMISSIVE,
  OBJECT_LIGHTMAP,
  PbrSurfaces,
  SKIN_IOR,
  SRO_SURFACE_PLUGIN,
  SURFACE_SAMPLERS,
  SURFACE_UNIFORMS,
  SroSurfacePlugin,
  SurfaceShared,
  applyClassExtras,
  bakedWeight,
  classifyActor,
  materialTier,
  surfaceFragmentCode,
  surfacePluginOf,
} from './pbr/surface-plugin.ts'
export type { MaterialTier, PbrSurfacesOptions, SurfaceOptions, SurfaceWeatherSource } from './pbr/surface-plugin.ts'
export type { ObjectMaterial } from './materials.ts'
export { WorldRender } from './render/index.ts'
export type { RenderHost, RenderPart, WorldRenderOptions } from './render/index.ts'
export {
  CALIBRATION_TARGET,
  CELESTIAL_LIGHT_NAME,
  CELESTIAL_RENDER_PRIORITY,
  FLASH_FULL_EXPOSURE,
  LIGHT_CALIBRATIONS,
  SkyEnvironment,
  WORLD_SKY_CUBE_DECODE,
  WorldLighting,
  calibrateLight,
  flashExposureScale,
  lightBalance,
  skyStateSH,
} from './render/lighting.ts'
export type { LightBalance, LightCalibration, LightRegime, SkyCubeDecode, SkyEnvironmentOptions, SkyRadianceSource, WorldLightingOptions } from './render/lighting.ts'
export { CHARACTER_CASTER_M, SHADOW_PROXY_LAYER, ShadowProxies, WorldShadows, csmSettings, selectCasters } from './render/shadows.ts'
export { EnabledMeshCandidates } from './render/active-meshes.ts'
export { CHARACTER_BLOB_CAP, CharacterBlobs } from './render/character-blobs.ts'
export type { CsmSettings, ShadowHost, ShadowProxy } from './render/shadows.ts'
export { BLOOM_LEVELS, BLOOM_LOOKS, BLOOM_WEIGHT, LIGHT_SHAFT_LEVELS, RENDER_PRESETS, lightShaftLevel, withBloom, withLightShafts } from './render/quality.ts'
export type { AntiAliasing, BloomLevel, IblQuality, LightShaftLevel, NightLightQuality, RenderPath, RenderPreset, RenderQuality, ShadowQuality, ToneMap } from './render/quality.ts'
// Wave 12 (GODRAYS): the sun shafts.
export { LightShafts, SHAFT_SETTINGS, SHAFT_TUNING, planShafts, shaftLook, shaftsState } from './render/volumetrics/index.ts'
export type { ShaftLook, ShaftLookInput, ShaftMode, ShaftPlan } from './render/volumetrics/index.ts'
export { CLEAR_RENDER_WEATHER } from './render/weather.ts'
export type { RenderWeather } from './render/weather.ts'
export { GPU_REPORTED_FEATURES, WEBGPU_DEFAULT_LIMITS, gpuInfoFromEngine } from './render/gpu.ts'
export type { GpuInfo } from './render/gpu.ts'
export { AMBIENT_BOOST, MOON_KEY, SKY_EXPOSURE_REF, SKY_LDR_PER_LUT, STAR_KEY, SkySystem } from './sky/sky-system.ts'
export type { SkyAttachOptions, SkyGroundTarget, SkyRetailInput, SkySystemOptions } from './sky/sky-system.ts'
export { BAKED_LIGHT_DIR, CLEAR_SKY_WEATHER, SKY_PRESETS, lutRowsPerFrame } from './sky/types.ts'
export type { SkyPreset, SkyQuality, SkyState, SkyStyle, SkyWeather } from './sky/types.ts'
export {
  SKY_CHUNKS,
  SKY_CHUNK_UNIFORMS,
  SKY_CLOUD_SHADOW_GLSL,
  SKY_CLOUD_SHADOW_SAMPLERS,
  SKY_CLOUD_SHADOW_UBO,
  SKY_CLOUD_SHADOW_UNIFORMS_GLSL,
  SKY_CLOUD_SHADOW_WGSL,
} from './sky/chunks.ts'
export { NOON_AMBIENT_LUMINANCE, NOON_KEY_LUMINANCE, applySkyToLights } from './sky/lights.ts'
export type { SkyLightOptions, SkyLightTargets } from './sky/lights.ts'
export { cubeDir, fillHorizonRing, fillSkyCube, shIrradiance, skySH } from './sky/ibl.ts'
export type { SkyRadiance } from './sky/ibl.ts'
export { ClassicSky } from './sky/classic-sky.ts'
export { WorldWeather, isWeatherMesh } from './weather/index.ts'
export { addWarmupHook, runWarmupHooks, warmupHooksState, type WarmupHook, type WarmupHooksState } from './warmup-hooks.ts'
export type { ShelterMap, WeatherHost, WeatherStats, WeatherUniforms } from './weather/index.ts'
export { CLEAR_FRAME } from './weather/frame.ts'
export type { WeatherFrame } from './weather/frame.ts'
export { toRenderWeather, toSkyWeather } from './weather/adapters.ts'
export { WEATHER_LEVELS, WEATHER_PRESETS } from './weather/presets.ts'
export type { WeatherLevel, WeatherPreset } from './weather/presets.ts'
export { applyWeatherToEnv, envWeatherTerms, terrainWeatherLight, weatherFogScale } from './weather/env.ts'
export {
  WEATHER_CHUNKS,
  WX_DEFINES,
  WX_SHELTER_GLSL,
  WX_SHELTER_SAMPLER,
  WX_SHELTER_UNIFORMS,
  WX_SHELTER_WGSL,
  WX_SWAY_GLSL,
  WX_SWAY_UNIFORMS,
  WX_SWAY_WGSL,
} from './weather/chunks.ts'
export { RENDER_WET_PLUGINS, WETNESS_PLUGIN, WetnessPlugin, attachWetness, hasRenderWetPlugin, wetParamsFor } from './weather/wet-plugin.ts'
export type { AttachWetnessOptions, WetParams, WetSurfaceKind } from './weather/wet-plugin.ts'
export { SHELTER_RESOLUTION, SHELTER_SIZE_M, WeatherShelter } from './weather/shelter.ts'
export { WeatherRain, rainDropPosition, rainMotion } from './weather/rain.ts'
export { createRippleTexture, ripplePixels } from './weather/ripples.ts'
export { WET_MAP_SIZE, buildWetMap, surfaceLookup, wetMapCoverage } from './weather/wetmap.ts'
export {
  NIGHT_CHUNKS,
  NIGHT_GRASS_DEFINE,
  NIGHT_GRASS_SAMPLER,
  NIGHT_GRASS_UNIFORM,
  NIGHT_SPLAT_GLSL,
  NIGHT_SPLAT_MAX,
  NIGHT_SPLAT_SAMPLER,
  NIGHT_SPLAT_WGSL,
  NIGHT_TERRAIN_DEFINE,
  NIGHT_UNIFORM,
} from './night-chunks.ts'
export {
  NIGHT_LIGHT_KINDS,
  NIGHT_POINT_OWNER,
  NightLights,
  NightPointLights,
  ambientNightSwitch,
  attachNightLights,
  bakeSplat,
  nightKindOf,
  placeLights,
  pointLight,
  readAmbientPoints,
  splatWindow,
} from './night-lights.ts'
export type { NightLight, NightLightKind, NightLightPoint, NightLightsHost, NightLightsOptions, NightLightsStats, SplatRegion } from './night-lights.ts'
export {
  GRASS_CSM_DEFINE,
  GRASS_HDR_DEFINE,
  GRASS_RENDER_UNIFORMS,
  GRASS_SHADOW_SAMPLER,
  RENDER_GRASS_CHUNKS,
  RenderGrass,
  grassHdr,
  grassSH,
  wrappedNdotL,
} from './render/grass-chunks.ts'
export type { GrassRenderSource, GrassTarget } from './render/grass-chunks.ts'
export {
  FOLIAGE_BEND,
  FoliageShared,
  PbrFoliage,
  SRO_FOLIAGE_PLUGIN,
  SroFoliagePlugin,
  foliageBend,
  foliageCode,
  foliagePluginOf,
  foliageTranslucency,
} from './pbr/foliage-plugin.ts'
export type { FoliageOptions, PbrFoliageOptions } from './pbr/foliage-plugin.ts'
export {
  SRO_WATER_PLUGIN,
  SroWaterPlugin,
  WaterPbrState,
  createPbrWater,
  encodeWaterDepth,
  shoreAlpha,
  waterFragmentCode,
  waterHue,
  waveAmplitude,
} from './pbr/water-plugin.ts'
export type { WaterRenderSource } from './water.ts'
// Wave 9A gate 1: RND-P's post stack, grade and height fog, RND-T's PBR terrain plugin.
export {
  MIN_PREPASS_VARYINGS,
  POST_STAGE_ORDER,
  RenderPost,
  SSR_PUDDLES_OFF,
  SSR_PUDDLES_ON,
  installRenderPost,
  planPost,
  toneMappingType,
} from './render/post.ts'
export type { PlanOptions, PostPlan, PostStage, RenderPostOptions } from './render/post.ts'
// W9 LOOK: the exposure-aware highlight overlay (hover / target) for the game's entity meshes.
export { HIGHLIGHT_ALPHA, HIGHLIGHT_COLOR, highlightOverlayColor, highlightOverlayCount, sceneExposure, setHighlightOverlay } from './render/post.ts'
export { GradeMixer, LUT_KEYS, builtinLutStrip, gradeWeights, loadLutStrips } from './render/grade.ts'
export type { GradeInput, GradeParams, LutKey } from './render/grade.ts'
export { FOG_PLUGIN_NAME, HeightFog, SroFogPlugin, attachFogPlugin, fogRingU, heightFogAmount, heightFogOf } from './pbr/fog-plugin.ts'
export {
  SRO_TERRAIN_PLUGIN,
  SroTerrainPlugin,
  TERRAIN_FEATURE_DEFINES,
  TerrainPbr,
  resolveTerrainFeatures,
  terrainPluginCode,
} from './pbr/terrain-plugin.ts'
export type { TerrainFeatureInput, TerrainFeatures, TerrainPbrRegion } from './pbr/terrain-plugin.ts'

// ---- wave 10 seams (docs/WAVE_PLAN6.md §4.1, W10-S) ------------------------------------------------------------
// Batching (BATCHING BT-0): the region claim and listener contract, the geometry export, the batch records.
export { UNBATCHED_TAGS, isBatchableMesh, worldTagOf } from './batch/types.ts'
export type {
  BatchClass,
  BatchCommitContext,
  BatchFactory,
  BatchHost,
  BatchModelSource,
  BatchPart,
  BatchRegion,
  BatchSlot,
  BatchWorkerFactory,
  BatchWorkerLike,
  RegionBatch,
  RegionBatcher,
} from './batch/types.ts'
export { createBatchPart } from './batch/index.ts'
export { LAMP_MATERIAL, LAMP_MODEL, batchClass, isLampModel, lampRule } from './materials.ts'
export type { MaterialBatchRecord } from './materials.ts'
export { extractModelGeometry, geometryOf } from './model-cache.ts'
export type { ModelGeometry, PrimitiveGeometry } from './model-cache.ts'
export type { ShadowCasterSource } from './render/shadows.ts'
export type { WorldParts } from './world.ts'
// Grass and life (GRASS_LIFE GL-0): the style switch, `adopt`, the tuft filter, the life slot.
export { DEFAULT_GROUND_COVER, SCATTER_STYLES } from './scatter.ts'
export type { GroundCover, GroundCoverFactory, ScatterOptions, ScatterStyle } from './scatter.ts'
export { GRASS_TINT_DEFINE, LIFE_TAG, RETAIL_TUFT_MODELS, SCATTER_TAG, isRetailTuftModel, modelStem } from './grass/types.ts'
export type { LifeConfig, LifeFactory, LifeFlush, LifeHabitat, LifeHost, LifeKind, LifePart, LifeSpecies, LifeThreat, LifeThreats } from './life/types.ts'
export { createLifePart } from './life/index.ts'
// GRASS_LIFE GL-S / GL-F: the grass field, its shaders, and the wildlife's shaders and meshes (GL-L builds the part).
export {
  GrassField,
  GRASS_LEVELS,
  GrassWindow,
  bladesPerM2,
  buildPatch,
  createGrassField,
  grassFieldOf,
  grassTileTable,
  regionGrassMask,
  tileGrassWeight,
} from './grass/index.ts'
export type { GrassFieldAccess, GrassFieldOptions, GrassFieldStats, GrassLevel, GrassRect } from './grass/index.ts'
export {
  GRASS_ATTRIBUTES,
  GRASS_FIELD_SAMPLER,
  GRASS_HEIGHT_SAMPLER,
  GRASS_SHADER,
  grassShaders,
  grassSkeleton,
  registerSkeletonShader,
} from './grass/shaders.ts'
export type { GrassSkeletonParts } from './grass/shaders.ts'
export {
  BUTTERFLY_SCALE,
  CRITTER_SPECIES,
  DRAGONFLY_FIRST_SPECIES,
  DRAGONFLY_SCALE,
  birdGeometry,
  birdShaders,
  createLifeMaterial,
  critterFlight,
  critterGeometry,
  critterShaders,
  fireflyGeometry,
  fireflyShaders,
  packRgb,
} from './life/shaders.ts'
export type { LifeGeometry, LifeShaderKind } from './life/shaders.ts'
// Coast (COAST I-CST hooks): the chunk entries, the ocean slot, the coast field, the ocean rows.
export { COAST_CHUNKS, COAST_WET_DEFINE, COAST_WET_GLSL, COAST_WET_WGSL } from './coast/chunks.ts'
export { GRASS_TINT_CHUNKS, GRASS_TINT_GLSL, GRASS_TINT_WGSL } from './grass/chunks.ts'
export type { CoastAccess, OceanFactory, OceanHost, OceanPart } from './coast/types.ts'
export { createOceanPart } from './ocean/index.ts'
// CST-O: the ocean part's wave query (CST-A's ships), its stats (the viewer and the bench), the shore seam (CST-S).
export { SroOcean, oceanWaveQuery, type OceanOptions, type OceanStats, type OceanWaveQuery } from './ocean/index.ts'
export type { ShoreBinder, ShoreCode, ShoreFactory, ShoreFrame, ShoreHost, ShorePart, ShoreStage } from './ocean/shore-seam.ts'
export type { OceanQuality } from './render/quality.ts'

// ---- wave 11 seams (docs/WAVE_PLAN7.md §4.3, W11-S) ------------------------------------------------------------
// Town life (TOWN_LIFE §2.3): World.town (TL-C's part; null on Classic), the 'town' tag the batcher refuses.
export { TOWN_TAG, isTownMesh, townCountScale } from './town/types.ts'
export type { TownCircle, TownClock, TownConfig, TownFactory, TownHost, TownLifeLevel, TownPart, TownThreats } from './town/types.ts'
export { StubTown, createTownPart } from './town/index.ts'
// H11 S2 (apps/game town sound on Low): the pure schedule, for the bed's count where no town part draws folk.
export { TownSchedule } from './town/schedule.ts'
// Cloth (TOWN_LIFE §5.1, F1): the converter's cloth record, the `+sheen` groups' per-piece pivot, the SRO_CLOTH_WIND slot.
export { CLOTH_KINDS, clothKindCode, clothOf } from './materials.ts'
export type { ClothKind, ClothRecord } from './materials.ts'
// Wave 12 (UV scroll): the retail texture scroll plugin (uv-scroll.ts).
export { SRO_UV_SCROLL_PLUGIN, SroUvScrollPlugin, UV_SCROLL_DEFINE, UV_SCROLL_MAX, UV_SCROLL_UNIFORM, UvScrollShared, uvScrollOf, uvScrollPhase, uvScrollPluginOf, uvScrollVertexCode } from './uv-scroll.ts'
export type { UvScroll } from './uv-scroll.ts'
export { CLOTH_MIN_HEIGHT_M, CLOTH_PIVOT_SIZE, clothPivots } from './batch/region-batch.ts'
export { CLOTH_PIVOT_FLOATS, clothFoliageCode, hasClothPivot } from './pbr/foliage-plugin.ts'
// The post's temporal fallback (D4) and the water's ripple points and profiles (D5).
export { renderPostOf } from './render/post.ts'
export type { TemporalOverride } from './render/post.ts'
export {
  RIPPLE_POINTS_MAX,
  RIPPLE_PERIOD_S,
  SRO_WATER_TOWN_PLUGIN,
  SroWaterTownPlugin,
  WATER_PROFILES,
  WaterTownState,
  rippleTilt,
  waterTownFragmentCode,
  waterTownPluginOf,
} from './pbr/water-town-plugin.ts'
export type { RipplePoint, WaterProfile, WaterProfileId } from './pbr/water-town-plugin.ts'

// ---- wave 12 seams (docs/WAVE_PLAN8.md §4.2, W12-SA: the object side) ------------------------------------------
// TREES Part W: World.trees (T12-N's part; null on Classic), the tree mode, the batch's swap source.
export { StubTrees, createTreesPart } from './trees/index.ts'
export { TREES_MODES, placementKey, placementOfKey } from './trees/types.ts'
export type { TreeLibraryEntry, TreesFactory, TreesHost, TreesMode, TreesPart } from './trees/types.ts'
export { treeSwapSourceOf } from './batch/types.ts'
export type { TreeSwap, TreeSwapSource } from './batch/types.ts'
// The foliage define skeletons (D8; T12-W's chunks).
export { FOLIAGE_TREEW_KIND, TREE_FOLIAGE_DEFINES, TREE_PIVOT_FLOATS, hasTreePivot4, treeFoliageCode } from './pbr/foliage-plugin.ts'
// WORLD_EDITOR S-SCALE, S-OBJ, S-FILTER: the placement scale, the editor-owned placements, the region filter.
export { placementScale } from './placement-scale.ts'
export type { EditorOwned } from './objects.ts'
export type { RegionFilter } from './world.ts'
