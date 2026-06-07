# AGENTS.md

Guidance for AI coding agents (Codex, Cursor, Aider, Claude Code, etc.) working in
this repo. Humans: this doubles as the architecture doc.

## What this is

A local, build-less web app that renders an Obsidian vault as a holographic 3D
graph over the user's webcam, controlled by face + hand tracking (MediaPipe) and
drawn with Three.js. One HTML page + one JS file + one Node scanner. No framework,
no bundler, no backend.

## Golden rules

1. **Keep it dependency-free and build-less.** No npm packages, no bundler, no
   framework. Three.js, the fat-line addons and MediaPipe are loaded from CDN via
   the import-map / direct URLs in `index.html`. Don't introduce a build step.
2. **Never commit private data.** `graph.json` (generated from the user's real
   vault) and `.vault-path` are git-ignored. Do not add them, and do not paste real
   vault contents into the repo. The only committed graph is `graph.sample.json`.
3. **The app is camera-only to fully test.** You can verify it loads, renders the
   demo graph, and has no console errors; the face/hand gestures need a real webcam,
   which a headless agent usually can't drive. Say so instead of claiming you tested
   gestures.

## Run & verify

```bash
# generate the demo graph (uses ./sample-vault when no vault is configured)
node scan-vault.mjs ./sample-vault     # writes graph.json

# serve over localhost (camera needs a secure context; file:// won't work)
python3 serve.py 8123                  # then open http://localhost:8123
```

To verify a change: load the page, check the browser console for errors, and
confirm the constellation renders. `node --check app.js` catches syntax errors.
`serve.py` sends `no-store`, so a normal reload always shows the latest code.

## Architecture

- **`scan-vault.mjs`** (Node, zero deps). Walks the vault, extracts `[[wikilinks]]`,
  resolves them to nodes (basename or path), keeps unresolved targets as `ghost`
  nodes, and writes `graph.json`:
  `{ nodes: [{id,title,short,folder,ghost,degree,size}], links: [{source,target,context}] }`.
  Noise filtering is deliberate (see Gotchas).
- **`app.js`** (browser ES module). One `requestAnimationFrame` loop:
  - `detectFace()` / `detectHands()` → MediaPipe results into `faceLm` / `hands[]`.
  - `updateGestures()` → pinch = move/select. `updateOpenness()` → fist/open = scale.
  - `projectAndDraw()` → force-layout step, rotate the point cloud, project to pixels
    via an **orthographic camera in screen space**, fill the geometry buffers.
  - Rendering: `Points` (nodes, custom glow shader), `LineSegments2` (fat edges),
    `Points` for synapse pulses + flow, `LineSegments` for the face/hand meshes.
  - Everything uses **additive blending** for the glow.
- **`index.html`** — import-map for `three`, CDN imports for MediaPipe + line addons,
  and a cache-busting loader that appends `?t=<timestamp>` to `app.js`/`style.css`.
- **`style.css`** — neon palette, scanlines, HUD, label styles.

## Common customizations (where to look)

- **Point at a vault**: `.vault-path` file, `VAULT_PATH` env, or CLI arg — see
  `resolveVault()` in `scan-vault.mjs`.
- **Colors / neon palette**: `PALETTE` near the top of `app.js`.
- **Pinch sensitivity**: the `h.ratio` thresholds in `detectHands()` (engage `< 0.24`,
  release `> 0.4`).
- **Fist / open thresholds**: `detectHands()` (`fistRaw`, `openRaw`) and
  `updateOpenness()` (collapse `> 0.55`, expand `> 0.5`).
- **Line thickness**: `linewidth` on the `LineMaterial` in `initThree()`.
- **Neuron pulses**: `NPULSE`, `drawSynapses()`, `respawnPulse()`.
- **Translate the HUD to English**: strings live in `index.html` (`#help`, `#title`,
  `#stats`) and `app.js` (`showStatus(...)`, the readout tags, hover text). Currently
  Spanish — a clean first PR.

## Gotchas (read before debugging)

- **Vault noise**: real vaults contain `[[...]]` inside code blocks (e.g. n8n JSON
  `[[{"node":...}]]`, regex classes `[[:space:]]`). `cleanTarget()` drops targets
  with `{ } " \ : < >`. Don't remove this or the graph fills with junk.
- **Ghost nodes are intentional.** Referenced-but-not-created notes are the real
  hubs in many vaults; keep them (`getOrCreateGhost`).
- **WebGL lines are always 1px** → thick edges require `LineSegments2` + `LineMaterial`
  with `resolution` set (and updated on resize). Don't switch back to `LineBasicMaterial`.
- **Pinch vs fist** are separated by thumb–index distance (`r`), not by the other
  fingers, so a pinch with curled fingers isn't read as a fist. Gestures are matched
  by shape, so hand identity (left/right) is not required.
- **Mirror**: the video is CSS-mirrored and `videoToScreen()` mirrors landmark X to
  match; hand "side" is derived from on-screen position, not MediaPipe handedness.
- **iCloud vaults are slow** to scan the first time (files may be offloaded); the
  scan can take many seconds. That's not a hang.
- **Coordinate system**: the camera is orthographic in CSS pixels (origin top-left).
  The graph lives in abstract layout units and is projected/rotated by hand each frame.

## Project conventions

- Plain modern JS (ES modules in the browser, `node:` built-ins in the scanner).
- Comments explain the *why*. Keep them.
- Prefer small, surgical edits; keep the single-file-engine shape.
