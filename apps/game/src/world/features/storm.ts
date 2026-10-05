/**
 * Storms on the client (docs/WEATHER.md §12.7): the weather status icon by the minimap, the forecast lines in chat, the
 * glow of storm-charged monsters and the chain arcs of their hits.
 *
 * - **Icon**: at the minimap plate's lower left corner, left of the game clock (the sound button sits right of
 *   it), while it rains, a storm is forecast or one rages. Its tooltip (hover) lists every active effect from the
 *   server's `storm` status (i18n `storm.effect.<id>`), with the forecast or the storm's end counting down.
 * - **Chat**: a system line when a storm is forecast, when it breaks and when it passes.
 * - **Charged monsters** (EntityState.charged / entityUpdate.charged): a pulsing blue glow with crackles (storm/fx.ts)
 *   and a "Charged" badge on the name. `stormArc`: a jagged arc between the two players. Gameplay-relevant, so shown
 *   whatever the weather setting (like the strike telegraph).
 * - The night-storm visibility (fog) is the weather feature's: it reads the same `storm` status.
 * - Everything is one DOM node and one FX mesh, removed in `dispose`.
 */
import type { StormStatus } from '@sro/shared'
import { t, type StringKey } from '../../i18n/index.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import type { EntityView } from '../entities.ts'
import { StormFx, type ChargedBody } from '../storm/fx.ts'
import { tornadoInfo } from '../storm/tornado-status.ts'
import { tornadoTipLine } from './tornado.ts'

/** The icon's tooltip refreshes this often while shown (ms of page time): the countdowns. */
const TIP_MS = 1000

const CSS = `
.storm-icon {
  position: absolute; left: -26px; top: 178px; width: 22px; height: 18px; pointer-events: auto; cursor: default;
  background: rgba(0, 0, 0, 0.55); border: 1px solid rgba(156, 131, 80, 0.55); border-radius: 2px;
  display: flex; align-items: center; justify-content: center;
}
.storm-icon[hidden] { display: none; }
.storm-icon svg { width: 18px; height: 15px; display: block; }
.storm-icon.phase-forecast { animation: storm-icon-pulse 1.6s ease-in-out infinite; }
.storm-icon.phase-storm { border-color: rgba(120, 170, 255, 0.85); box-shadow: 0 0 5px rgba(110, 160, 255, 0.6); }
.storm-icon.tornado { border-color: rgba(255, 150, 90, 0.95); box-shadow: 0 0 6px rgba(255, 130, 70, 0.75); animation: storm-icon-pulse 1s ease-in-out infinite; }
.storm-tip .storm-tornado { color: #ffb48a; padding-left: 0; text-indent: 0; margin-bottom: 3px; }
.storm-tip .storm-tornado::before { content: ''; }
@keyframes storm-icon-pulse { 50% { border-color: rgba(120, 170, 255, 0.95); box-shadow: 0 0 6px rgba(110, 160, 255, 0.7); } }
.storm-tip {
  position: absolute; right: 0; top: 22px; width: 250px; padding: 6px 8px; z-index: 30; pointer-events: none;
  font: 11px/15px var(--font-body); color: var(--c-text); text-shadow: var(--t-outline); text-align: left;
  background: rgba(8, 10, 16, 0.92); border: 1px solid rgba(156, 131, 80, 0.7); border-radius: 2px; display: none;
}
.storm-icon:hover .storm-tip { display: block; }
.storm-tip b { display: block; color: #cfe0ff; margin-bottom: 3px; }
.storm-tip i { display: block; font-style: normal; color: #b9c2cf; margin-bottom: 3px; }
.storm-tip div { padding-left: 8px; text-indent: -8px; }
.storm-tip div::before { content: '• '; color: #7fa8ff; }
.badge-storm-charged { color: #8fc0ff; text-shadow: 0 0 4px rgba(90, 150, 255, 0.9); margin-right: 3px; }
`
let styled = false

