# Remaster: Meshy retexture

This document covers the Meshy Retexture client, which gives UV-mapped models (characters, armour,
weapons) new PBR textures. The hard constraint is that **the new textures must fit the models' existing UVs
exactly**. Every task therefore sends `enable_original_uv: true`, and every result is checked against the
uploaded UVs before we use it.

Code:
- `packages/convert/src/remaster/meshy.ts` holds the client, the ledger, the credit cap and the UV check.
- `packages/convert/src/tools/meshy-retexture.ts` is the CLI.
- `packages/convert/test/meshy.test.ts` tests the client against a mocked fetch and a loopback fake server.

The API reference is <https://docs.meshy.ai/en/api/retexture>.

## 1. Secrets

- The key lives **only** in `work/secrets/meshy.env`, as a single line `MESHY_API_KEY=...`. You write that file; nothing else creates it. Comments, `export ` and quotes are accepted. `work/` is gitignored.
- The client reads the key when it makes each request, never earlier. It sends the key only as an `Authorization: Bearer` header, and only to `https://api.meshy.ai`. The one exception is a loopback test server (`127.0.0.1`, `localhost` or `[::1]`); the client refuses any other base URL.
- The key is never put in a URL. Result downloads (pre-signed URLs) are fetched **without** the header.
- Every error the client raises is scrubbed of the key and of its base64 form. This covers errors from a server that echoes the header back. Logs, `ledger.json` and `task.json` never contain it, and the tests assert this.
- A missing or empty key gives a clear error that names the file, not the value. `--dry-run` only reports whether the key is present.

## 2. Input: the pack

The client reads a pack manifest. By default this is `work/remaster/pack/pack.json`; use `--pack <file|dir>` to point elsewhere. When you pass a directory, the client reads `pack.json` inside it. Relative paths resolve against the manifest's folder.

```json
{ "parts": [
  { "id": "chinaman_armor_body", "glb": "chinaman_armor_body.glb",
    "renders": ["front.png", "back.png", "left.png", "right.png"],
    "prompt": "weathered bronze lamellar armour over red silk, ..." }
] }
```

- `id` must be a plain file name. It becomes the output folder name.
- `glb` is the model to upload. It should carry only the part's geometry and UV0, because the whole file is sent as a base64 data URI. Embedded textures and animation just add upload weight.
- `renders` holds 1–4 images (png, jpg or webp) for the `multiview` variant. A part without renders skips that variant.
- `prompt` is the `text_style_prompt` for the `prompt` variant, up to 800 characters. A part without a prompt skips that variant.
- The loader also accepts these aliases: `part`/`name` for `id`; `model`/`glbPath`/`upload` for `glb`; `multiview`/`images`/`views` for `renders`; `textStylePrompt`/`text_style_prompt`/`style` for `prompt`.

## 3. What a task sends

Each part produces one task per variant.

| field | multiview | prompt |
|---|---|---|
| `model_url` | `data:application/octet-stream;base64,<glb>` | same |
| style input | `multiview_image_urls`: the part's renders as data URIs | `text_style_prompt` |
| `ai_model` | `meshy-7` (Meshy requires it) | `--prompt-model`, default `meshy-7` |
| `enable_original_uv` | `true`, always | `true`, always |
| `enable_pbr` | `true`: base colour plus metallic, roughness and normal (and emission) | `true` |
| `texture_resolution` | `--resolution`, default `4k` (4k and 8k need meshy-6, meshy-7 or latest) | same |
| `target_formats` | `['glb']` | same |
| `remove_lighting` | only with `--remove-lighting` **and** meshy-6 | same |

Each task sends exactly one style input. `image_style_url` is not used.

Each job is validated before anything is spent: files exist, there are 1–4 renders, the prompt is 800 characters or fewer, and the model supports the chosen resolution. An invalid job is reported and never sent.

## 4. Credits: the hard cap

