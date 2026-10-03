/**
 * D13's inter-stage counter (material-budgets.test.ts; BF-1): the names of the WGSL FragmentInputs struct Babylon writes
 * for a preprocessed GLSL vertex shader, one @location each:
 * - every varying, arrays included (`varying vec4 vPositionFromLight0[SHADOWCSMNUM_CASCADES0];`);
 * - the CSM receiver's arrays as the fixed 4 members WGSL's lightUboDeclaration unrolls whatever the cascade count
 *   (vPositionFromLight{X}_0.._3, vDepthMetric{X}_0.._3);
 * - a matN as N locations;
 * - `cluster`: `vViewDepth` (CLUSTLIGHT_BATCH > 0, pbrFragmentExtraDeclaration), which the preset's clustered light
 *   container adds to every lit PBR material and a NullEngine rig cannot make.
 */
export function interStageNames(vertexGlsl: string, cluster = false): string[] {
  const names: string[] = []
  // Babylon sometimes writes several declarations on one line (`uniform mat4 m;varying vec4 a;varying vec4 b;`).
  const re = /(?:^|;|\n)\s*(?:flat\s+)?(?:varying|out)\s+(?:(?:highp|mediump|lowp)\s+)?(float|vec[234]|mat[234]|int|ivec[234]|uint|uvec[234])\s+(\w+)\s*(\[[^\]]+\])?\s*;/g
  for (const m of vertexGlsl.matchAll(re)) {
    const type = m[1]!, name = m[2]!, arr = m[3]
    if (name === 'glFragColor') continue
    const per = /^mat(\d)$/.test(type) ? Number(type[3]) : 1
    const n = arr ? (/^(vPositionFromLight|vDepthMetric)\d+$/.test(name) ? 4 : Number(/\d+/.exec(arr)?.[0] ?? 4)) : 1
    for (let i = 0; i < n * per; i++) names.push(n * per > 1 ? `${name}_${i}` : name)
  }
  if (cluster && !names.includes('vViewDepth')) names.push('vViewDepth')
  return [...new Set(names)]
}
