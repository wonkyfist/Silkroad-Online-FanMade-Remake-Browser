/**
 * The retail sky dome moved to sky/classic-sky.ts (wave 9, docs/SKY.md §4.4): `Sky` stays exported under its old name.
 * World's `sky` is the SkySystem (sky/sky-system.ts), which draws either this dome (sky style 'classic') or the modern
 * atmosphere.
 */
export { ClassicSky as Sky } from './sky/classic-sky.ts'