- Every POST is written to `work/remaster/meshy/ledger.json` as `CREATING` **before** it is sent, so a crash cannot hide a spend.
- **Booked cost** of an attempt:
  - If Meshy reported `consumed_credits`, that number.
  - `0` for a create that got a 4xx (`CREATE_REJECTED`), or for a task cancelled while `PENDING`, which Meshy refunds.
  - Otherwise, the **worst case of 15**. This covers tasks still in flight, a 5xx or dropped connection on create (`CREATE_UNKNOWN`), and a crash mid-create.
- **Before every create:** if `ledger total + 15 > cap`, the job is refused and not sent.
  - The cap counts the whole ledger history. A re-run therefore cannot spend another 150.
  - The default cap is **150**, for the first test. Raise it with `--cap N` when you decide to.
- The ledger only ever over-counts, so the cap holds even after crashes and retries.

## 5. Polling, retries, resume

- **Polling.** The client polls `GET /openapi/v1/retexture/:id` every 5 s, growing ×1.5 up to 30 s, and gives up after `--timeout-min` (default 30 minutes). A timed-out task stays `IN_PROGRESS` in the ledger, and the next run resumes polling it rather than creating a new task.
- **429.** Retried with exponential backoff (2 s doubling, 5 attempts), honouring `Retry-After`.
- **5xx and network errors.** These are retried for polls and downloads.
  - A create that gets a 5xx or loses its connection may or may not have made a task. It is booked at 15, and the client retries it at most 3 times, checking the cap before each POST.
  - A create that gets a 4xx other than 429 is not retried.
- **Resume.** Each part/variant is handled according to its latest ledger attempt:
  - `SUCCEEDED` and downloaded: skipped.
  - `SUCCEEDED` but not downloaded: downloaded now. The task is fetched again first, because its URLs may have expired.
  - `PENDING` or `IN_PROGRESS`: polled.
  - `FAILED`, `CANCELED`, `CREATE_*` or no attempt: created, under the cap.

## 6. Output and the UV check

`work/remaster/meshy/<part>/<variant>/` holds:
- `model.glb`
- `base_color.png`, `metallic.png`, `normal.png`, `roughness.png` and `emission.png`, whichever Meshy returns. When a task returns several texture sets, each file gets an `m<i>_` prefix.
- `task.json`: the final task record, without the result URLs, plus the source inputs.

After the download, the client compares the returned `model.glb`'s `TEXCOORD_0` with the uploaded glb:
- **identical**: the same vertex count and order, and every UV within 1e-4.
- **matched**: the vertex order or count differs (reordered or split), but every returned vertex, at its position, has a UV that the uploaded mesh has at the same position, and the reverse also holds. Positions are normalised to the unit box first, so a uniformly rescaled or moved result still matches.
- **mismatch**: anything else. The log prints `UV MISMATCH` and the counts of unmatched and uncovered vertices, and the report notes when the only difference is a V flip.

The verdict is stored in the ledger (`uvCheck`). A mismatch makes the CLI exit with code 1. **Do not ship a mismatched result.**

To re-run the check offline, use `verify`. We tried the check on real exports: `chinaman_adventurer.glb` (987 verts, 9 primitives) against itself gives `identical`. Against its `out-opt` quantized copy it is still `identical`, with a max delta of 3.8e-5.

## 7. CLI

```sh
# plan only: jobs, actions, worst-case cost, key present? (no API calls)
pnpm tsx packages/convert/src/tools/meshy-retexture.ts --dry-run

# the test run: one part, both variants, capped at 150 over the whole ledger
pnpm tsx packages/convert/src/tools/meshy-retexture.ts --only chinaman_armor_body

# filters and knobs
#   --variant multiview|prompt|all   --resolution 2k|4k|8k   --prompt-model meshy-7   --remove-lighting
#   --cap N   --timeout-min N   --pack <file|dir>   --out <dir>

pnpm tsx packages/convert/src/tools/meshy-retexture.ts ledger         # attempts, status, booked credits (no API calls)
pnpm tsx packages/convert/src/tools/meshy-retexture.ts verify         # re-run the UV check on downloads (no API calls)
pnpm tsx packages/convert/src/tools/meshy-retexture.ts cancel <id>    # DELETE a task; refunded only while PENDING
```