function ensureStyle(): void {
  if (styled || typeof document === 'undefined') return
  styled = true
  const style = document.createElement('style')
  style.dataset.owner = 'storm'
  style.textContent = CSS
  document.head.append(style)
}

const CLOUD = '<path d="M5 10.5h9.5a3 3 0 0 0 0-6 4.2 4.2 0 0 0-8-0.8A3.4 3.4 0 0 0 5 10.5z" fill="#c8d0dc" stroke="#5a6472" stroke-width="0.8"/>'
const DROPS = '<path d="M6 12.5l-1 2M9.5 12.5l-1 2M13 12.5l-1 2" stroke="#7fb0ff" stroke-width="1.2" stroke-linecap="round"/>'
const BOLT = '<path d="M10.5 9l-2.6 3.6h2.2l-1.4 3.2 3.6-4.4h-2.3l1.6-2.4z" fill="#ffe36a" stroke="#a07a10" stroke-width="0.5"/>'

/** The icon's SVG for a phase. */
export function stormIconSvg(phase: StormStatus['phase']): string {
  const inner = phase === 'rain' ? CLOUD + DROPS : CLOUD + BOLT
  return `<svg viewBox="0 0 20 17" aria-hidden="true">${inner}</svg>`
}

/** "+25" / "-40": the effect's change with its sign. */
export function signedPct(pct: number | undefined): string {
  if (pct === undefined) return ''
  return pct > 0 ? `+${pct}` : String(pct)
}

/** The tooltip's lines for a status at server ms `now`: the title, an optional time line, one per effect. */
export function stormTipLines(s: StormStatus, now: number): { title: string; time: string | null; effects: string[] } {
  const minutes = (at: number) => Math.max(1, Math.ceil((at - now) / 60_000))
  let title: string
  let time: string | null = null
  if (s.phase === 'forecast') title = t('storm.title.forecast', { min: s.startsAt !== undefined ? minutes(s.startsAt) : '?' })
  else if (s.phase === 'storm') {
    title = t('storm.title.storm')
    if (s.endsAt !== undefined && s.endsAt > now) time = t('storm.title.ends', { min: minutes(s.endsAt) })
  } else title = t(s.phase === 'rain' ? 'storm.title.rain' : 'storm.title.calm')
  const effects = s.effects.map((e) => t(`storm.effect.${e.id}` as StringKey, { pct: signedPct(e.pct) }))
  return { title, time, effects }
}

/** The chat line for a phase change (null: none). `prev` null = the first status after entering. */
export function stormChatLine(prev: StormStatus['phase'] | null, s: StormStatus, now: number): string | null {
  if (s.phase === prev) return null
  if (s.phase === 'forecast') return t('storm.chat.forecast', { min: s.startsAt !== undefined ? Math.max(1, Math.ceil((s.startsAt - now) / 60_000)) : '?' })
  if (s.phase === 'storm') return t('storm.chat.breaks')
  if (prev === 'storm') return t('storm.chat.passes')
  return null
}

