/**
 * The release's Meshy sets (work/out/remaster/manifest.json, the user's picks of 2026-09-29): every approved staged
 * entry is live, its files sit under sets/<part>/ beside the manifest, and D35 holds on the real data: for each of the
 * 12 glb images the sro-remaster entry wins over the texture pipeline's sro-pbr set (the actors' own query, as
 * pbr/maps.ts ActorMaps makes it from the glb path, the image name and the sidecar texture), on every PBR tier, while
 * the 'retail' tier (Textures → Classic, and every Classic-path preset) resolves nothing. Skipped without the exports.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PbrMapIndex, parsePbrIndex, parseRemasterManifest, policyForTier, type TextureTier } from '@sro/world-render'
import { describe, expect, it } from 'vitest'

const WORK = fileURLToPath(new URL('../../../work/', import.meta.url))
const MANIFEST = `${WORK}out/remaster/manifest.json`
const STAGING = `${WORK}out/remaster/staging.json`
const PBR_INDEX = `${WORK}out-opt/pbr/index.json`
const ready = existsSync(MANIFEST) && existsSync(STAGING) && existsSync(PBR_INDEX)

const json = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as unknown

describe.skipIf(!ready)('the approved Meshy sets (work/out/remaster)', () => {
  it('every staged entry is in the live manifest, with its files under sets/<part>/', () => {
    const live = json(MANIFEST) as { textures: Record<string, Record<string, string>> }
    const staged = json(STAGING) as { textures: Record<string, Record<string, string>> }
    expect(Object.keys(staged.textures)).toHaveLength(12)
    for (const [key, entry] of Object.entries(staged.textures)) {
      const got = live.textures[key]
      expect(got, key).toBeDefined()
      for (const [field, value] of Object.entries(entry)) {
        if (!value.startsWith('staging/')) {
          expect(got![field], `${key}.${field}`).toBe(value)
          continue
        }
        const rel = got![field]!
        expect(rel, `${key}.${field}`).toMatch(/^sets\/[^/]+\/[^/]+\.webp$/)
        const file = `${WORK}out/remaster/${rel}`
        expect(existsSync(file), file).toBe(true)
        // The same bytes the user reviewed.
        expect(readFileSync(file).equals(readFileSync(`${WORK}out/remaster/${value}`)), rel).toBe(true)
      }
    }
  })

  it('D35 on the real data: the sro-remaster entry wins over the sro-pbr set on every PBR tier; retail resolves nothing', () => {
    const remaster = parseRemasterManifest(json(MANIFEST), '/out/remaster/manifest.json')!
    const pbr = parsePbrIndex(json(PBR_INDEX), '/out-opt/pbr/index.json')!
    expect(remaster.warnings).toEqual([])
    const index = new PbrMapIndex({ remaster, pbr })
    const pipelineOnly = new PbrMapIndex({ pbr })
    const tiers: TextureTier[] = ['remaster', '2x', 1024, 2048]
    let contested = 0
    // the 12 approved actor sets (the manifest also holds world-model sets, e.g. DRAGON-INT's plaza dragon, sized @1024)
    const staged = Object.keys((json(STAGING) as { textures: Record<string, unknown> }).textures)
    for (const key of staged) {
      const [glb, image] = key.split('#') as [string, string]
      // The actor query (ActorMaps.apply): the sidecar's texture for the material that draws this image.
      const sidecar = `${WORK}out-opt/${glb}.json`
      const materials = existsSync(sidecar) ? ((json(sidecar) as { materials?: Array<{ name: string; texture?: string | null }> }).materials ?? []) : []
      const textures = materials.map(m => m.texture ?? null)
      for (const texture of textures.length ? textures : [null]) {
        const q = { glb, image, texture, byStem: !texture }
        if (pipelineOnly.resolve(q, policyForTier('remaster'))?.origin === 'pbr') contested++
        for (const tier of tiers) {
          const rec = index.resolve(q, policyForTier(tier))
          expect(rec?.origin, `${key} on ${tier}`).toBe('remaster')
          expect(rec?.key).toBe(key)
          expect(rec?.albedo).toMatch(/^\/out\/remaster\/sets\/[^/]+\/albedo\.webp$/)
          expect(rec?.normal).toMatchObject({ kind: 'file' })
          expect(rec?.orm).toMatchObject({ kind: 'planes' })
        }
        expect(index.resolve(q, policyForTier('retail')), `${key} on retail`).toBeNull()
      }
    }
    // The precedence is exercised: the pipeline has its own set for several of these images (bodies, clothes_01_ba).
    expect(contested).toBeGreaterThan(0)
  })
})