The CLI exits with 0 when everything succeeded or was already done. It exits with 1 on a failure, an invalid job, a refusal by the cap, or a UV mismatch, and with 2 on bad usage.

## 8. World models (DRAGON-INT, 2026-10-02)

A retail world model can be replaced by a model made outside the converter (Blender, Meshy) without touching any
placement: `content/remaster/models.json` (`sro-model-remaster` v1) lists the retail `.bsr` and the staged glb +
sidecar (and any lightmap folders of its own). The staged files live in `work/remaster/models/<set>/` (git-ignored, like
every asset; the table is the committed record). The converter (`packages/convert/src/world/remaster-models.ts`, in
the model loop of `convert-world.ts`) keeps the retail conversion and appends the staged model as a `'static'`
manifest model next to it: `models/<stem>.remaster.glb` + `.remaster.json`, `source` = the retail one plus
`#remaster`, and `models[i].remasterVariant` = its index (`report.remasterModels` lists them).

- **Who draws what:** the PBR path (Medium and up, with World batching on, the default) loads the variant in the
  retail model's place (`packages/world-render/src/batch/remaster.ts`, through the batcher's `modelFor`, the route
  BT-T's static tree variants take). Low / Classic never sets a batcher and draws the retail model: the Low path is
  unchanged. Options → World batching off draws the retail model too.
- **What stays retail:** every placement and uid, the nav (`nav.bin` / `nav-objects.bin` are built from the retail
  `.bms` navmeshes, never from glbs), the ambient particles (read from the retail BSR by the retail index), the
  World Editor library (it lists placed models).
- **The staged model's contract:** the retail model's own space (same pivot, scale and axes: the placements put it
  exactly where the retail one stood), static, every material single-sided (`doubleSided: true` makes the batch emit
  every triangle twice), `TEXCOORD_1` on every primitive whose material names an `sroLightmap`, and every lightmap it
  names either a retail one the export writes or a file of the entry's own folders. The converter checks all of it,
  plus the Khronos validator, and stops naming the source when a staged file is missing or wrong.
- **Maps:** a staged model's `sro-remaster` set is keyed on the variant's glb path:
  `world/<world>/models/<stem>.remaster#<glTF image>` in `out/remaster/manifest.json`, files under
  `out/remaster/sets/<set>/`.
- **Rollback:** remove the entry (or the file) and re-convert: the variant and the `remasterVariant` go, the retail
  model draws everywhere again.

The first set is the Jangan plaza (`work/remaster/models/jangan-plaza/`, made by the dragon assets job,
`work/tmp/dragon/INTEGRATE.md`): the golden dragon statue (Meshy M1 fitted to the retail statue, 29,998 triangles,
model 305) and the plaza model with the new fountain basin (model 251: gate06/07/08 byte-identical to retail, the pond
fence and lattice replaced by the basin, 8,302 triangles, its own 256² lightmap). The dragon's gold set is
`sets/jangan_dragon_m1` (class `metal`, @1024 below Ultra). The water stays the region's terrain water (the town
water shader, its rain ripples and reflection), and the waterfall placement is unchanged. LOD1 fallbacks
(`cj_jang_gate_dragon_lod1`, `cj_jang_gate.lod1`, +12k triangles instead of +35k) sit beside the LOD0 files: point the
two entries at them if a Medium bench ever misses.

## 9. Open items

- **[unknown]** Whether Meshy accepts `application/octet-stream` as the glb data-URI MIME type. The alternative is `model/gltf-binary`. It is one constant, `GLB_DATA_URI_MIME`.
- **[unknown]** Meshy's size limit for a data-URI upload. Upload only geometry and UV0 (see §2).
- **[unknown]** The real per-task cost at 4k with PBR. 15 is our planning figure, and the ledger records what Meshy reports.
- **[unknown]** Whether Meshy keeps vertex order with `enable_original_uv`. The check handles both cases (§6).
