#!/usr/bin/env node
// Licensed characters, the creator's files (docs/CHARACTERS.md §16.10). The pack is NEVER in git and never in the public
// release: this tool reads it from a path you give it and writes only under work/ (git-ignored):
//   blender -b --factory-startup --python packages/convert/src/tools/licensed/waterbender-creator-export.py -- --src "<pack>"
//   pnpm tsx packages/convert/src/tools/licensed-creator.ts --src "<pack>"
// (run licensed-char.ts first: the base body copies the outfit 01 sidecar). Writes under
// work/out(-opt)/char/licensed/waterbender/:
//   waterbender_<g>_base.{glb,json}  the body in the pack's lingerie (the creator's turntable; same skeleton and clips)
//   waterbender_<g>_parts.{glb,json} hairstyles (+ LOD1 / LOD2) and accessories, bound to the same joint list
//   look/index.json                 what is there (makeups per body, irises), read by the game before it offers them
//   look/<g>/face_<v>.jpg  2048     every head makeup map (graded and under-eye lifted as the built-in one, §16.7)
//   look/<g>/face1k_<v>.jpg 1024    the same for the creator's browsing; look/<g>/facethumb_<v>.jpg the list's icons
//   look/eye_<v>.jpg 1024           every iris (01–30 with the pack's pupil drawn over, the lid shadow), eyethumb_<v>.jpg
//   look/<g>/hair_white.png 1024    the pack's white hair (alpha, root darkening) for the hair-colour recolour
//   look/<g>/body.jpg 2048          the body's albedo (as in the glb) and look/<g>/paint.png 1024 the body paint mask
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeIO, type Material, type Texture } from '@gltf-transform/core'
import { LOOK_IRISES, LOOK_MAKEUPS } from '../../../shared/src/look.ts'
import { REPO_ROOT } from '../node-io.ts'
import { liftUnderEye, materialMaps, type Slot } from './licensed-char.ts'

const args = process.argv.slice(2)
const flag = (k: string, d?: string) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1]! : d
}
const WORK = join(REPO_ROOT, 'work')
const SRC = flag('--src', process.env.SRO_WATERBENDER_SRC)
const IN = resolve(flag('--in', join(WORK, 'licensed/waterbender/export'))!)
const OUTS = [join(WORK, 'out/char/licensed/waterbender'), join(WORK, 'out-opt/char/licensed/waterbender')]
const ONLY = new Set((flag('--only', 'f,m') ?? '').split(',').filter(Boolean))
const SKIP_LOOK = args.includes('--no-look')

/** The head UV's face (both bodies share the head UVs): the makeup thumbnails' crop (0..1). */
export const FACE_CROP = { x: 0.32, y: 0.27, w: 0.36, h: 0.36 }
/** The iris thumbnails' crop of the eye map (the iris sits at the centre, r 0.11). */
export const IRIS_CROP = { x: 0.36, y: 0.36, w: 0.28, h: 0.28 }

/** The creator's extra materials (the outfits' come from licensed-char.ts materialMaps). */
function creatorMaps(g: 'f' | 'm'): Record<string, Slot | { factor: [number, number, number, number]; roughness: number }> {
  const lingerie: Slot = { base: 'Base/T_LINGERIE_BaseColor.png', normal: 'Base/T_LINGERIE_Normal.png', normalDx: true, orm: 'Base/T_LINGERIE_OcclusionRoughnessMetallic.png', ormSize: 1024, alpha: 'MASK', cutoff: 0.5, double: true }
  return {
    ...materialMaps(g),
    MAT_LINGERIE: lingerie,
    MAT_M_LINGERIE: lingerie,
    // the nails have no map in the pack: a natural, slightly glossy nail
    MAT_NAILS: { factor: [0.78, 0.52, 0.5, 1], roughness: 0.3 },
  }
}

