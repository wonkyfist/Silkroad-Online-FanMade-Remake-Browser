/**
 * The renderer's weather input (docs/RENDER.md §9.1, docs/WAVE_PLAN3.md D13, D25): produced from the WeatherFrame by
 * weather/adapters.ts `toRenderWeather`, consumed by WorldRender.setWeather (the PBR path: plugins' wetness, SSR
 * gating, grading weights, the lightning fill). Written by W9A-S.
 */
export interface RenderWeather {
  /** 0..1 rain intensity (drops, ripples, SSR on High). */
  rain: number
  /** 0..1 surface wetness (rates: shared stepSurface, WEATHER §6.1). */
  wetness: number
  /** 0..1 puddle fill. */
  puddles: number
  /** 0..1 cloud cover (dims the sun, flattens the sky, IBL). */
  cloud: number
  /** ≥ 1: visibility divisor (1 / fogScale). */
  fogMul: number
  /** 0..2 foliage/grass wind strength (gustMs / 8). */
  wind: number
  /** 0..1 lightning flash now (reduceFlashing is applied before it gets here). */
  flash: number
  /** Winter addition (docs/WINTER.md §7.6): 0..1 the winter look (frost and snow cover) for the grade; absent = 0. */
  winter?: number
}

export const CLEAR_RENDER_WEATHER: Readonly<RenderWeather> = Object.freeze({
  rain: 0, wetness: 0, puddles: 0, cloud: 0.1, fogMul: 1, wind: 0.25, flash: 0,
})
