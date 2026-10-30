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

## Follow-up: start of drag and page effects

A Chromium timeline captured one real pointer drag under the same software-rendered fixture. One main-thread task took 202.7 ms of elapsed time but 41.9 ms of thread CPU time; within it an `UpdateLayoutTree` event took 183.8 ms elapsed and 29.7 ms CPU. These figures include tracing and scheduling effects and cannot establish a general device performance result, but they show why elapsed frame intervals on this two-vCPU host cannot all be attributed to application code.

Four pairs of synthetic drags alternated the CRT scanline overlay on and off during resizing. Frame p95 values overlapped, so there was no stable evidence to justify changing the user's selected visual effect. A separate test showed that the sidebar's `transition: all` animates its backdrop blur for approximately 160 ms when the existing resize class changes the blur. Suppressing that transition reduced the median frame interval in the first 300 ms of four synthetic drags (baseline 21.7–39.5 ms, modified 16.6–17.3 ms), but four alternating pairs using real mouse input were noisy and did not consistently improve the early p95. The modified side effect was not shipped. These experiments do not prove actual display latency or selection correctness.
