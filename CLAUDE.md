# CLAUDE.md

Instructions for **Claude Code** in this repo. The full architecture, conventions
and gotchas live in **[`AGENTS.md`](./AGENTS.md)** — read that first; this file only
adds Claude-specific notes.

## TL;DR

Local, build-less web app: an Obsidian vault rendered as a holographic 3D graph
over the webcam, controlled by face + hand tracking. `scan-vault.mjs` (Node) builds
`graph.json`; `app.js` (browser) renders it. No framework, no build, no backend.

## Do / Don't

- **Do** keep it dependency-free (CDN imports only) and build-less.
- **Do** run `node --check app.js` after edits, then serve and check the console.
- **Don't** ever commit `graph.json` or `.vault-path` (private vault data — they're
  git-ignored). Only `graph.sample.json` is public.
- **Don't** claim the hand/face gestures were tested unless a real webcam was used —
  a headless run can only verify that the page loads, the demo graph renders, and the
  console is clean.

## Running & verifying

```bash
node scan-vault.mjs ./sample-vault    # demo graph.json
python3 serve.py 8123                 # serve over localhost (camera needs it)
```

If you have a browser-preview tool, point it at `http://localhost:8123` and check
`console` for errors + screenshot the constellation. `serve.py` sends `no-store`,
and `index.html` cache-busts `app.js?t=…`, so reloads always show your latest edit
(no hard-refresh needed).

## Where things are

`PALETTE`, `detectHands()` (pinch/fist/open thresholds), `updateOpenness()` (scale),
`projectAndDraw()` (layout + render), `drawSynapses()` (neuron pulses) — all in
`app.js`. Vault path resolution is `resolveVault()` in `scan-vault.mjs`. See
`AGENTS.md` → "Common customizations" for the exact knobs.

## Gotchas

Vault-noise filtering, ghost nodes, fat lines (`LineSegments2`), pinch-vs-fist by
thumb–index distance, the screen mirror, and slow iCloud scans — all documented in
`AGENTS.md` → "Gotchas". Read them before "fixing" anything that looks odd.