export function stormFeature(ctx: WorldFeatureContext): WorldFeature {
  // A bare context (the feature-list test) gets nothing.
  if (!ctx.session) return {}
  let status: StormStatus = { phase: 'calm', effects: [] }
  let phase: StormStatus['phase'] | null = null
  let icon: HTMLElement | null = null
  let tip: HTMLElement | null = null
  let iconParent: HTMLElement | null = null
  let iconPhase = ''
  let nextTip = 0
  let fx: StormFx | null = null
  const charged = new Set<number>()

  const pageNow = () => (typeof performance === 'undefined' ? Date.now() : performance.now())

  const renderTip = () => {
    if (!tip) return
    const { title, time, effects } = stormTipLines(status, ctx.serverNow())
    tip.replaceChildren()
    const b = document.createElement('b')
    b.textContent = title
    tip.append(b)
    if (time) {
      const i = document.createElement('i')
      i.textContent = time
      tip.append(i)
    }
    // docs/WEATHER.md §13.7: a tornado up, with its distance and direction
    const tor = tornadoInfo()
    if (tor) {
      const d = document.createElement('div')
      d.className = 'storm-tornado'
      d.textContent = tornadoTipLine(tor)
      tip.append(d)
    }
    for (const line of effects) {
      const d = document.createElement('div')
      d.textContent = line
      tip.append(d)
    }
  }

  const showIcon = () => {
    const parent = ctx.minimap()?.root ?? null
    const tornado = tornadoInfo() !== null
    const shown = !!parent && (status.phase !== 'calm' || tornado)
    if (!shown) {
      if (icon) icon.hidden = true
      return
    }
    if (!icon && typeof document !== 'undefined') {
      ensureStyle()
      icon = document.createElement('div')
      icon.className = 'storm-icon'
      tip = document.createElement('div')
      tip.className = 'storm-tip'
      icon.append(tip)
      iconPhase = ''
    }
    if (!icon) return
    if (iconParent !== parent) {
      parent!.append(icon)
      iconParent = parent
    }
    icon.hidden = false
    const look = `${status.phase}${tornado ? ' tornado' : ''}`
    if (iconPhase !== look) {
      iconPhase = look
      icon.className = `storm-icon phase-${status.phase}${tornado ? ' tornado' : ''}`
      // keep the tooltip node, swap the picture
      for (const n of [...icon.childNodes]) if (n !== tip) n.remove()
      icon.insertAdjacentHTML('afterbegin', stormIconSvg(status.phase))
    }
    const now = pageNow()
    if (now >= nextTip) {
      nextTip = now + TIP_MS
      renderTip()
    }
  }

  const setCharged = (v: EntityView | undefined, id: number, on: boolean) => {
    if (on) charged.add(id)
    else charged.delete(id)
    v?.setBadge('storm-charged', on ? t('storm.badge.charged') : null)
  }

  const centre = (v: EntityView): [number, number, number] => {
    const p = v.root.position
    return [p.x, p.y + (v.state.kind === 'player' ? 1.1 * v.scale : Math.max(0.6, Math.min(2.5, v.radius * 1.1))), p.z]
  }

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') {
        status = { phase: 'calm', effects: [] }
        phase = null
        charged.clear()
        fx?.clear()
        nextTip = 0
      } else if (msg.t === 'storm') {
        const line = stormChatLine(phase, msg.storm, ctx.serverNow())
        if (line) ctx.chat.add('system', line)
        status = msg.storm
        phase = msg.storm.phase
        nextTip = 0
      } else if (msg.t === 'entityUpdate' && msg.charged !== undefined) {
        setCharged(ctx.view(msg.id), msg.id, msg.charged)
      } else if (msg.t === 'stormArc') {
        const a = ctx.view(msg.from)
        const b = ctx.view(msg.to)
        if (!a || !b) return
        fx ??= new StormFx(ctx.scene)
        fx.arc(centre(a), centre(b), ctx.serverNow())
      }
    },

    onEntityAdded(v) {
      if (v.state.kind === 'mob' && v.state.charged) setCharged(v, v.state.id, true)
    },

    onEntityRemoved(v) {
      charged.delete(v.state.id)
    },

    onFrame(now) {
      showIcon()
      if (charged.size === 0 && !fx) return
      const cam = ctx.scene.activeCamera
      const bodies: (ChargedBody & { d: number })[] = []
      for (const id of charged) {
        const v = ctx.view(id)
        if (!v || v.dead) continue
        const [x, y, z] = centre(v)
        const d = cam ? (cam.globalPosition.x - x) ** 2 + (cam.globalPosition.z - z) ** 2 : 0
        bodies.push({ id, x, y, z, r: Math.max(0.4, v.radius), d })
      }
      bodies.sort((a, b) => a.d - b.d)
      if (bodies.length > 0) fx ??= new StormFx(ctx.scene)
      fx?.update(now, bodies, cam)
    },

    dispose() {
      icon?.remove()
      icon = null
      tip = null
      iconParent = null
      charged.clear()
      fx?.dispose()
      fx = null
    },
  }
}
