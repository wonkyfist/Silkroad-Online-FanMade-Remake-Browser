/**
 * Equipment export: Chinese armour (garment/protector/armour, degrees 1-3, both genders, plus the creation
 * defaults), shields and weapons (degrees 1-3) -> glb + sidecar under work/out/equipment/ (served at
 * /out/equipment/), and work/out/equipment/equipment.json for the game client and the model viewer.
 *
 *   pnpm tsx packages/convert/src/tools/export-equipment.ts [--out <outRoot>] [--no-index]
 *
 * Output (all retail-derived, stays under work/):
 *   equipment/china/{man_item,woman_item}/<class>_<nn>_<part>.glb  skinned to europe{man,woman}_skel (43/45 joints,
 *       same names, order and inverse binds as the character glbs); sidecar = converter sidecar + `equipment`
 *       { code[], gender, kind, method, slots, hides, coverage, ... } (EquipmentSidecar in equipment/manifest.ts)
 *   equipment/china/shield/shield_0N.glb, equipment/china/weapon/*.glb  rigid, attachBone in the sidecar
 *   equipment/equipment.json  EquipmentManifest: 26 characters with their slot -> mesh maps, every item by
 *       CodeName128 with slot, gender, class, degree, level and model. Compose with equipment/compose.ts.
 * The glbs are also merged into work/out/index.json so the model viewer lists them.
 *
 * Research notes (how the client composes a character, measured on this client): equipment/manifest.ts header.
 */
import { join, resolve } from 'node:path'
import { bodyGaps, exportEquipment } from '../equipment/export.ts'
import { loadConfig, openArchive } from '../node-io.ts'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const cfg = loadConfig()
const outRoot = outIndex >= 0 && args[outIndex + 1] ? resolve(args[outIndex + 1]!) : join(cfg.workDir, 'out')

const t0 = performance.now()
const result = await exportEquipment({
  data: openArchive('Data', cfg),
  media: openArchive('Media', cfg),
  outRoot,
  noIndex: args.includes('--no-index'),
  log: line => console.log(line),
})
const errors = result.assets.reduce((s, a) => s + a.errors, 0)
const gaps = result.coverage.reduce((s, c) => s + bodyGaps(c.reports), 0)
const { items, characters } = result.manifest
console.log(
  `${result.assets.length} models, ${items.length} items (${items.filter(i => !i.model).length} without a model), ` +
    `${characters.length} characters in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${result.manifestFile}; ` +
    `validator errors ${errors}; coverage gaps outside the hair ${gaps} (over ${result.coverage.length} REPLACE models)`,
)
if (errors) process.exitCode = 1
