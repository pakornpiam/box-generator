# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page, no-build, client-side parametric generator for 3D-printable
storage boxes (rectangular or cylindrical) with a matching lid, targeting
Bambu Lab / FDM printing. The whole app is three files — no `package.json`,
no bundler, no test suite:

- [index.html](index.html) — sidebar controls (all parameter inputs) + the
  3D viewport div. Loads Three.js from the jsdelivr CDN via an import map
  (`<script type="importmap">`), so an internet connection is required.
- [app.js](app.js) — everything: geometry construction, parameter reading,
  validation, the Three.js scene, and binary STL export. ES module, no
  transpilation.
- [style.css](style.css) — dark-theme sidebar/viewport layout.

## Running it

There is no dev server config beyond `.claude/launch.json`, which just serves
the folder statically:

```
python -m http.server 8080 --directory .
```

Then open `http://localhost:8080/`. Any static file server works — the app
has no server-side logic. There is no build step, linter, or test runner to
invoke; changes to `app.js`/`index.html`/`style.css` are picked up on
refresh. Because `index.html` loads `app.js` via a versioned query string
(`app.js?vN`), bump that suffix when you want to guarantee a stale browser
cache doesn't serve an old copy.

## Architecture

**Everything is Z-up, in millimeters, built by direct additive extrusion —
there is no CSG/boolean library in play.** Overlapping solids (e.g. a boss
base + its counterbore ring, a thread coil on a neck) are intentional: the
STL exporter emits each geometry as its own set of triangles and relies on
the slicer to fuse coincident/overlapping manifolds. When adding a feature,
follow this pattern rather than trying to subtract volumes — there's no
subtraction primitive here.

**Data flow per rebuild** ([app.js](app.js) `rebuild()` near the bottom):
`readParams()` reads every DOM input into a flat `p` object → per-style
derived values are computed onto `p` (thread geometry, boss positions,
groove heights, cutout depths, etc. — see the bottom of `readParams()`) →
`buildBox(p)` / `buildLid(p)` return arrays of positioned
`THREE.BufferGeometry` → `validate(p)` returns warning strings shown in the
sidebar → geometries are added as meshes to `boxGroup`/`lidGroup`/
`plateGroup`. Every input listener just calls `rebuild()` — the model is
fully rebuilt from scratch on every change, there is no incremental update.

**Shape/lid-style orthogonality**: `shape` (`rect`/`cyl`) and `style`
(`screw`/`hinged`/`snap`/`slide`/`thread`) are mostly independent, but some
combinations are invalid and get silently coerced in `readParams()` (e.g.
`slide`/`hinged` force to `snap` on a cylinder; `thread` forces to `screw`
on a rectangle). `ring(p, off)` is the one function both shapes share for
wall/skirt/rail cross-sections — it dispatches to a circle or rounded-rect
outline, offset inward by `off`. New geometry that needs to work for both
shapes should go through `ring()` rather than branching on `p.shape`
directly.

**Print orientation vs. assembled orientation**: lids for `hinged`/`snap`/
`thread` styles are modeled in *assembled* position (features hanging below
the z=0 plate), then `printOriented()` flips them 180° about X for the STL
export so they print flat with the plate on the bed. When adding a new lid
style, decide up front whether it's modeled assembled (needs
`printOriented` support) or already print-flat (like `screw`/`slide`).

**Removable side plates** (rect shape only, not compatible with `slide`):
this is the most recently added subsystem and has its own three-stage
pipeline:
1. `rectNotchedPieces()` splits a wall ring into separate polygons at each
   side's opening, walking the ring CCW and clamping opening width so it
   never eats into the rounded corners.
2. `wallBandWithCuts()` calls it per-side at *different heights* — each of
   N/E/S/W can have its own opening depth, so a wall band is horizontally
   split at every distinct cut height and notched only on the sides whose
   opening reaches that far down.
3. `buildPlateRails()` adds the printed-in-place L-rail channels; the plate
   itself is a separate part (`plateFlatGeoms()`), previewed in assembled
   position (`buildPlatesAssembled()`) and exported laid out flat
   (`buildPlatesPrint()`) via its own STL button.
   Per-side plate style (`solid`/`flush`/`vent`/`holes`) all share the same
   base plate; non-`solid` styles add a raised pad that fills the opening
   flush with the outer wall, with any vent slots/holes cut through both
   the plate and the pad.

**Validation is advisory, not blocking**: `validate(p)` never mutates
geometry or prevents a build — it only returns strings rendered as
`.warn` divs. Geometry-side clamping (corner radius, opening width, etc.)
must happen independently in the builder functions; don't rely on
`validate()` running first.

**STL export** (`geomsToSTL`) triangulates every `BufferGeometry` (calling
`toNonIndexed()` as needed) and writes a standard 84-byte-header binary STL
buffer directly — no external STL library.

## Deployment

Live at **https://box-generator-3pl.pkroaming.com** (custom domain) and
**https://box-generator-3pl.pages.dev**, hosted on Cloudflare Pages (account
`Pakornpiam@gmail.com`, project `box-generator`).

Auto-deploy runs through **GitHub Actions**, not Cloudflare's native git
integration: [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
triggers on every push to `main` (plus manual `workflow_dispatch`), stages the
three static files into `dist/`, and runs `wrangler pages deploy`. So **pushing
to `main` publishes the site** — no build step, no manual deploy.

- The Cloudflare Pages project is **direct-upload** type (the Actions workflow
  uploads to it). It is deliberately not git-connected: a direct-upload project
  can't be converted, creating a git-connected project via API doesn't wire the
  push-event trigger, and the dashboard Connect-to-Git flow was unreliable here.
  If you ever migrate to native integration, it must be done via the Cloudflare
  dashboard, and the custom domain re-attached afterward.
- Required repo secrets (Settings → Secrets → Actions): `CLOUDFLARE_API_TOKEN`
  (scoped **Account · Cloudflare Pages · Edit**) and `CLOUDFLARE_ACCOUNT_ID`.
- The custom domain routes via a proxied CNAME `box-generator` →
  `box-generator-3pl.pages.dev` in the `pkroaming.com` Cloudflare zone.
- Cloudflare edge-caches the HTML, so after a deploy the production URL can lag
  briefly; append a `?cb=<random>` query to bypass it when verifying.

## Git Rules (Important — Follow every time)

- Do not work directly on the `master` branch; always create a new branch.
- Branch naming convention: `feature/<short-name>` or `fix/<short-name>`.
- Use the Conventional Commits format for commit messages: `feat:` (new
  feature) / `fix:` (bug fix) / `refactor:` (code restructuring) / `test:`
  (adding/updating tests) / `docs:` (documentation updates).
- 1 commit = 1 task (atomic); do not bundle multiple changes into a single
  commit.
- PR descriptions must include 3 sections: What (what was done) / Why
  (reason for the change) / Test plan (how it was tested).
