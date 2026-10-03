/** URL parameters (see README "URL parameters"). */
export interface Params {
  /** ?engine=webgl forces WebGL2. */
  webgl: boolean
  /** ?mock=1: in-browser mock server instead of /api + /ws. */
  mock: boolean
  /** ?skip=1: skip the logo splash. */
  skipSplash: boolean
  /** ?auto=1 (mock only): log in as tester/tester, pick the first server, land on character select. */
  auto: boolean
  /** ?mute=1: start with music muted. */
  mute: boolean
  /** ?gm=1 (mock only): every mock account is a Game Master (admin), to try the GM window offline. */
  gm: boolean
  /** ?kit=1: the UI kit gallery (every control in every state) instead of the game (docs/UI.md §9.1 UI-K). */
  kit: boolean
  /** ?fxlab=1 (mock only): the FX lab, `window.__sroFxLab` (docs/EFFECTS.md §2.5 H2, apps/game/src/debug/fx-lab.ts). */
  fxlab: boolean
}

export function readParams(search = location.search): Params {
  const q = new URLSearchParams(search)
  const on = (k: string) => {
    const v = q.get(k)
    return v !== null && v !== '0' && v !== 'false'
  }
  const mock = on('mock')
  return {
    webgl: (q.get('engine') ?? '').toLowerCase().startsWith('webgl'),
    mock,
    skipSplash: on('skip') || (mock && on('auto')),
    auto: mock && on('auto'),
    mute: on('mute'),
    gm: mock && on('gm'),
    kit: on('kit'),
    fxlab: mock && on('fxlab'),
  }
}
