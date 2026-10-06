/**
 * The winter lane of the Classic shader chunks (docs/WINTER.md §7.2; shader-chunks.ts, shaders.ts WORLD_SHADER_CHUNKS,
 * last in the order): snow on the Classic terrain splat (Low: the ground gets its snow; the prototype's late chunk never
 * reached the terrain, whose shaders are assembled once at module load) and frost on every grass shader (the Classic
 * scatter, the field and the meadow ring). Everything sits behind `#ifdef SRO_SNOW`, which WorldWinter sets on the
 * terrain and the scatter only while there is snow or frost: off, the code is not compiled (the Low guard).
 * Uniforms `snwA` / `snwB` (winter/shaders.ts) are bound by reference through the renderers' sharedUniforms.
 */
import type { WorldShaderChunks } from '../shader-chunks.ts'
import { SNOW_CHUNK_CODE } from './shaders.ts'

/** The winter define on the terrain and the scatter renderers. */
export const SNOW_DEFINE = 'SRO_SNOW'
/** The shared uniform names (winter/shaders.ts header). */
export const SNOW_CHUNK_UNIFORMS = ['snwA', 'snwB'] as const

const UNI_WGSL = 'uniform snwA: vec4f;\nuniform snwB: vec4f;\n'
const UNI_GLSL = 'uniform vec4 snwA;\nuniform vec4 snwB;\n'

export const WINTER_CHUNKS: WorldShaderChunks = {
  terrain: {
    uniforms: SNOW_CHUNK_UNIFORMS,
    vWorld: true,
    wgsl: { uniforms: UNI_WGSL, ...SNOW_CHUNK_CODE.terrain.wgsl },
    glsl: { uniforms: UNI_GLSL, ...SNOW_CHUNK_CODE.terrain.glsl },
  },
  grass: {
    uniforms: SNOW_CHUNK_UNIFORMS,
    wgsl: { uniforms: UNI_WGSL, ...SNOW_CHUNK_CODE.grass.wgsl },
    glsl: { uniforms: UNI_GLSL, ...SNOW_CHUNK_CODE.grass.glsl },
  },
}
