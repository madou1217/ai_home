# Lumen V15 — macOS verification runbook

State: branch `lumen/v15` builds clean with `scripts/build-aihome-app.sh`
(macOS 27, arm64). Visual acceptance is pending an unlocked user session.

## Build and launch

```bash
git checkout lumen/v15
./scripts/build-aihome-app.sh
open -a "$PWD/bin/native/darwin-arm64/AI Home.app" --args --lumen
open -a "$PWD/bin/native/darwin-arm64/AI Home.app" --args --orbit   # bottom rail only
```

The installed V7 app keeps running until the V15 acceptance passes; running the
build from `bin/` does not replace it.

## Capture evidence

```bash
# window list (owner / title / bounds)
swift /tmp/lumen-diag/wins.swift
# single window (by id) or region
screencapture -x -o -l <windowID> shot.png
screencapture -x -R <x>,<y>,<w>,<h> shot.png
```

Evidence lives under `.test-artifacts/lumen-native/` (never in the repo root).

## Case order (see `.test-artifacts/lumen-v15/acceptance-macos.md`)

1. Orbit single screen: A05/A06/A07/A20/A22/A38/A48/A68/A69.
2. Orbit removal/capture: A39–A43, A49–A51, A65, A66, A71.
3. Multi-display: A01–A04, A70 (requires two or more screens; check
   "Displays have separate Spaces" both ways and hot-plug).
4. Library: A32–A35, A52–A54, A58–A61.
5. Quick Look: A12–A15, A26/A27 (ZIP), A28 (URL), A29/A30.
6. System: A16 (Reduce Motion), A17 (10k items), A73/A75, A78 screenshots.

## Known constraints to record

- HTML / SVG / Markdown *render* mode is not implemented: it needs a product
  decision on extending the isolated-WebView scope (URL renderer only today).
- Legacy DOC/XLS, PPTX layout fidelity, folder tree preview and Tree-sitter
  language analysis remain open items from the V15 renderer table.
- 120/144 Hz and mixed-DPI frame budgets are not measured yet.