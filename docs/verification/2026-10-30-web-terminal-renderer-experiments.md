# Web Terminal renderer experiments, 2026-10-30

The ongoing goal is smoother resizing, including while the PTY is producing output. These are exploratory results, not acceptance evidence for that goal. The working tree at the start was `18a0b2b2`; the WebUI was built from that state. The host had no usable hardware GPU. Chromium 149 headless ran at 1440×900 with `--disable-gpu` and software rendering. The PTY fixture updated its last line every 50 ms and repainted its screen on size changes.

A CPU profile of one synthetic 1.5-second resize included time in xterm's DOM row creation and replacement and in garbage collection. It does not attribute actual presented-frame delay to those functions. Inspection of xterm 6.0.0 also found a synchronous full row render inside its DOM renderer's resize handling, followed by a scheduled full refresh.

## Renderer comparison

An isolated copy of the built WebUI was instrumented to expose its terminal instance and to load `@xterm/addon-webgl` 0.19.0. The experiment enabled Chromium's `--enable-unsafe-swiftshader`; no running server or installed WebUI was changed. Six fixed-duration synthetic drags were run on the same page in the order DOM, WebGL, WebGL, DOM, DOM, WebGL. The existing no-op DOM style-write optimization was retained in the DOM runs. Switching renderer required checking the xterm buffer for header and live-output text rather than the rendered DOM, so this comparison does not verify WebGL glyphs, selection, IME, or context-loss recovery.

| Renderer | Frame interval p50, ms | Frame interval p95, ms | PTY resize requests |
| --- | ---: | ---: | ---: |
| DOM | 21.3 / 16.8 / 18.7 | 67.4 / 47.7 / 41.1 | 16 / 20 / 17 |
| WebGL with SwiftShader | 121.1 / 114.4 / 207.1 | 257.2 / 224.0 / 335.7 | 6 / 7 / 5 |

The live-output sequence advanced in all runs. These are animation-frame intervals during synthetic drags, not displayed-frame latency or a hardware GPU measurement. Software WebGL is substantially worse here, and the different number of delivered grid resizes is itself a sign of an unequal workload. Do not enable WebGL by default on this evidence. Hardware-accelerated WebGL and a safe fallback remain untested.

## Duplicate synchronous redraw experiment

In another isolated build, an experimental wrapper around xterm's private DOM renderer suppressed `renderRows` only while its resize handler ran; the scheduled full refresh remained enabled. The same page alternated three baseline and three modified synthetic drags during live output. The three baseline p95 frame intervals were 51.6, 49.3 and 45.4 ms; the modified values were 56.4, 37.3 and 58.2 ms. Terminal text and final PTY sizes converged in this fixture. This provides no stable performance gain and does not cover selection behavior. The wrapper was not added to the product: it depends on private xterm internals and may change selection rendering.

The production renderer and resize scheduling were not changed by either experiment. Continue investigation with real pointer input, varied terminal contents and live output; verify actual display behavior and input/selection correctness before adopting a renderer change.
