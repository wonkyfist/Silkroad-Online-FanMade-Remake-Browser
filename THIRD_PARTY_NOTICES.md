# Third-party notices

This private, fan-made Silkroad Online remake ships code ported from the projects below. Every file with ported code
starts with a header that names its source, and each project's list below names every such file in this repository.
The client build ships this file next to the game files (minification strips the headers from the bundle).

## Tidewater

- Project: Tidewater, https://github.com/dgreenheck/tidewater
- Commit: `4811ba4` (2026-09-25); a later re-read of upstream is a deliberate task
- Licence: MIT (below)
- What is ported (docs/COAST.md §8.12): the ocean spectrum, FFT, Jacobian foam and mip kernels (`OceanFFT.js`); the
  attenuation, band-limiting and normal code (`WaterSurface.js`); the roughness, reflection corrections, scattering and
  foam light (`WaterMaterial.js`); the CDLOD morph and selection (`CDLOD.js`); the swash cycle (`ShoreWaves.js`); the
  lace generator (`SurfFoam.js`).
- Assets: none. No Tidewater texture, model, sound or sky data is used; the foam lace texture is the output of our
  port of the generator.

The header every file with ported code starts with:

> Portions ported from Tidewater (github.com/dgreenheck/tidewater, `<file>` at `4811ba4`), MIT licence, Copyright (c)
> 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.

### Files with ported code

One repository path per line (`- path/to/file.ts`). CST-O, CST-S and every later lane that ports Tidewater code add
their files here; `packages/world-render/test/tidewater-notices.test.ts` checks the list against the headers.

<!-- tidewater-files:start -->
- packages/world-render/src/ocean/cdlod.ts
- packages/world-render/src/ocean/fft-core.ts
- packages/world-render/src/ocean/fft-wgsl.ts
- packages/world-render/src/ocean/ocean-plugin.ts
- packages/world-render/src/ocean/spectrum.ts
- packages/world-render/src/shore/chunks.ts
- packages/world-render/src/shore/lace.ts
- packages/world-render/src/shore/swash.ts
<!-- tidewater-files:end -->

### Licence

```text
MIT License

Copyright (c) 2026 DRG Software Solutions LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
