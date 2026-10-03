/**
 * @sro/appearance: character appearance rules, environment-neutral (no node:*, no Babylon).
 *  - compose.ts   equipment composition: which base meshes an outfit hides, which item glbs bind, and how
 *  - scale.ts     Height (uniform scale) and Volume (per-bone radial factors), docs/CHARACTER_SCALE.md
 *  - starter.ts   creation choices: starter outfits and weapons, the charCreate request
 *  - manifest.ts  the equipment manifest contract (work/out/equipment/equipment.json)
 */
export * from './manifest.ts'
export * from './compose.ts'
export * from './scale.ts'
export * from './starter.ts'