async function main(): Promise<void> {
  if (!SRC || !existsSync(join(SRC, 'Textures'))) throw new Error('licensed-creator: --src <River Spirit Waterbender pack dir> (or SRO_WATERBENDER_SRC) is required')
  const sharp = (await import('sharp')).default
  const T = (p: string) => join(SRC, 'Textures', p)
  const io = new NodeIO()
  const jpeg = (img: import('sharp').Sharp, q = 92) => img.jpeg({ quality: q, chromaSubsampling: '4:4:4' }).toBuffer()
  const write = (rel: string, data: Buffer | string) => {
    for (const dir of OUTS) {
      const p = join(dir, rel)
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, data)
    }
  }
  const grade = (rgb: Buffer, s: Slot) => {
    if (!s.grade) return
    const { sat, gain, warm = [1, 1, 1] } = s.grade
    for (let i = 0; i < rgb.length; i += 3) {
      const l = 0.2126 * rgb[i]! + 0.7152 * rgb[i + 1]! + 0.0722 * rgb[i + 2]!
      for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, Math.min(255, Math.round((l + (rgb[i + c]! - l) * sat) * gain * warm[c]!)))
    }
  }
  const raw = (rgb: Buffer, n: number) => sharp(rgb, { raw: { width: n, height: n, channels: 3 } })

  for (const g of ['f', 'm'] as const) {
    if (!ONLY.has(g)) continue
    const maps = creatorMaps(g)
    // 1. the glbs: materials by name (the Blender export suffixes duplicates: MAT_HAIR.003), one material per name
    const outfitSide = JSON.parse(readFileSync(join(WORK, `out-opt/char/licensed/waterbender/waterbender_${g}_01.json`), 'utf8')) as Record<string, unknown>
    const outfitDoc = await io.read(join(IN, `waterbender_${g}_01.glb`))
    const wantJoints = outfitDoc.getRoot().listSkins()[0]!.listJoints().map(j => j.getName()).join(',')
    for (const what of ['base', 'parts'] as const) {
      const file = join(IN, `waterbender_${g}_${what}.glb`)
      if (!existsSync(file)) throw new Error(`licensed-creator: ${file} missing (run waterbender-creator-export.py first)`)
      const doc = await io.read(file)
      const root = doc.getRoot()
      const joints = root.listSkins()[0]?.listJoints().map(j => j.getName()).join(',')
      if (joints !== wantJoints) throw new Error(`licensed-creator: ${file}: its joints differ from waterbender_${g}_01's (the game binds by index)`)
      const byName = new Map<string, Material>()
      for (const n of root.listNodes()) {
        const mesh = n.getMesh()
        if (!mesh) continue
        mesh.setName(n.getName())
        for (const p of mesh.listPrimitives()) {
          for (const s of p.listSemantics()) if (/^COLOR_/.test(s)) p.setAttribute(s, null)
          const m = p.getMaterial()
          if (!m) continue
          const name = m.getName().replace(/\.\d+$/, '')
          if (!byName.has(name)) byName.set(name, m.setName(name))
          p.setMaterial(byName.get(name)!)
        }
      }
      for (const m of root.listMaterials()) if (![...byName.values()].includes(m)) m.dispose()
      const cache = new Map<string, Texture>()
      const tex = async (key: string, make: () => Promise<{ data: Buffer; mime: string }>) => {
        let t = cache.get(key)
        if (!t) {
          const { data, mime } = await make()
          t = doc.createTexture(key).setImage(new Uint8Array(data)).setMimeType(mime)
          cache.set(key, t)
        }
        return t
      }
      for (const [name, m] of byName) {
        const s = maps[name]
        if (!s) {
          console.warn(`licensed-creator: ${g} ${what}: material ${name} has no maps`)
          continue
        }
        m.setEmissiveFactor([0, 0, 0]).setMetallicFactor(0)
        if ('factor' in s) {
          m.setBaseColorFactor(s.factor).setRoughnessFactor(s.roughness).setAlphaMode('OPAQUE')
          continue
        }
        // the parts' clothes maps (earrings, the hair flower: small pieces) at 1024
        const small = what === 'parts' && name.startsWith('MAT_CLOTHES')
        const size = small ? 1024 : s.size ?? 2048
        m.setBaseColorFactor([1, 1, 1, 1]).setMetallicFactor(s.orm ? 1 : 0).setRoughnessFactor(s.roughness ?? 1).setDoubleSided(!!s.double)
        m.setAlphaMode(s.alpha ?? 'OPAQUE')
        if (s.alpha) m.setAlphaCutoff(s.cutoff ?? 0.5)
        m.setBaseColorTexture(await tex(`${name}|base`, async () => {
          const src = s.overlay ? await sharp(T(s.base)).composite([{ input: T(s.overlay) }]).png().toBuffer() : T(s.base)
          const rgb = await sharp(src).removeAlpha().linear(s.tint ?? [1, 1, 1], [0, 0, 0]).resize(size, size).raw().toBuffer()
          if (s.darken) {
            const d = await sharp(T(s.darken.file)).extractChannel(0).resize(size, size).raw().toBuffer()
            for (let i = 0; i < d.length; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgb[i * 3 + c]! * (s.darken.min + (1 - s.darken.min) * (d[i]! / 255)))
          }
          if (s.underEye) liftUnderEye(rgb, await sharp(T(s.underEye.bare)).removeAlpha().resize(size, size).raw().toBuffer(), size, s.underEye.k)
          grade(rgb, s)
          if (s.alphaFrom || s.alpha) {
            const a = await sharp(T(s.alphaFrom ?? s.base)).ensureAlpha().extractChannel(3).resize(size, size).raw().toBuffer()
            return { data: await raw(rgb, size).joinChannel(a, { raw: { width: size, height: size, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' }
          }
          return { data: await jpeg(raw(rgb, size)), mime: 'image/jpeg' }
        }))
        if (s.normal) {
          m.setNormalTexture(await tex(`${s.normal}|n`, async () => {
            const r = await sharp(T(s.normal!)).removeAlpha().resize(size, size).raw().toBuffer()
            if (s.normalDx) for (let i = 1; i < r.length; i += 3) r[i] = 255 - r[i]!
            return { data: await jpeg(raw(r, size)), mime: 'image/jpeg' }
          }))
        }
        const orm = s.orm ?? s.mask ?? s.ao
        if (orm) {
          const n = small ? 1024 : s.ormSize ?? 1024
          const t = await tex(`${orm}|orm|${n}`, async () => {
            if (s.orm) return { data: await jpeg(sharp(T(s.orm)).removeAlpha().resize(n, n)), mime: 'image/jpeg' }
            const out = Buffer.alloc(n * n * 3)
            if (s.mask) {
              const ao = await sharp(T(s.mask)).extractChannel(1).resize(n, n).raw().toBuffer(), sm = await sharp(T(s.mask)).extractChannel(3).resize(n, n).raw().toBuffer()
              for (let i = 0; i < n * n; i++) { out[i * 3] = ao[i]!; out[i * 3 + 1] = 255 - sm[i]!; out[i * 3 + 2] = 0 }
            } else {
              const ao = await sharp(T(s.ao!)).extractChannel(0).resize(n, n).raw().toBuffer()
              for (let i = 0; i < n * n; i++) { out[i * 3] = ao[i]!; out[i * 3 + 1] = 255; out[i * 3 + 2] = 0 }
            }
            return { data: await jpeg(raw(out, n)), mime: 'image/jpeg' }
          })
          m.setMetallicRoughnessTexture(t).setOcclusionTexture(t)
        }
      }
      for (const t of root.listTextures()) if (!t.listParents().some(p => p !== root)) t.dispose()
      const glb = await io.writeBinary(doc)
      const name = `waterbender_${g}_${what}`
      write(`${name}.glb`, Buffer.from(glb))
      const meshes = root.listNodes().filter(n => n.getMesh()).map(n => n.getName())
      if (what === 'base') {
        // the outfit 01 sidecar: same skeleton (checked above), so the same retarget spec, clips and sockets
        const lic = outfitSide.licensed as Record<string, unknown>
        write(`${name}.json`, JSON.stringify({ ...outfitSide, name, licensed: { ...lic, outfit: 'base', creator: true, faces: [lic.face] } }))
      } else {
        write(`${name}.json`, JSON.stringify({ name, generator: 'licensed-creator.ts (CHARACTERS §16.10)', licensed: { gender: g, parts: meshes } }))
      }
      console.log(`${name}.glb ${(glb.byteLength / 1048576).toFixed(1)} MB: ${meshes.length} meshes, ${byName.size} materials`)
    }
    if (SKIP_LOOK) continue

    // 2. the look maps
    const head = materialMaps(g).MAT_HEAD!
    const bare = await sharp(T(head.underEye!.bare)).removeAlpha().resize(2048, 2048).raw().toBuffer()
    for (const v of LOOK_MAKEUPS[g]) {
      const s = materialMaps(g, v).MAT_HEAD!
      const file = T(s.base)
      if (!existsSync(file)) throw new Error(`licensed-creator: ${file} missing`)
      const rgb = await sharp(file).removeAlpha().resize(2048, 2048).raw().toBuffer()
      liftUnderEye(rgb, bare, 2048, s.underEye!.k)
      grade(rgb, s)
      write(`look/${g}/face_${v}.jpg`, await jpeg(raw(rgb, 2048), 90))
      write(`look/${g}/face1k_${v}.jpg`, await jpeg(raw(rgb, 2048).resize(1024, 1024), 88))
      const c = FACE_CROP
      write(`look/${g}/facethumb_${v}.jpg`, await jpeg(raw(rgb, 2048).extract({ left: Math.round(c.x * 2048), top: Math.round(c.y * 2048), width: Math.round(c.w * 2048), height: Math.round(c.h * 2048) }).resize(96, 96), 85))
    }
    // the white hair: colour × the root darkening, alpha from Transparent (as MAT_HAIR), for the recolour
    const hair = materialMaps(g).MAT_HAIR!
    {
      const n = 1024
      const rgb = await sharp(T('Base/Wavy/T_HAIR_WAVY_BaseColor_White.png')).removeAlpha().resize(n, n).raw().toBuffer()
      const d = await sharp(T(hair.darken!.file)).extractChannel(0).resize(n, n).raw().toBuffer()
      for (let i = 0; i < d.length; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgb[i * 3 + c]! * (hair.darken!.min + (1 - hair.darken!.min) * (d[i]! / 255)))
      const a = await sharp(T(hair.alphaFrom!)).ensureAlpha().extractChannel(3).resize(n, n).raw().toBuffer()
      write(`look/${g}/hair_white.png`, await raw(rgb, n).joinChannel(a, { raw: { width: n, height: n, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer())
    }
    // the body's albedo (the paint is drawn over it in the game) and the paint mask: the splashes only (the map's grey
    // padding glow below 0.35 is cut, 0.35..0.6 feathered)
    const body = materialMaps(g).MAT_BODY!
    {
      const rgb = await sharp(T(body.base)).removeAlpha().resize(2048, 2048).raw().toBuffer()
      grade(rgb, body)
      write(`look/${g}/body.jpg`, await jpeg(raw(rgb, 2048), 90))
      const n = 1024
      const m = await sharp(T(g === 'f' ? 'Base/T_BODY_F_UPD_Mask_Paint.png' : 'Base/T_BODY_Mask_Paint.png')).extractChannel(0).resize(n, n).raw().toBuffer()
      const out = Buffer.alloc(n * n * 4)
      for (let i = 0; i < n * n; i++) {
        const t = Math.max(0, Math.min(1, (m[i]! / 255 - 0.35) / 0.25))
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255
        out[i * 4 + 3] = Math.round(255 * t * t * (3 - 2 * t))
      }
      write(`look/${g}/paint.png`, await sharp(out, { raw: { width: n, height: n, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer())
    }
    console.log(`${g}: ${LOOK_MAKEUPS[g].length} makeups, hair, body paint`)
  }
  if (!SKIP_LOOK) {
    // the irises (shared by both bodies): as the built-in eye map (licensed-char.ts materialMaps eyes)
    const eye = materialMaps('f').MAT_EYES_L!
    for (const v of LOOK_IRISES) {
      const base = `Base/Eyes/T_EYES_BaseColor_${v}.png`
      const src = Number(v) <= 30 ? await sharp(T(base)).composite([{ input: T('Base/Eyes/T_EYES_PupilSample.png') }]).png().toBuffer() : T(base)
      const n = 1024
      const rgb = await sharp(src).removeAlpha().resize(n, n).raw().toBuffer()
      const d = await sharp(T(eye.darken!.file)).extractChannel(0).resize(n, n).raw().toBuffer()
      for (let i = 0; i < d.length; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(rgb[i * 3 + c]! * (eye.darken!.min + (1 - eye.darken!.min) * (d[i]! / 255)))
      write(`look/eye_${v}.jpg`, await jpeg(raw(rgb, n), 90))
      const c = IRIS_CROP
      write(`look/eyethumb_${v}.jpg`, await jpeg(raw(rgb, n).extract({ left: Math.round(c.x * n), top: Math.round(c.y * n), width: Math.round(c.w * n), height: Math.round(c.h * n) }).resize(64, 64), 85))
    }
    write('look/index.json', JSON.stringify({ version: 1, makeups: LOOK_MAKEUPS, irises: LOOK_IRISES, hair: true, paint: true, parts: true }))
    console.log(`${LOOK_IRISES.length} irises, look/index.json`)
  }
}

await main()
