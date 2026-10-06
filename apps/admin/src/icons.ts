/**
 * The panel's line icons: small inline SVGs drawn for the panel (24-unit grid, 1.8 stroke, currentColor), so they
 * follow the text colour and need no icon package or extra request. `svgIcon(name)` returns an aria-hidden <svg>.
 */

const NS = 'http://www.w3.org/2000/svg'

/** A circle as a path (two arcs), so every icon is a list of path data. */
const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

const PATHS = {
  dashboard: ['M4 4h6v8H4z', 'M14 4h6v5h-6z', 'M14 13h6v7h-6z', 'M4 16h6v4H4z'],
  accounts: [circle(9, 8, 3.5), 'M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6', 'M15.5 4.6a3.4 3.4 0 0 1 0 6.8', 'M18 14.3c2.2.6 3.5 2.6 3.5 5.7'],
  characters: ['M16 4h4v4l-9 9-4-4z', 'M5.5 11.5l7 7', 'M9 15l-4.5 4.5', circle(4, 20, 0.6)],
  items: ['M6.5 3.5h11L21 9l-9 11.5L3 9z', 'M3 9h18', 'M9.5 3.5L8 9l4 11.5L16 9l-1.5-5.5'],
  drops: ['M9 3h6l-1.6 3.4h-2.8z', 'M10.4 6.4C6.4 8 4.5 11.6 4.5 15c0 3.6 3 6 7.5 6s7.5-2.4 7.5-6c0-3.4-1.9-7-5.9-8.6', 'M13.6 11.6c-.4-.6-1-.9-1.8-.9-1 0-1.8.6-1.8 1.4 0 1.9 3.8 1 3.8 2.9 0 .8-.8 1.4-1.9 1.4-.8 0-1.5-.4-1.9-1', 'M11.9 9.6v1.1', 'M11.9 16.4v1.1'],
  world: ['M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21z', circle(12, 9.5, 2.5)],
  quests: ['M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v9a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 4v-4h-1A2.5 2.5 0 0 1 4 14.5z', 'M12 6.8v4.4', 'M12 14v.01'],
  events: ['M12 3c.8 3.2 5.5 5.2 5.5 10.5a5.5 5.5 0 0 1-11 0c0-2.3 1.1-4 2.3-5 .1 2 .9 3.2 2.1 3.4C10.6 9 10.4 6 12 3z'],
  settings: ['M4 6h9', 'M17 6h3', circle(15, 6, 2), 'M4 12h3', 'M11 12h9', circle(9, 12, 2), 'M4 18h11', 'M19 18h1', circle(17, 18, 2)],
  servers: ['M4 4.5h16v6H4z', 'M4 13.5h16v6H4z', 'M8 7.5h.01', 'M8 16.5h.01', 'M12 7.5h4', 'M12 16.5h4'],
  audit: ['M9 3.5h6v3H9z', 'M15 5h2.5A1.5 1.5 0 0 1 19 6.5v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-13A1.5 1.5 0 0 1 6.5 5H9', 'M8.5 11h7', 'M8.5 14.5h7', 'M8.5 18h4'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevronDown: ['M6 9l6 6 6-6'],
  chevronLeft: ['M15 6l-6 6 6 6'],
  chevronRight: ['M9 6l6 6-6 6'],
  search: [circle(11, 11, 6.5), 'M20 20l-4.2-4.2'],
  logout: ['M9.5 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20h3', 'M15.5 8l4 4-4 4', 'M19.5 12H9.5'],
  swap: ['M4 8h14', 'M15 5l3 3-3 3', 'M20 16H6', 'M9 13l-3 3 3 3'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  alert: [circle(12, 12, 9), 'M12 7.5v5.5', 'M12 16.5v.01'],
  info: [circle(12, 12, 9), 'M12 11v5.5', 'M12 7.5v.01'],
  clock: [circle(12, 12, 9), 'M12 7v5l3.2 2'],
  globe: [circle(12, 12, 9), 'M3 12h18', 'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'],
  release: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9'],
  database: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  pulse: ['M3 12h4l3-7 4 14 3-7h4'],
  inbox: ['M3 13l3-8h12l3 8', 'M3 13v6h18v-6', 'M3 13h5l1.5 2.5h5L16 13h5'],
  megaphone: ['M4 10v4h3l8 4.5v-13L7 10z', 'M18.5 9.5a3.5 3.5 0 0 1 0 5'],
  restart: ['M20 12a8 8 0 1 1-2.3-5.6', 'M20 4v5h-5'],
  users: [circle(12, 8, 4), 'M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7'],
  download: ['M12 3.5v11', 'M7.5 10l4.5 4.5 4.5-4.5', 'M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2'],
} as const satisfies Record<string, readonly string[]>

export type IconName = keyof typeof PATHS

export function svgIcon(name: IconName, cls = 'svg-icon'): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', cls)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  for (const d of PATHS[name]) {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}
