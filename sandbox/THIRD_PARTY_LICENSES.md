# Third-Party Licenses

`ValenceBox` (this `sandbox/` app) is licensed under the **GNU Affero General
Public License v3.0 (AGPL-3.0-only)** — see [`../LICENSE`](../LICENSE).

The built application bundles or links the following third-party components,
which remain under their own licenses. Their notices are reproduced here to
satisfy attribution requirements.

## Runtime dependencies

| Component | License | Notes |
|---|---|---|
| [`@mercuryworkshop/wisp-js`](https://github.com/MercuryWorkshop/wisp-js) | AGPL-3.0 | Copyright (C) Mercury Workshop. Used in `src/main/wisp.ts` as the WISP egress relay implementation, `require()`'d in-process. |
| [`@xterm/xterm`](https://github.com/xtermjs/xterm.js) | MIT | Copyright (c) 2017-2023, The xterm.js authors. Vendored as a UMD bundle into `dist/renderer/vendor/xterm.js` by `scripts/copy-renderer.js`. |
| [`@xterm/addon-fit`](https://github.com/xtermjs/xterm.js) | MIT | Copyright (c) 2017-2023, The xterm.js authors. Vendored alongside xterm.js. |
| [`@mongodb-js/zstd`](https://github.com/mongodb-js/zstd) | Apache-2.0 | Used for snapshot compression in `src/main/snapshot.ts`. |
| [`ws`](https://github.com/websockets/ws) | MIT | WebSocket implementation. |
| [`chokidar`](https://github.com/paulmillr/chokidar) | MIT | File watching for sync. |

## Build-time / vendored binary assets

The v86 emulator runtime assets (`libv86.js`, `v86.wasm`, `seabios.bin`,
`vgabios.bin`) are extracted at build time from the `env86/` git submodule
(see repo root `README.md`) and copied into the shipped application. They are
not modified.

| Component | License | Notes |
|---|---|---|
| [v86](https://github.com/copy/v86) | BSD-2-Clause | Copyright (c) 2012, The v86 contributors. The emulator itself; assets are copied unmodified into the built app. |
| [env86](https://github.com/progrium/env86) | MIT | Copyright 2024 Jeff Lindsay. Build-tool only (not shipped at runtime) — used solely to build/extract the v86 assets above. |

## MIT License text (xterm.js, env86)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## BSD-2-Clause License text (v86)

```
Copyright (c) 2012, The v86 contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```
