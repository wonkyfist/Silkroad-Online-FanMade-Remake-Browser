/**
 * The Publish report page (docs/WORLD_EDITOR.md §6.4): one self-contained HTML file (no script, inline styles, light
 * and dark), written to `work/editor/<world>/publish-<n>/report.html` and served to the editor page (which shows it in
 * an iframe's srcdoc): the changes in words, the checks with green / amber / red, the before / after images, the
 * budgets of the touched regions, the tests, the files. Pure (no node:*), environment-neutral.
 */
import type { PublishRecord } from './protocol.ts'

interface ReportLike {
  verdict: 'pass' | 'warn' | 'stop'
  checks: Array<{ id: number; title: string; status: string; summary: string; key?: string; details?: unknown }>
  nav?: { totals?: Record<string, number> }
  swim?: { deepWaterTiles: number }
}

const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const regionName = (id: number) => `${id & 0xff},${id >> 8}`

const STATUS: Record<string, [string, string]> = {
  pass: ['ok', 'Pass'], warn: ['warn', 'Look'], stop: ['stop', 'Stop'], skip: ['skip', 'Not run'],
  done: ['ok', 'Done'], fail: ['stop', 'Failed'], run: ['warn', 'Running'], wait: ['skip', 'Waiting'],
}

export function renderReportHtml(rec: PublishRecord, report: ReportLike | null, shots: ReadonlyArray<{ name: string; dataUrl: string }>): string {
  const badge = (s: string) => {
    const [cls, word] = STATUS[s] ?? ['skip', s]
    return `<span class="b ${cls}">${esc(word)}</span>`
  }
  const parts: string[] = []
  parts.push(`<h1>Publish ${rec.n} <small>${esc(rec.world)}</small></h1>`)
  parts.push(`<p class="lead ${rec.phase === 'stopped' || rec.phase === 'failed' ? 'bad' : ''}">${esc(rec.sentence)}</p>`)
  parts.push(`<h2>What changed</h2>`)
  parts.push(rec.changes.length ? `<ul>${rec.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>` : '<p class="dim">No change recorded in the history since the last publish.</p>')
  if (rec.regions) {
    parts.push(`<p class="dim">Regions rebuilt: ${rec.regions.core.map(regionName).join(' · ') || 'none'}${rec.regions.ring.length ? ` (+ ${rec.regions.ring.length} around them)` : ''}.</p>`)
  }
  if (report) {
    parts.push(`<h2>Checks</h2><table><tbody>`)
    for (const c of report.checks) parts.push(`<tr><td class="n">${c.id}</td><td>${badge(c.status)}</td><td><b>${esc(c.title)}</b><br>${esc(c.summary)}</td></tr>`)
    parts.push(`</tbody></table>`)
    const budgets = report.checks.find(c => c.key === 'budgets')?.details as { regions?: Array<{ region: string; status: string; rows?: unknown }> } | undefined
    if (budgets?.regions?.length) {
      parts.push(`<h2>Budgets per changed region</h2><table><tbody>`)
      for (const r of budgets.regions) parts.push(`<tr><td>${esc(r.region)}</td><td>${badge(r.status)}</td></tr>`)
      parts.push(`</tbody></table>`)
    }
    const t = report.nav?.totals
    if (t) parts.push(`<p class="dim">Walking: ${t.touched ?? 0} tiles looked at, ${t.closed ?? 0} closed (${t.closedSlope ?? 0} too steep, ${t.closedWater ?? 0} under deep water), ${t.objects ?? 0} object footprints changed.</p>`)
  }
  if (rec.hero?.length) {
    parts.push(`<h2>Textures</h2><p>Keep gives these painted tiles their full maps: ${rec.hero.map(h => `<code>${esc(h.tile)}</code> (${(h.cover * 100).toFixed(2)} %)`).join(', ')}.</p>`)
  }
  if (shots.length) {
    parts.push(`<h2>Before and after</h2><div class="shots">`)
    for (const s of shots) parts.push(`<figure><img alt="${esc(s.name)}" src="${s.dataUrl}"><figcaption>${esc(s.name.replace(/\.png$/, '').replace(/[-_]/g, ' '))}</figcaption></figure>`)
    parts.push(`</div>`)
  }
  if (rec.tests) parts.push(`<h2>Tests</h2><p>${badge(rec.tests.ok ? 'pass' : 'stop')} ${esc(rec.tests.summary)}</p><p class="dim">${rec.tests.files.map(f => esc(f)).join('<br>')}</p>`)
  if (rec.files) {
    parts.push(`<h2>Files</h2><p class="dim">${rec.files.out.length} map file(s) changed, ${rec.files.outRemoved.length} removed; ${rec.files.opt.length} optimized file(s) written.</p>`)
  }
  if (rec.drift?.length) parts.push(`<p class="dim">Not published (the live map is older than the converter there): ${rec.drift.slice(0, 20).map(esc).join(', ')}${rec.drift.length > 20 ? ' ...' : ''}</p>`)
  parts.push(`<h2>Steps</h2><table><tbody>`)
  for (const s of rec.steps) parts.push(`<tr><td>${badge(s.status)}</td><td>${esc(s.title)}${s.note ? ` <span class="dim">(${esc(s.note)})</span>` : ''}</td><td class="n">${s.ms !== undefined ? `${(s.ms / 1000).toFixed(1)} s` : ''}</td></tr>`)
  parts.push(`</tbody></table>`)
  if (rec.commit) parts.push(`<p class="dim">Commit: ${esc(rec.commit)}</p>`)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Publish ${rec.n}</title>
<style>
:root { --bg: #fbfaf7; --fg: #1d1c1a; --dim: #6b675f; --line: #e3dfd6; --ok: #2f7d3b; --warn: #a86b00; --stop: #b3261e; --skip: #8a857b; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1a18; --fg: #ece8df; --dim: #a39e93; --line: #36332e; --ok: #6cc47a; --warn: #e3a93b; --stop: #ef7b72; --skip: #8f8a80; } }
body { margin: 0; padding: 16px 20px 40px; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 980px; }
h1 { font-size: 22px; margin: 0 0 6px; } h1 small { color: var(--dim); font-weight: 400; font-size: 15px; }
h2 { font-size: 16px; margin: 22px 0 6px; } .lead { font-size: 16px; } .lead.bad { color: var(--stop); }
.dim { color: var(--dim); } table { border-collapse: collapse; width: 100%; } td { border-top: 1px solid var(--line); padding: 6px 8px; vertical-align: top; }
td.n { color: var(--dim); width: 1%; white-space: nowrap; } .b { display: inline-block; min-width: 52px; text-align: center; border-radius: 4px; padding: 0 6px; font-size: 12px; font-weight: 600; color: #fff; }
.b.ok { background: var(--ok); } .b.warn { background: var(--warn); } .b.stop { background: var(--stop); } .b.skip { background: var(--skip); }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; } figure { margin: 0; } img { width: 100%; border-radius: 4px; border: 1px solid var(--line); }
figcaption { color: var(--dim); font-size: 13px; } code { font-size: 13px; }
</style></head><body>
${parts.join('\n')}
</body></html>
`
}
