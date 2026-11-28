# Lumen V15 — strict UI rewrite (macOS first)

Owner directive (2026-11-29): the current App and Orbit surfaces do **not** match
`docs/design/v15/paste-lumen-v15.html` + `README-Lumen-V15.md`. Rewrite all UI in
strict mode: no legacy visual code, no approximation. Keep every feature.

## Ground rules

1. **Visual source of truth**: the HTML's final effective CSS (see
   `lumen-v15-exact-tokens.md`, generated from all nine `<style>` blocks in
   document order) and the README's behaviour rules (§19 > §18 > §17 > §16).
   Every colour, radius, shadow, size, font size, spacing and timing is copied
   verbatim. No "close enough".
2. **No legacy UI code**: the new surfaces live in `native/clipboard/v15/` and
   do not import V7 view implementations (`LumenWorkspaceViews`,
   `LumenOrbitViews`, old `LumenTheme` view helpers). Only the data/feature layer
   is reused:
   - `LumenClipboardStore`, `LumenClipboardAPI`, `LumenModels` (data)
   - `LumenPreviewRegistry` + renderers (PDF/Office/ZIP/URL/folder/media/code)
   - `LumenContentIdentity` (identity registry, extended as needed)
   - formatting helpers (`LumenFormatters`, `LumenClassifier`)
3. **Feature parity**: real capture, sync, batch/undo, previews, folder/ZIP/URL,
   source attribution, multi-display rail, keyboard map, accessibility, Reduce
   Motion. Rewriting UI must not drop any behaviour listed under §2 of the README.
4. **Native semantics**: real NSWindow chrome; no fake traffic lights on other
   platforms. System fonts and text scaling respected.

## Module layout (new files, added to mac.go + build-aihome-app.sh)

```
native/clipboard/v15/
  V15Tokens.swift          // exact extracted tokens + colour math
  V15Glyphs.swift          // operation icons + identity glyphs (vector paths from HTML)
  V15Materials.swift       // glass fills, gradients, shadows, specular sheen
  V15OrbitRail.swift       // rail layout, cards, close affordance, time yield
  V15OpticalDots.swift     // 5-point window, hover wake, idle dim, labels
  V15OrbitParticles.swift  // soft capture/dissolve particle engine
  V15OrbitController.swift // state machine, capture/undo, multi-display viewports
  V15LibraryWindow.swift   // sidebar / history / gallery / inspector / settings
  V15QuickLookChrome.swift // shared preview container (renderer adapter)
```

`ClipboardWorkspaceWindow` and `QuickOrbitWindow` become thin façades (or are
replaced outright in `native/aihome-app/main.swift`) so the helper wiring keeps
the same public API while the visuals come exclusively from the new module.

## Acceptance loop

Each phase ships only when a native screenshot matches the token sheet:

- geometry within 1 DIP at 100% scale;
- colours sampled from the screenshot equal the token values;
- typography sizes/weights match §18.3;
- motion timings match §17/§18.4/§19.1 tokens.

Phases: A) Orbit; B) Library; C) Quick Look chrome. Windows/Linux ports follow
the same tokens after macOS passes.