import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// Heat-set insert presets (common brass inserts, e.g. Ruthex / CNC-Kitchen)
// holeD: insert hole diameter, len: insert length, clearD: screw clearance
// hole, headD: counterbore for socket-cap head, headH: head height
// ---------------------------------------------------------------------------
const INSERTS = {
  'M2':   { holeD: 3.2, len: 4.0, clearD: 2.4, headD: 4.4, headH: 2.0 },
  'M2.5': { holeD: 3.5, len: 5.7, clearD: 2.9, headD: 5.1, headH: 2.5 },
  'M3':   { holeD: 4.0, len: 5.7, clearD: 3.4, headD: 6.1, headH: 3.0 },
  'M4':   { holeD: 5.6, len: 8.1, clearD: 4.5, headD: 7.6, headH: 4.0 },
  'M5':   { holeD: 6.4, len: 9.5, clearD: 5.5, headD: 9.1, headH: 5.0 },
};
const SCREW_LENGTHS = [4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30];

// snap-lock constants: groove band on inner wall + matching ridge on lid skirt
const SNAP = { grooveTop: 1.7, grooveBot: 3.5, grooveD: 0.6, bump: 0.5, skirtT: 1.8 };
// hinge constants: pin axis sits on the box-top plane so both knuckles print
// flat; box knuckles are held by 45° gussets (no support needed)
const HINGE = { kR: 4, pinR: 1.1, gap: 0.3, lidKR: 3 };

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// 2D path helpers (all geometry is built Z-up, mm units)
// ---------------------------------------------------------------------------
function roundedRectPts(w, d, r) {
  const hw = w / 2, hd = d / 2;
  r = Math.min(Math.max(r, 0.01), hw - 0.01, hd - 0.01);
  const pts = [];
  const seg = 12;
  const corners = [
    [hw - r, hd - r, 0],
    [-hw + r, hd - r, Math.PI / 2],
    [-hw + r, -hd + r, Math.PI],
    [hw - r, -hd + r, 1.5 * Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  }
  return pts;
}

function circlePts(cx, cy, r) {
  const pts = [];
  const seg = 48;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * 2 * Math.PI;
    pts.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return pts;
}

// Circle of radius R with a smooth rounded (half-round) valley cut inward at each
// groove — used for engraved vertical lines on the cylinder wall (no CSG; the
// recess is part of the extrude profile). Each groove = {a: center angle,
// halfAng: half angular width, depth: radial depth}. The radius follows a
// raised-cosine valley: full depth at the center, tangent to the surface at both
// edges, so the flute has no sharp corners.
function engravedCircle(R, grooves) {
  const seg = 128;
  const twoPi = 2 * Math.PI;
  const norm = a => ((a % twoPi) + twoPi) % twoPi;
  const radiusAt = ang => {
    let r = R;
    for (const g of grooves) {
      let d = ang - g.a;
      d = Math.atan2(Math.sin(d), Math.cos(d));       // signed shortest diff
      if (Math.abs(d) < g.halfAng) {
        const t = d / g.halfAng;                      // -1..1 across the groove
        r = Math.min(r, R - g.depth * 0.5 * (1 + Math.cos(Math.PI * t)));
      }
    }
    return r;
  };
  const angles = [];
  for (let i = 0; i < seg; i++) angles.push(norm(i / seg * twoPi));
  for (const g of grooves) {                          // denser sampling inside grooves
    const sub = Math.max(12, Math.ceil((2 * g.halfAng) / (twoPi / seg)) + 6);
    for (let i = 0; i <= sub; i++) angles.push(norm(g.a - g.halfAng + (2 * g.halfAng) * i / sub));
  }
  angles.sort((a, b) => a - b);
  const pts = [];
  let prev = -1;
  for (const a of angles) {
    if (a - prev < 1e-6) continue;
    prev = a;
    const r = radiusAt(a);
    pts.push(new THREE.Vector2(r * Math.cos(a), r * Math.sin(a)));
  }
  return pts;
}

function rectPts(x0, y0, x1, y1) {
  return [
    new THREE.Vector2(x0, y0), new THREE.Vector2(x1, y0),
    new THREE.Vector2(x1, y1), new THREE.Vector2(x0, y1),
  ];
}

// Inward perimeter offset of a quarter-round edge fillet of radius fr, at
// distance h from the filleted face (h in [0, fr]): 0 at the face edge → fr at
// depth fr... note: here we return the INSET (how far in from full width) as a
// function of h measured from the FULL-width plane. See filletBand for use.
function filletInset(fr, h) {
  const g = fr - h;
  return fr - Math.sqrt(Math.max(fr * fr - g * g, 0));
}

// Smooth quarter-round fillet band as a closed BufferGeometry (no stepping).
// A closed cross-section profile — inner wall (offset fr) up, radial top cap to
// full width, and the quarter-round outer surface back down to the face — is
// swept around the closed perimeter ring(p, off). Closed profile × closed path =
// watertight torus (no caps/seams). dir +1 fillets the bottom edge (band above
// faceZ); dir -1 the top edge. The inner wall at offset fr meets a core inset fr.
function filletBand(p, fr, faceZ, dir) {
  const segs = Math.max(8, Math.ceil(fr / 0.2));
  // cross-section boundary as (offset from full width, height above face)
  const prof = [[fr, 0], [fr, fr], [0, fr]];
  for (let s = segs - 1; s >= 1; s--) {
    const h = fr * s / segs;
    prof.push([filletInset(fr, h), h]);   // quarter-round outer, top→face
  }
  const K = prof.length;
  const rings = prof.map(([off]) => ring(p, off));   // perimeter loop per profile pt
  const m = rings[0].length;
  const pos = [];
  const V = (k, i) => { const v = rings[k][i]; return [v.x, v.y, faceZ + dir * prof[k][1]]; };
  const tri = (A, B, C) => pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
  for (let k = 0; k < K; k++) {
    const kp = (k + 1) % K;
    for (let i = 0; i < m; i++) {
      const ip = (i + 1) % m;
      // wind so normals face outward (verified by enclosed-volume sign)
      if (dir > 0) { tri(V(k, i), V(kp, ip), V(k, ip)); tri(V(k, i), V(kp, i), V(kp, ip)); }
      else { tri(V(k, i), V(k, ip), V(kp, ip)); tri(V(k, i), V(kp, ip), V(kp, i)); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// A filleted slab z=0..H with the outer edge rounded on one side: a core inset by
// fr (carrying any holes), a hole-less straight outer rim, and the smooth
// filletBand. edge 'bottom' rounds the z=0 edge, 'top' rounds the z=H edge.
function filletedSlab(p, fr, H, holesAt, boundaries, edge) {
  const out = [];
  const zs = [0, ...boundaries.filter(z => z > 0.01 && z < H - 0.01).sort((a, b) => a - b), H];
  for (let i = 0; i + 1 < zs.length; i++) {
    const za = zs[i], zb = zs[i + 1];
    out.push(extrude(ring(p, fr), holesAt((za + zb) / 2), za, zb - za));  // core (inset fr)
  }
  if (edge === 'bottom') {
    if (H > fr + 0.01) out.push(extrude(ring(p, 0), [ring(p, fr)], fr, H - fr)); // rim above
    out.push(filletBand(p, fr, 0, +1));
  } else {
    if (H > fr + 0.01) out.push(extrude(ring(p, 0), [ring(p, fr)], 0, H - fr)); // rim below
    out.push(filletBand(p, fr, H, -1));
  }
  return out;
}

// U-shaped rail ring (open at front, y = -sy/2) for the slide-lid grooves.
// r must not exceed railW or the inner edge would cut the corner arcs.
function uShapePts(sx, sy, railW, r) {
  const hx = sx / 2, hy = sy / 2;
  r = Math.min(Math.max(r, 0.01), railW, hx - 0.01, hy - 0.01);
  const pts = [];
  const seg = 10;
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (a1 - a0);
      pts.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  };
  arc(hx - r, -hy + r, -Math.PI / 2, 0);       // outer front-right
  arc(hx - r, hy - r, 0, Math.PI / 2);         // outer back-right
  arc(-hx + r, hy - r, Math.PI / 2, Math.PI);  // outer back-left
  arc(-hx + r, -hy + r, Math.PI, 1.5 * Math.PI); // outer front-left
  pts.push(new THREE.Vector2(-hx + railW, -hy));       // inner front-left
  pts.push(new THREE.Vector2(-hx + railW, hy - railW)); // inner back-left
  pts.push(new THREE.Vector2(hx - railW, hy - railW));  // inner back-right
  pts.push(new THREE.Vector2(hx - railW, -hy));         // inner front-right
  return pts;
}

// Extrude a shape (outer pts + hole pts arrays) from z0 upward by depth.
function extrude(outerPts, holePtsArr, z0, depth) {
  const shape = new THREE.Shape(outerPts);
  for (const h of holePtsArr) shape.holes.push(new THREE.Path(h));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
  g.translate(0, 0, z0);
  return g;
}

// Cylinder along +X from x0, length len, centered at (cy, cz), optional axial hole.
function cylinderX(x0, len, cy, cz, r, holeR = 0) {
  const holes = holeR > 0 ? [circlePts(0, 0, holeR)] : [];
  const g = extrude(circlePts(0, 0, r), holes, 0, len);
  g.rotateY(Math.PI / 2);
  g.translate(x0, cy, cz);
  return g;
}

// Extrude a (y,z) profile polygon along +X from x0 for len.
function profileX(x0, len, yzPts) {
  const pts = yzPts.map(([y, z]) => new THREE.Vector2(-z, y));
  const g = extrude(pts, [], 0, len);
  g.rotateY(Math.PI / 2);
  g.translate(x0, 0, 0);
  return g;
}

// Helical thread as a closed triangular coil (its own solid; overlaps the wall
// it sits on so the slicer fuses them — same no-CSG approach as the bosses).
// baseR = radius at the wall surface, crestR = tip radius:
//   crestR > baseR → external/outward thread (on a body neck)
//   crestR < baseR → internal/inward thread (in a lid skirt)
// The ~45° triangular flanks are self-supporting, so threads print upright
// without supports. Right-handed for both parts, so they mate.
function buildThreadCoil(baseR, crestR, z0, z1, pitch, width) {
  const turns = Math.max((z1 - z0) / pitch, 0.1);
  const segs = Math.max(8, Math.ceil(turns * 48));
  const A = 2 * Math.PI * turns;
  const P = (r, th, z) => [r * Math.cos(th), r * Math.sin(th), z];
  const secs = [];
  for (let i = 0; i <= segs; i++) {
    const th = A * i / segs;
    const zc = z0 + (z1 - z0) * i / segs;
    secs.push({
      lo: P(baseR, th, zc - width / 2),
      hi: P(baseR, th, zc + width / 2),
      cr: P(crestR, th, zc),
    });
  }
  const pos = [];
  const tri = (a, b, c) => pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  for (let i = 1; i < secs.length; i++) {
    const a = secs[i - 1], b = secs[i];
    tri(a.lo, a.hi, b.hi); tri(a.lo, b.hi, b.lo);   // base (against wall)
    tri(a.hi, a.cr, b.cr); tri(a.hi, b.cr, b.hi);   // upper flank
    tri(a.cr, a.lo, b.lo); tri(a.cr, b.lo, b.cr);   // lower flank
  }
  const s0 = secs[0], s1 = secs[secs.length - 1];
  tri(s0.hi, s0.lo, s0.cr);   // end caps
  tri(s1.lo, s1.hi, s1.cr);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Read + validate parameters
// ---------------------------------------------------------------------------
function readParams() {
  const p = {
    shape: $('shape').value,
    diameter: +$('diameter').value,
    sizeX: +$('sizeX').value,
    sizeY: +$('sizeY').value,
    height: +$('height').value,
    wall: +$('wall').value,
    floor: +$('floor').value,
    cradius: +$('cradius').value,
    lidT: +$('lidT').value,
    style: $('lidStyle').value,
    fitClr: +$('fitClr').value,
    counterbore: $('counterbore').checked,
    insert: $('insert').value,
    holeD: +$('holeD').value,
    holeDepth: +$('holeDepth').value,
    clearD: +$('clearD').value,
    headD: +$('headD').value,
    bossWall: +$('bossWall').value,
    threadPitch: +$('threadPitch').value,
    threadTurns: +$('threadTurns').value,
    plateT: +$('plateT').value,
  };
  // removable side plates: each wall has its own on/off + opening width/depth
  p.sideCfg = {};
  for (const [s, name] of [['N', 'North'], ['E', 'East'], ['S', 'South'], ['W', 'West']]) {
    p.sideCfg[s] = {
      on: $('cut' + name).checked,
      w: +$('width' + name).value,
      d: +$('depth' + name).value,
      style: $('style' + name).value,
      holeD: +$('holeD' + name).value,
      holesX: Math.round(+$('holesX' + name).value),
      holesY: Math.round(+$('holesY' + name).value),
      offX: +$('offX' + name).value,
      offY: +$('offY' + name).value,
    };
  }
  // per-shape valid lid styles: slide rails and the flat-back hinge can't wrap
  // a round wall; the helical thread only makes sense on a cylinder
  if (p.shape === 'cyl') {
    if (p.style === 'slide' || p.style === 'hinged') p.style = 'snap';
  } else if (p.style === 'thread') {
    p.style = 'screw';
  }
  // bounding footprint: cylinders are square in X/Y at the diameter
  p.spanX = p.shape === 'cyl' ? p.diameter : p.sizeX;
  p.spanY = p.shape === 'cyl' ? p.diameter : p.sizeY;
  // side-plate openings: rect walls only; the slide style's rails can't be cut
  p.cutsActive = p.shape === 'rect' && p.style !== 'slide'
    && Object.values(p.sideCfg).some(c => c.on && c.d > 0);
  p.zCutS = {};
  for (const s of ['N', 'E', 'S', 'W']) {
    p.zCutS[s] = Math.max(p.height - p.sideCfg[s].d, p.floor);
  }
  // thread style: reduced-diameter neck carries the external thread; the cap
  // skirt (outer = body Ø, flush) threads internally over it
  p.td = Math.min(0.5 * p.threadPitch, 1.6);        // radial thread depth
  p.threadW = 0.7 * p.threadPitch;                  // axial ridge width
  p.threadClr = p.fitClr + 0.15;                    // radial fit gap
  p.neckR = p.diameter / 2 - p.wall - p.td - p.threadClr;
  // inner shoulder narrows by this much; 45° staircase keeps it support-free
  p.transIn = p.wall + p.td + p.threadClr;
  p.transSteps = Math.max(2, Math.ceil(p.transIn / 0.45));
  p.transH = p.transSteps * 0.45;
  const maxLen = p.height - p.floor - p.transH - 3 - (p.threadW + 1.3);
  p.threadLen = Math.max(Math.min(p.threadTurns * p.threadPitch, maxLen), 2);
  p.neckH = p.threadLen + p.threadW + 1.3;
  p.zShoulder = p.height - p.neckH;                 // full body ends here
  p.zTrans = p.zShoulder - p.transH;                // inner staircase starts here
  // screw style
  p.bossR = p.holeD / 2 + p.bossWall;
  p.bossCX = p.spanX / 2 - p.wall - p.bossR + 0.3;
  p.bossCY = p.spanY / 2 - p.wall - p.bossR + 0.3;
  p.bossH = p.height - p.floor;
  p.headH = INSERTS[p.insert].headH;
  // slide style (groove ceiling is a 3-step staircase: 1.2 mm of transition
  // plus a 2 mm full lip above, so nothing overhangs more than ~0.4 mm)
  p.grooveD = Math.min(1.6, Math.max(p.wall - 1.2, 0.8));
  p.slideGz1 = p.height - 3.2;
  p.slideGz0 = p.slideGz1 - (p.lidT + 0.3);
  // hinged style
  p.hingeL = Math.max(Math.min(p.spanX - 2 * (p.shape === 'cyl' ? 0 : p.cradius) - 6, 50), 16);
  // body engraving (cylinder only): N evenly-spaced vertical grooves cut into
  // the outer wall between engZ0 and engZ1. Thread style limits the top to the
  // full-diameter body (below the neck transition).
  p.engrave = p.shape === 'cyl' && $('engrave').checked;
  p.engCount = Math.round(+$('engCount').value);
  p.engWidth = +$('engWidth').value;
  p.engDepth = +$('engDepth').value;
  p.engLength = +$('engLength').value;
  p.engBottom = +$('engBottom').value;
  const engTop = p.style === 'thread' ? p.zTrans : p.height;
  p.engZ0 = Math.max(p.floor + p.engBottom, p.floor + 0.5);
  p.engZ1 = Math.min(p.engZ0 + p.engLength, engTop - 0.5);
  const engR = p.diameter / 2;
  p.engDepthEff = Math.min(p.engDepth, p.wall - 0.8);
  p.engHalfAng = Math.min((p.engWidth / 2) / engR, Math.PI / p.engCount - 0.03);
  p.engActive = p.engrave && p.engCount >= 1 && p.engWidth > 0 && p.engDepthEff > 0.05
    && p.engHalfAng > 0.005 && p.engZ1 > p.engZ0 + 0.5;
  p.engGrooves = p.engActive
    ? [...Array(p.engCount)].map((_, i) => ({ a: i * 2 * Math.PI / p.engCount, halfAng: p.engHalfAng, depth: p.engDepthEff }))
    : [];
  // rounded ends: depth eases 0→D→0 over these heights. Top = 1.6·depth keeps the
  // raised-cosine ceiling slope ≤ 45° (support-free); bottom matches for symmetry.
  p.engRoundTop = 1.6 * p.engDepthEff;
  p.engRoundBot = 1.6 * p.engDepthEff;
  const engLen = p.engZ1 - p.engZ0;
  if (p.engRoundTop + p.engRoundBot > engLen) {
    const k = engLen / (p.engRoundTop + p.engRoundBot);
    p.engRoundTop *= k; p.engRoundBot *= k;
  }
  // edge fillets: round-over on the lid top edge and the body bottom edge.
  const fmax = Math.min(p.spanX, p.spanY) / 2 - p.wall - 1;   // never exceed the part
  p.filletTopReq = +$('filletTop').value;
  p.filletBotReq = +$('filletBot').value;
  p.filletTop = Math.max(0, Math.min(p.filletTopReq, p.lidT - 0.8, fmax));
  p.filletBot = Math.max(0, Math.min(p.filletBotReq, p.floor, fmax));  // stays in the solid floor
  return p;
}

// Outer perimeter of the box/lid, offset inward by `off` mm (parallel offset).
// Rectangular → rounded rect; cylindrical → circle. Used for walls, grooves,
// skirts and rails so every style works for both shapes from one definition.
function ring(p, off, crOverride) {
  if (p.shape === 'cyl') {
    return circlePts(0, 0, p.diameter / 2 - off);
  }
  const cr = crOverride ?? p.crEff ?? p.cradius;
  return roundedRectPts(p.spanX - 2 * off, p.spanY - 2 * off, Math.max(cr - off, 0.01));
}

// Removable side-plate rails: lipT = rail lip thickness, legW = standoff leg
// width, gapClr = plate-face clearance, sideClr = plate-edge clearance,
// lap = how far the plate overlaps the wall past the opening, cover = how far
// the lip covers the plate edge.
const RAIL = { lipT: 1.6, legW: 1.8, gapClr: 0.25, sideClr: 0.3, lap: 3, cover: 2.5 };

// Effective opening half-width on one side after clamping away from the
// corners (0 = side too short to cut).
function sideCutHalfWidth(p, side) {
  const B = side === 'N' || side === 'S' ? p.spanX / 2 : p.spanY / 2;
  const cr = Math.min(Math.max(p.crEff ?? p.cradius, 0.01), p.spanX / 2 - 0.01, p.spanY / 2 - 0.01);
  const ri = Math.max(cr - p.wall, 0.01);
  const u = Math.min(p.sideCfg[side].w / 2, B - cr - 0.2, B - p.wall - ri - 0.2);
  return u >= 1 ? u : 0;
}

// Per-side data for the removable plates. th rotates the local frame
// (+x = outward normal of the East wall) onto each side's wall.
function plateSideData(p) {
  const out = [];
  if (!p.cutsActive) return out;
  const order = { E: 0, N: 1, W: 2, S: 3 };
  for (const side of ['N', 'E', 'S', 'W']) {
    if (!p.sideCfg[side].on || p.sideCfg[side].d <= 0) continue;
    const u = sideCutHalfWidth(p, side);
    if (!u) continue;
    const A = side === 'E' || side === 'W' ? p.spanX / 2 : p.spanY / 2;
    const B = side === 'N' || side === 'S' ? p.spanX / 2 : p.spanY / 2;
    const zBot = Math.max(p.zCutS[side] - RAIL.lap, p.floor + 0.4);
    out.push({ side, th: order[side] * Math.PI / 2, u, pw: u + RAIL.lap, A, B, zBot, ph: p.height - zBot });
  }
  return out;
}

// Vertical slide-in channels flanking each opening: the plate is captured
// between the wall's inner face and an L-rail lip, open at the rim so the
// plate drops in from the top and lifts out. A block under each channel
// stops the plate at its seated depth. All pieces overlap the wall slightly
// so the slicer fuses them (same no-CSG approach as the bosses).
function buildPlateRails(p) {
  const geoms = [];
  const t = p.wall, g = p.plateT + 2 * RAIL.gapClr;
  for (const d of plateSideData(p)) {
    const xIn = d.A - t;                 // wall inner face
    const x0 = xIn - g - RAIL.lipT;      // rail's innermost face
    const z0 = Math.max(d.zBot - 3, p.floor);
    const add = (xa, ya, xb, yb, za, zb) => {
      const geo = extrude(rectPts(xa, Math.min(ya, yb), xb, Math.max(ya, yb)), [], za, zb - za);
      geo.rotateZ(d.th);
      geoms.push(geo);
    };
    for (const s of [1, -1]) {
      const yEdge = s * (d.pw + RAIL.sideClr);
      const yOut = s * (d.pw + RAIL.sideClr + RAIL.legW);
      const yIn = s * (d.pw - RAIL.cover);
      add(x0, yEdge, xIn + 0.3, yOut, z0, p.height);          // standoff leg
      add(x0, yIn, x0 + RAIL.lipT, yOut, z0, p.height);       // lip
      add(x0 + RAIL.lipT, yIn, xIn + 0.3, yEdge, z0, d.zBot); // bottom stop
    }
  }
  return geoms;
}

// One plate in flat/print orientation: x = width (centered), y = height
// (0 at plate bottom), z = thickness (0 = inner face). Styles:
//   solid — plain plate riding in the rails
//   flush — plate plus a raised pad that fills the opening flush with the
//           outer wall (prints as a pad on top, no supports)
//   vent  — flush pad with vertical ventilation slots through plate + pad
//   holes — flush pad with a grid of round holes (size / count / offset)
function plateFlatGeoms(p, d) {
  const cfg = p.sideCfg[d.side];
  const yOp0 = Math.max(p.zCutS[d.side] - d.zBot, 0); // opening bottom, plate coords
  const holes = [];
  if (cfg.style === 'vent') {
    const m = 1.5, slotW = 3, rib = 2.5;
    const W = 2 * (d.u - m), H = d.ph - yOp0 - 2 * m;
    if (W > slotW && H > 3) {
      const n = Math.max(1, Math.floor((W + rib) / (slotW + rib)));
      const total = n * slotW + (n - 1) * rib;
      for (let i = 0; i < n; i++) {
        const x0 = -total / 2 + i * (slotW + rib);
        holes.push(rectPts(x0, yOp0 + m, x0 + slotW, yOp0 + m + H));
      }
    }
  }
  if (cfg.style === 'holes') {
    const r = cfg.holeD / 2;
    const W = 2 * (d.u - 1.5), H = d.ph - yOp0 - 3;
    for (let i = 0; i < cfg.holesX; i++) {
      for (let j = 0; j < cfg.holesY; j++) {
        const cx = (cfg.holesX > 1 ? -W / 2 + W * i / (cfg.holesX - 1) : 0) + cfg.offX;
        const cy = yOp0 + 1.5 + (cfg.holesY > 1 ? H * j / (cfg.holesY - 1) : H / 2) + cfg.offY;
        // drop holes that would leave the pad area (they must pierce both
        // the plate and the pad cleanly)
        if (cx - r < -(d.u - 0.7) || cx + r > d.u - 0.7 || cy - r < yOp0 + 0.7 || cy + r > d.ph - 0.8) continue;
        holes.push(circlePts(cx, cy, r));
      }
    }
  }
  const geoms = [extrude(rectPts(-d.pw, 0, d.pw, d.ph), holes, 0, p.plateT)];
  if (cfg.style !== 'solid') {
    // raised pad filling the opening flush with the outer wall; the same
    // slots/holes continue through it (all lie inside the pad footprint)
    geoms.push(extrude(rectPts(-(d.u - 0.3), yOp0 + 0.3, d.u - 0.3, d.ph), holes, p.plateT, p.wall + RAIL.gapClr));
  }
  return geoms;
}

// The plates in assembled position (seated in their rails). The flat plate is
// stood up by the cyclic axis swap (x,y,z) → (z,x,y): rotateY then rotateX.
function buildPlatesAssembled(p) {
  const out = [];
  for (const d of plateSideData(p)) {
    const xOut = d.A - p.wall - RAIL.gapClr;
    for (const g of plateFlatGeoms(p, d)) {
      g.rotateY(Math.PI / 2);
      g.rotateX(Math.PI / 2);
      g.translate(xOut - p.plateT, 0, d.zBot);
      g.rotateZ(d.th);
      out.push(g);
    }
  }
  return out;
}

// The plates laid flat side by side for printing/export.
function buildPlatesPrint(p) {
  const out = [];
  let xoff = 0;
  for (const d of plateSideData(p)) {
    for (const g of plateFlatGeoms(p, d)) {
      g.translate(xoff + d.pw, 0, 0);
      out.push(g);
    }
    xoff += 2 * d.pw + 5;
  }
  return out;
}

// Cross-section pieces of the rectangular wall ring with a centered notch
// removed on each side listed in cutSides, at that side's own width. The ring
// is walked CCW (E side, NE arc, N side, … SE arc); every notch splits it, each
// remaining stretch becomes one simple polygon: outer trace forward + inner
// trace backward, closed by radial cut lines across the wall.
// innerOff = inward offset of the band's inner face (varies for snap bands).
// Returns an array of Vector2 loops, or null if no side ends up cut.
function rectNotchedPieces(p, innerOff, cutSides) {
  const hx = p.spanX / 2, hy = p.spanY / 2, w = innerOff;
  const cr = Math.min(Math.max(p.crEff ?? p.cradius, 0.01), hx - 0.01, hy - 0.01);
  const ri = Math.max(cr - w, 0.01);
  const seg = 12;
  const order = ['E', 'N', 'W', 'S'];
  // local frame per side k: +lx = outward normal, +ly = CCW walk direction
  const world = (k, lx, ly) => {
    const c = Math.cos(k * Math.PI / 2), s = Math.sin(k * Math.PI / 2);
    return new THREE.Vector2(lx * c - ly * s, lx * s + ly * c);
  };
  const chunks = [];
  let cur = { outer: [], inner: [] };
  let gaps = 0;
  for (let k = 0; k < 4; k++) {
    const A = k % 2 === 0 ? hx : hy;   // distance to this wall
    const B = k % 2 === 0 ? hy : hx;   // half-length of this wall
    const oExt = B - cr, iExt = B - w - ri;
    // main-wall clamp (sideCutHalfWidth) governs, so the opening lines up
    // across bands with different inner offsets and matches the plate width
    const u0 = cutSides[order[k]] ? sideCutHalfWidth(p, order[k]) : 0;
    const u = Math.min(u0, oExt - 0.2, iExt - 0.2);
    if (u >= 1) {
      cur.outer.push(world(k, A, -oExt), world(k, A, -u));
      cur.inner.push(world(k, A - w, -iExt), world(k, A - w, -u));
      chunks.push(cur);
      cur = {
        outer: [world(k, A, u), world(k, A, oExt)],
        inner: [world(k, A - w, u), world(k, A - w, iExt)],
      };
      gaps++;
    } else {
      cur.outer.push(world(k, A, -oExt), world(k, A, oExt));
      cur.inner.push(world(k, A - w, -iExt), world(k, A - w, iExt));
    }
    for (let i = 1; i <= seg; i++) { // corner arc after this side
      const a = (i / seg) * Math.PI / 2;
      cur.outer.push(world(k, A - cr + cr * Math.cos(a), B - cr + cr * Math.sin(a)));
      cur.inner.push(world(k, A - w - ri + ri * Math.cos(a), B - w - ri + ri * Math.sin(a)));
    }
  }
  if (!gaps) return null;
  // the walk is circular: the trailing stretch continues into the first one
  const first = chunks.shift();
  cur.outer.push(...first.outer);
  cur.inner.push(...first.inner);
  chunks.push(cur);
  return chunks.map(ch => {
    const pts = [...ch.outer, ...ch.inner.reverse()];
    const clean = pts.filter((q, i) => i === 0 || q.distanceTo(pts[i - 1]) > 1e-4);
    if (clean.length > 1 && clean[0].distanceTo(clean[clean.length - 1]) < 1e-4) clean.pop();
    return clean;
  });
}

// Extrude one wall band, split horizontally at every side's opening bottom so
// each sub-band is notched on exactly the sides whose opening reaches it.
// Falls back to a single plain ring band when no cut applies.
function wallBandWithCuts(p, outerPts, innerPts, innerOff, z0, z1) {
  const act = !p.cutsActive ? [] : ['N', 'E', 'S', 'W'].filter(s =>
    p.sideCfg[s].on && sideCutHalfWidth(p, s) > 0 && p.zCutS[s] < z1 - 0.01);
  if (!act.length) return [extrude(outerPts, [innerPts], z0, z1 - z0)];
  const levels = [...new Set(act.map(s => p.zCutS[s]))]
    .filter(z => z > z0 + 0.01 && z < z1 - 0.01)
    .sort((a, b) => a - b);
  const bounds = [z0, ...levels, z1];
  const out = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i], b = bounds[i + 1];
    const cutSides = {};
    let any = false;
    for (const s of act) if (p.zCutS[s] <= a + 0.01) { cutSides[s] = true; any = true; }
    const pieces = any ? rectNotchedPieces(p, innerOff, cutSides) : null;
    if (!pieces) { out.push(extrude(outerPts, [innerPts], a, b - a)); continue; }
    for (const poly of pieces) out.push(extrude(poly, [], a, b - a));
  }
  return out;
}

// Engraving depth at height z: a raised-cosine envelope over [engZ0, engZ1] —
// 0 at each end, easing to the full depth over engRoundBot/engRoundTop, flat in
// the middle. Gives the line rounded, tapered ends; the top rise is ≤45° so it
// prints support-free.
function engDepthAtZ(p, z) {
  const D = p.engDepthEff, z0 = p.engZ0, z1 = p.engZ1;
  if (z <= z0 || z >= z1) return 0;
  const rb = Math.min(p.engRoundBot, z1 - z0), rt = Math.min(p.engRoundTop, z1 - z0);
  if (rb > 0 && z < z0 + rb) return D * 0.5 * (1 - Math.cos(Math.PI * (z - z0) / rb));
  if (rt > 0 && z > z1 - rt) return D * 0.5 * (1 - Math.cos(Math.PI * (z1 - z) / rt));
  return D;
}

// Cylinder wall segment (inner radius innerR, from z0 to z1). Where it overlaps
// the engraved range [engZ0,engZ1], it is sliced at ~0.45 mm following the
// rounded depth envelope (engDepthAtZ); equal-depth slices are coalesced so the
// full-depth middle is one extrude and only the rounded ends are finely stepped.
function cylWallBands(p, innerR, z0, z1) {
  const R = p.diameter / 2;
  const inner = circlePts(0, 0, innerR);
  const plain = circlePts(0, 0, R);
  const g0 = Math.max(p.engZ0, z0), g1 = Math.min(p.engZ1, z1);
  if (!p.engActive || g1 <= g0 + 0.01) {
    return [extrude(plain, [inner], z0, z1 - z0)];
  }
  const band = (depth, za, zb) => extrude(
    depth < 0.03 ? plain : engravedCircle(R, p.engGrooves.map(g => ({ ...g, depth }))),
    [inner], za, zb - za);
  const out = [];
  if (g0 > z0 + 0.01) out.push(extrude(plain, [inner], z0, g0 - z0));
  // build 0.45 mm slices, then merge consecutive slices of (near-)equal depth
  const step = 0.45;
  const merged = [];
  for (let z = g0; z < g1 - 1e-6;) {
    const zb = Math.min(z + step, g1);
    const depth = engDepthAtZ(p, (z + zb) / 2);
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.depth - depth) < 1e-6) last.zb = zb;
    else merged.push({ za: z, zb, depth });
    z = zb;
  }
  for (const s of merged) out.push(band(s.depth, s.za, s.zb));
  if (z1 > g1 + 0.01) out.push(extrude(plain, [inner], g1, z1 - g1));
  return out;
}

function validate(p) {
  const warns = [];
  if (p.height <= p.floor + 4) warns.push('Box height must exceed floor thickness by at least 4 mm.');

  if (p.style === 'screw') {
    if (Math.min(p.bossCX, p.bossCY) - p.bossR < 1) {
      warns.push(`Box too small: the four Ø${(p.bossR * 2).toFixed(1)} mm bosses overlap in the middle. Increase box size or use a smaller insert.`);
    }
    if (p.holeDepth + 1.5 > p.bossH) {
      warns.push(`Box height too short for the ${p.insert} insert hole (needs ≥ ${(p.holeDepth + 1.5 + p.floor).toFixed(1)} mm total height). Hole depth was clamped.`);
    }
    if (p.counterbore && p.lidT - p.headH < 1.2) {
      warns.push(`Lid is thin for a counterbored ${p.insert} head — consider lid ≥ ${(p.headH + 1.5).toFixed(1)} mm.`);
    }
  }
  if (p.style === 'snap') {
    if (p.wall < 1.8) warns.push(`Snap groove needs wall ≥ 1.8 mm (only ${(p.wall - SNAP.grooveD).toFixed(1)} mm remains behind the groove).`);
    if (p.height - p.floor < 6) warns.push('Box too short for the snap skirt — increase height to at least floor + 6 mm.');
    if (p.spanX - 2 * p.wall - 2 * p.fitClr - 2 * SNAP.skirtT < 6 || p.spanY - 2 * p.wall - 2 * p.fitClr - 2 * SNAP.skirtT < 6) {
      warns.push('Box too small for the snap skirt ring.');
    }
  }
  if (p.style === 'slide') {
    if (p.wall < 2.0) warns.push('Slide grooves need wall ≥ 2.0 mm.');
    if (p.slideGz0 - p.floor < 3) warns.push('Box too short for the slide groove — increase height or use a thinner lid.');
    if (p.lidT > 3.5) warns.push('Slide lids work best at 2.5–3 mm thickness — thick lids make tall grooves.');
  }
  if (p.style === 'hinged') {
    if (p.spanX < 30) warns.push(`${p.shape === 'cyl' ? 'Diameter' : 'Box width'} ≥ 30 mm recommended for the hinge knuckles.`);
    if (p.lidT < 3) warns.push('Hinged lid needs thickness ≥ 3 mm so the Ø6 mm knuckle prints flush with the bed.');
    if (p.height < p.floor + 13.5) {
      warns.push(`Box height ≥ ${(p.floor + 13.5).toFixed(0)} mm recommended so the hinge gusset can keep its 45° support-free slope.`);
    }
  }
  if (p.cutsActive) {
    for (const side of ['N', 'E', 'S', 'W']) {
      if (p.sideCfg[side].on && !sideCutHalfWidth(p, side)) {
        warns.push(`${side} wall is too short for an opening between the corners — that side was skipped.`);
      }
    }
    for (const d of plateSideData(p)) {
      if (d.u < p.sideCfg[d.side].w / 2 - 0.01) {
        warns.push(`${d.side} opening width clamped to ${(2 * d.u).toFixed(1)} mm to clear the corners.`);
      }
      const railExt = d.pw + RAIL.sideClr + RAIL.legW;
      const cr = Math.min(Math.max(p.crEff ?? p.cradius, 0.01), p.spanX / 2 - 0.01, p.spanY / 2 - 0.01);
      if (railExt > d.B - Math.max(cr, p.wall) - 0.2) {
        warns.push(`${d.side} plate rails run into the corners — reduce the opening width by ~${(2 * (railExt - (d.B - Math.max(cr, p.wall) - 0.2))).toFixed(0)} mm.`);
      }
      if (p.style === 'screw') {
        const bossLat = d.side === 'E' || d.side === 'W' ? p.bossCY : p.bossCX;
        if (railExt > bossLat - p.bossR - 0.5) {
          warns.push(`${d.side} plate rails collide with the screw bosses — reduce the opening width or enlarge the box.`);
        }
      }
      if (p.zCutS[d.side] - RAIL.lap < p.floor + 0.4) {
        warns.push(`${d.side} opening is nearly full-height — its plate was shortened to keep the bottom stop above the floor.`);
      }
      const cfg = p.sideCfg[d.side];
      if (cfg.style === 'holes') {
        const W = 2 * (d.u - 1.5), H = d.ph - Math.max(p.zCutS[d.side] - d.zBot, 0) - 3;
        if (cfg.holesX > 1 && W / (cfg.holesX - 1) < cfg.holeD + 0.8) {
          warns.push(`${d.side} plate: hole columns overlap — reduce hole Ø or column count.`);
        }
        if (cfg.holesY > 1 && H / (cfg.holesY - 1) < cfg.holeD + 0.8) {
          warns.push(`${d.side} plate: hole rows overlap — reduce hole Ø or row count.`);
        }
        if (cfg.holeD + 2 > Math.min(W + 3, H + 3)) {
          warns.push(`${d.side} plate: hole Ø is too large for the opening — holes may be dropped.`);
        }
      }
    }
    if (p.style === 'snap') warns.push('Snap lid skirt overlaps the plate rails — the lid will not close. Use the screw lid with side plates.');
    if (p.style === 'hinged' && p.sideCfg.N.on) warns.push('North opening sits on the hinge wall — it may cut away the hinge gussets.');
    if (p.style === 'hinged' && p.sideCfg.S.on) warns.push('South plate rails collide with the hinged lid’s friction lip.');
  }
  if (p.style === 'thread') {
    if (2 * (p.neckR - p.wall) < 12) {
      warns.push(`Mouth opening is only Ø${Math.max(2 * (p.neckR - p.wall), 0).toFixed(1)} mm — increase the diameter for a usable threaded neck.`);
    }
    if (p.threadLen < p.threadTurns * p.threadPitch - 0.01) {
      warns.push('Thread length is capped by the box height — increase height or reduce pitch/turns for full engagement.');
    }
    if (p.zTrans - p.floor < 5) warns.push('Box too short for the neck + shoulder — most of the height is taken by the thread.');
  }
  if (p.engrave) {
    if (p.engDepth > p.wall - 0.8 + 0.001) {
      warns.push(`Engraving depth clamped to ${(p.wall - 0.8).toFixed(1)} mm to keep ≥ 0.8 mm of wall behind the groove.`);
    }
    if ((p.engWidth / 2) / (p.diameter / 2) > Math.PI / p.engCount - 0.03 + 0.001) {
      warns.push('Engraved lines are too wide for their count — width was clamped so the grooves don’t merge.');
    }
    const engTop = p.style === 'thread' ? p.zTrans : p.height;
    if (p.engZ0 + p.engLength > engTop - 0.5 + 0.001) {
      warns.push(`Engraving length clamped to ${(p.engZ1 - p.engZ0).toFixed(1)} mm to stay on the ${p.style === 'thread' ? 'body below the neck' : 'wall'}.`);
    }
    if (!p.engActive) warns.push('Engraving is inactive — check depth, width, length and bottom offset.');
  }
  if (p.filletBotReq > p.filletBot + 0.01) {
    warns.push(`Bottom fillet clamped to ${p.filletBot.toFixed(1)} mm (floor thickness) — increase floor for a larger radius.`);
  }
  if (p.filletTopReq > p.filletTop + 0.01) {
    warns.push(`Lid top fillet clamped to ${p.filletTop.toFixed(1)} mm by the lid thickness / box size.`);
  }
  if (p.filletTopReq > 0.1 && p.style === 'slide') {
    warns.push('Lid top fillet is ignored for the slide lid (its lid is a thin tongue, not a full plate).');
  }
  if (p.filletTop > 0.1 && (p.style === 'snap' || p.style === 'hinged' || p.style === 'thread')) {
    warns.push('Lid prints top-face-down, so its top fillet becomes a rounded bottom edge on the bed (still fine, no supports).');
  }
  if (p.filletBot > 0.1) {
    warns.push('Body bottom fillet overhangs the first layers slightly — small radii print cleanly; add a brim if a large one lifts.');
  }
  return warns;
}

// ---------------------------------------------------------------------------
// Part builders — return arrays of positioned BufferGeometries (Z-up, mm).
// The box is modeled in print = assembled orientation.
// Lids are modeled in ASSEMBLED orientation: local z=0 is the underside that
// touches the box rim, features (skirt, lip, knuckles) may extend below z=0.
// printOriented() flips styles that need it so they always print flat.
// ---------------------------------------------------------------------------
function bossCenters(p) {
  if (p.shape === 'cyl') {
    // four bosses on a diagonal square inscribed in the wall
    const rc = p.diameter / 2 - p.wall - p.bossR + 0.3;
    return [45, 135, 225, 315].map(d => {
      const a = d * Math.PI / 180;
      return [rc * Math.cos(a), rc * Math.sin(a)];
    });
  }
  return [
    [p.bossCX, p.bossCY], [-p.bossCX, p.bossCY],
    [-p.bossCX, -p.bossCY], [p.bossCX, -p.bossCY],
  ];
}

function hingeSegs(p) {
  const L = p.hingeL;
  const lidSegW = 0.34 * L;
  const boxSegW = (L - lidSegW) / 2 - 0.4;
  return {
    lidX0: -lidSegW / 2, lidSegW,
    boxX0s: [-L / 2, L / 2 - boxSegW], boxSegW,
    yAxis: p.spanY / 2 + HINGE.kR + HINGE.gap,
  };
}

function buildBox(p) {
  const geoms = [];
  let cr = p.cradius;
  if (p.style === 'slide') cr = Math.min(cr, Math.max(p.wall - p.grooveD, 0.3));
  p.crEff = cr;
  const outer = ring(p, 0);
  const inner = ring(p, p.wall);

  // floor — optionally with a smooth filleted bottom outer edge (fb ≤ floor, so
  // it stays inside the solid floor disc).
  if (p.filletBot > 0.1) geoms.push(...filletedSlab(p, p.filletBot, p.floor, () => [], [], 'bottom'));
  else geoms.push(extrude(outer, [], 0, p.floor)); // floor

  if (p.style === 'screw' || p.style === 'hinged') {
    if (p.shape === 'cyl') geoms.push(...cylWallBands(p, p.diameter / 2 - p.wall, p.floor, p.height));
    else geoms.push(...wallBandWithCuts(p, outer, inner, p.wall, p.floor, p.height));
  }

  if (p.cutsActive) geoms.push(...buildPlateRails(p));

  if (p.style === 'screw') {
    // corner bosses: solid base + annulus with blind insert hole at top
    const holeDepth = Math.min(p.holeDepth, p.bossH - 1.5);
    const baseH = p.bossH - holeDepth;
    for (const [cx, cy] of bossCenters(p)) {
      if (baseH > 0.01) {
        geoms.push(extrude(circlePts(cx, cy, p.bossR), [], p.floor, baseH));
      }
      geoms.push(extrude(
        circlePts(cx, cy, p.bossR),
        [circlePts(cx, cy, p.holeD / 2)],
        p.floor + baseH, holeDepth
      ));
    }
  }

  if (p.style === 'hinged') {
    // two outer knuckles behind the back wall, pin axis on the box-top plane.
    // Each knuckle is carried by a gusset whose underside slopes at 45°, and
    // whose above-rim portion stays 0.25 mm clear of the closed lid's edge.
    const hs = hingeSegs(p);
    const ywIn = p.spanY / 2 - 0.6;
    const yOut = p.spanY / 2 + 0.25;
    const yFar = hs.yAxis + HINGE.kR - 0.5;
    const zTop = p.height + 0.5;
    const zFarBot = p.height - HINGE.kR - 0.2;
    const zWallBot = Math.max(zFarBot - (yFar - ywIn), p.floor + 0.3);
    for (const x0 of hs.boxX0s) {
      geoms.push(profileX(x0, hs.boxSegW, [
        [ywIn, zWallBot], [yFar, zFarBot], [yFar, zTop],
        [yOut, zTop], [yOut, p.height], [ywIn, p.height],
      ]));
      geoms.push(cylinderX(x0, hs.boxSegW, hs.yAxis, p.height, HINGE.kR, HINGE.pinR));
    }
  }

  if (p.style === 'snap') {
    // wall in 3 bands: normal / groove (inner opening enlarged) / normal
    const gz1 = p.height - SNAP.grooveTop, gz0 = p.height - SNAP.grooveBot;
    const innerG = ring(p, p.wall - SNAP.grooveD);
    if (p.shape === 'cyl') {
      const R = p.diameter / 2;
      geoms.push(...cylWallBands(p, R - p.wall, p.floor, gz0));
      geoms.push(...cylWallBands(p, R - (p.wall - SNAP.grooveD), gz0, gz1));
      geoms.push(...cylWallBands(p, R - p.wall, gz1, p.height));
    } else {
      geoms.push(...wallBandWithCuts(p, outer, inner, p.wall, p.floor, gz0));
      geoms.push(...wallBandWithCuts(p, outer, innerG, p.wall - SNAP.grooveD, gz0, gz1));
      geoms.push(...wallBandWithCuts(p, outer, inner, p.wall, gz1, p.height));
    }
  }

  if (p.style === 'slide') {
    // full wall below the groove, then U-shaped rails (open front) for the
    // groove band; the retaining lip above returns to full wall through a
    // 3-step staircase so no step overhangs more than grooveD/3 (~0.4 mm)
    geoms.push(extrude(outer, [inner], p.floor, p.slideGz0 - p.floor));
    geoms.push(extrude(uShapePts(p.spanX, p.spanY, p.wall - p.grooveD, cr), [], p.slideGz0, p.slideGz1 - p.slideGz0));
    for (let k = 1; k <= 3; k++) {
      const railW = p.wall - p.grooveD * (3 - k) / 3;
      geoms.push(extrude(uShapePts(p.spanX, p.spanY, railW, cr), [], p.slideGz1 + (k - 1) * 0.4, 0.4));
    }
    geoms.push(extrude(uShapePts(p.spanX, p.spanY, p.wall, cr), [], p.slideGz1 + 1.2, p.height - p.slideGz1 - 1.2));
  }

  if (p.style === 'thread') {
    // jar-style: full-diameter body, then a reduced neck carrying the external
    // thread so the cap closes flush with the body. The inner bore narrows to
    // the neck through a 45° staircase (each step ≤ 0.45 mm — support-free).
    const R = p.diameter / 2, Rn = p.neckR;
    geoms.push(...cylWallBands(p, R - p.wall, p.floor, p.zTrans)); // full body wall (with engraving)
    for (let k = 1; k <= p.transSteps; k++) {
      const rIn = (R - p.wall) - p.transIn * k / p.transSteps;
      geoms.push(extrude(outer, [circlePts(0, 0, rIn)], p.zTrans + (k - 1) * 0.45, 0.45));
    }
    geoms.push(extrude(circlePts(0, 0, Rn), [circlePts(0, 0, Rn - p.wall)], p.zShoulder, p.height - p.zShoulder)); // neck
    const z1 = p.height - p.threadW / 2 - 0.5;
    const z0 = z1 - p.threadLen;
    geoms.push(buildThreadCoil(Rn, Rn + p.td, z0, z1, p.threadPitch, p.threadW));
  }

  return geoms;
}

// Lid plate from z=0..lidT with the top outer edge smoothly filleted by
// p.filletTop. holesAt(z) returns the hole polygons at height z (lets the screw
// counterbore vary); boundaries lists z where holesAt changes.
function filletedPlate(p, holesAt, lidT, boundaries = []) {
  if (p.filletTop > 0.1) return filletedSlab(p, p.filletTop, lidT, holesAt, boundaries, 'top');
  const out = [];
  const zs = [0, ...boundaries.filter(z => z > 0.01 && z < lidT - 0.01).sort((a, b) => a - b), lidT];
  for (let i = 0; i + 1 < zs.length; i++) {
    const za = zs[i], zb = zs[i + 1];
    out.push(extrude(ring(p, 0), holesAt((za + zb) / 2), za, zb - za));
  }
  return out;
}

function buildLid(p) {
  const geoms = [];
  const ix = p.spanX - 2 * p.wall, iy = p.spanY - 2 * p.wall;
  const outer = ring(p, 0);
  const c = p.fitClr;
  p.cbDepth = 0;

  if (p.style === 'screw') {
    const centers = bossCenters(p);
    const clearHoles = centers.map(([x, y]) => circlePts(x, y, p.clearD / 2));
    const cbDepth = p.counterbore ? Math.max(Math.min(p.headH + 0.4, p.lidT - 1.2), 0) : 0;
    if (cbDepth > 0.3) {
      const cbHoles = centers.map(([x, y]) => circlePts(x, y, p.headD / 2));
      const cbBoundary = p.lidT - cbDepth;
      geoms.push(...filletedPlate(p, z => z > cbBoundary ? cbHoles : clearHoles, p.lidT, [cbBoundary]));
    } else {
      geoms.push(...filletedPlate(p, () => clearHoles, p.lidT));
    }
    p.cbDepth = cbDepth;
  }

  if (p.style === 'hinged') {
    geoms.push(...filletedPlate(p, () => [], p.lidT)); // plate
    // center knuckle around the pin axis (on the lid's underside plane) plus
    // a chamfered arm; the chamfer keeps every arm point within the knuckle's
    // swing radius so the lid opens without hitting the box gussets
    const hs = hingeSegs(p);
    const chZ = Math.min(2.5, p.lidT - 0.5);
    geoms.push(profileX(hs.lidX0, hs.lidSegW, [
      [p.spanY / 2 - 2, 0], [hs.yAxis - 1, 0], [hs.yAxis + 2.1, chZ],
      [hs.yAxis + 2.1, p.lidT], [p.spanY / 2 - 2, p.lidT],
    ]));
    geoms.push(cylinderX(hs.lidX0, hs.lidSegW, hs.yAxis, 0, HINGE.lidKR, HINGE.pinR));
    // friction lip along the front inner wall
    const lipHalf = Math.max(ix / 2 - 6, 5);
    const yLip0 = -p.spanY / 2 + p.wall + c;
    geoms.push(extrude(rectPts(-lipHalf, yLip0, lipHalf, yLip0 + 1.6), [], -3, 3));
  }

  if (p.style === 'snap') {
    geoms.push(...filletedPlate(p, () => [], p.lidT)); // plate
    // skirt ring with a snap ridge that runs the full perimeter into the groove
    const skirtOuter = ring(p, p.wall + c);
    const skirtInner = ring(p, p.wall + c + SNAP.skirtT);
    const bumpOuter = ring(p, p.wall + c - SNAP.bump);
    const leadOuter = ring(p, p.wall + c - SNAP.bump / 2); // half-height step
    const skirtH = Math.min(5.5, p.height - p.floor - 1);
    geoms.push(extrude(skirtOuter, [skirtInner], -SNAP.grooveTop, SNAP.grooveTop));
    geoms.push(extrude(bumpOuter, [skirtInner], -SNAP.grooveBot, SNAP.grooveBot - SNAP.grooveTop));
    // lead-in step below the ridge so the lid centers itself when pressed in
    // (the ridge itself cantilevers only 0.5 mm in print — self-supporting)
    if (skirtH > SNAP.grooveBot + 0.5) {
      geoms.push(extrude(leadOuter, [skirtInner], -SNAP.grooveBot - 0.4, 0.4));
    }
    if (skirtH > SNAP.grooveBot + 0.9) {
      geoms.push(extrude(skirtOuter, [skirtInner], -skirtH, skirtH - SNAP.grooveBot - 0.4));
    }
  }

  if (p.style === 'slide') {
    // flat tongue plate, built in print orientation (z = 0..lidT)
    const w = ix + 2 * p.grooveD - 2 * c;
    const backY = p.spanY / 2 - p.wall + p.grooveD - c;
    geoms.push(extrude(rectPts(-w / 2, -p.spanY / 2, w / 2, backY), [], 0, p.lidT));
    // thumb ridge near the front edge for grip
    const rHalf = Math.min(8, ix / 2 - 3);
    if (rHalf > 3) {
      geoms.push(extrude(rectPts(-rHalf, -p.spanY / 2 + 2, rHalf, -p.spanY / 2 + 6), [], p.lidT, 1.2));
    }
  }

  if (p.style === 'thread') {
    // cap that screws over the neck, flush with the body: skirt outer = body Ø
    // and bore = neck crest + clearance (= body inner radius, so the skirt is
    // a seamless continuation of the body wall). Modeled assembled;
    // printOriented flips it plate-down to print.
    const R = p.diameter / 2, Rn = p.neckR;
    const valley = Rn + p.td + p.threadClr;  // = R - wall
    const skirtH = p.neckH - 0.3;            // stops just above the shoulder
    geoms.push(...filletedPlate(p, () => [], p.lidT));   // cap top (= circle R)
    geoms.push(extrude(circlePts(0, 0, R), [circlePts(0, 0, valley)], -skirtH, skirtH));
    const z1 = -0.8 - p.threadW / 2;
    const z0 = z1 - p.threadLen;
    geoms.push(buildThreadCoil(valley, valley - p.td, z0, z1, p.threadPitch, p.threadW));
    p.lidOutR = R;
  }

  return geoms;
}

// Hinged and snap lids are modeled with features hanging below the plate;
// flip them so they print flat with the plate on the bed and features up.
function printOriented(geoms, p) {
  if (p.style !== 'snap' && p.style !== 'hinged' && p.style !== 'thread') return geoms;
  return geoms.map(g => {
    const cg = g.clone();
    cg.rotateX(Math.PI);
    cg.translate(0, 0, p.lidT);
    return cg;
  });
}

// ---------------------------------------------------------------------------
// Binary STL export
// ---------------------------------------------------------------------------
function geomsToSTL(geoms) {
  let triCount = 0;
  const flats = geoms.map(g => {
    const ng = g.index ? g.toNonIndexed() : g;
    triCount += ng.attributes.position.count / 3;
    return ng;
  });
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, triCount, true);
  let off = 84;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const g of flats) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      ab.subVectors(b, a); ac.subVectors(c, a);
      n.crossVectors(ab, ac).normalize();
      for (const v of [n, a, b, c]) {
        dv.setFloat32(off, v.x, true);
        dv.setFloat32(off + 4, v.y, true);
        dv.setFloat32(off + 8, v.z, true);
        off += 12;
      }
      off += 2; // attribute byte count = 0
    }
  }
  return buf;
}

function download(buf, name) {
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
camera.position.set(110, 90, 110);

const renderer = new THREE.WebGLRenderer({ antialias: true });
viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 25, 0);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(80, 140, 60);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
fill.position.set(-80, 40, -60);
scene.add(fill);

const grid = new THREE.GridHelper(256, 32, 0x3a4250, 0x242a34);
scene.add(grid);

// display group is rotated so Z-up geometry renders Y-up
const boxGroup = new THREE.Group();
const lidGroup = new THREE.Group();
const plateGroup = new THREE.Group();
boxGroup.rotation.x = -Math.PI / 2;
lidGroup.rotation.x = -Math.PI / 2;
plateGroup.rotation.x = -Math.PI / 2;
scene.add(boxGroup, lidGroup, plateGroup);

const boxMat = new THREE.MeshStandardMaterial({ color: 0x2f9e8f, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
const lidMat = new THREE.MeshStandardMaterial({ color: 0xd98a3d, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
const plateMat = new THREE.MeshStandardMaterial({ color: 0x5b7fd4, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });

let boxGeoms = [], lidGeoms = [];
let currentParams = null;

function clearGroup(g) {
  while (g.children.length) {
    const m = g.children.pop();
    m.geometry.dispose();
  }
}

function styleInfo(p) {
  const cavH = p.style === 'slide' ? p.slideGz0 - p.floor
    : p.style === 'thread' ? p.zTrans - p.floor
    : p.height - p.floor;
  let html = p.shape === 'cyl'
    ? `Inner cavity: <b>Ø${(p.diameter - 2 * p.wall).toFixed(1)} × ${cavH.toFixed(1)} mm</b><br>`
    : `Inner cavity: <b>${(p.spanX - 2 * p.wall).toFixed(1)} × ${(p.spanY - 2 * p.wall).toFixed(1)} × ${cavH.toFixed(1)} mm</b><br>`;

  const plateStyleNames = { solid: 'solid', flush: 'flush plug', vent: 'vent grid', holes: 'custom holes' };
  for (const d of plateSideData(p)) {
    html += `Plate ${d.side} (${plateStyleNames[p.sideCfg[d.side].style]}): opening <b>${(2 * d.u).toFixed(0)} × ${(p.height - p.zCutS[d.side]).toFixed(0)} mm</b>, ` +
      `plate <b>${(2 * d.pw).toFixed(1)} × ${d.ph.toFixed(1)} × ${p.plateT} mm</b><br>`;
  }

  if (p.engActive) {
    html += `Engraving: <b>${p.engCount} lines</b>, <b>${p.engWidth.toFixed(1)} × ${p.engDepthEff.toFixed(1)} mm</b>, length <b>${(p.engZ1 - p.engZ0).toFixed(0)} mm</b><br>`;
  }
  if (p.filletTop > 0.1 && p.style !== 'slide') html += `Lid top fillet: <b>${p.filletTop.toFixed(1)} mm</b><br>`;
  if (p.filletBot > 0.1) html += `Body bottom fillet: <b>${p.filletBot.toFixed(1)} mm</b><br>`;

  if (p.style === 'screw') {
    const ins = INSERTS[p.insert];
    const grip = p.lidT - p.cbDepth;
    const needed = grip + Math.min(p.holeDepth, p.bossH - 1.5) - 1;
    const screwLen = SCREW_LENGTHS.find(l => l >= needed) ?? Math.ceil(needed);
    html +=
      `Boss: <b>Ø${(p.bossR * 2).toFixed(1)} mm</b> × 4, hole Ø${p.holeD.toFixed(1)} × ${Math.min(p.holeDepth, p.bossH - 1.5).toFixed(1)} mm deep<br>` +
      `Insert: <b>${p.insert}</b> (Ø${ins.holeD} × ${ins.len} mm)<br>` +
      `Suggested screw: <b>${p.insert} × ${screwLen} mm</b> socket cap`;
  } else if (p.style === 'hinged') {
    html +=
      `Hinge: <b>Ø${(HINGE.pinR * 2).toFixed(1)} mm pin hole</b> — use 1.75 mm filament or a nail as the pin<br>` +
      `Front lip holds the lid closed by friction (clearance ${p.fitClr.toFixed(2)} mm)<br>` +
      `45° gussets carry the knuckles — no supports; lid opens ≈120°`;
  } else if (p.style === 'snap') {
    html +=
      `Snap ridge: <b>${(SNAP.bump - p.fitClr).toFixed(2)} mm engagement</b> per side into a ${SNAP.grooveD} mm wall groove<br>` +
      `Press the lid down to click it shut; pry at a corner to open`;
  } else if (p.style === 'slide') {
    html +=
      `Lid slides in from the front on <b>${p.grooveD.toFixed(1)} mm grooves</b> (3 sides)<br>` +
      (p.crEff < p.cradius ? `Corner radius limited to ${p.crEff.toFixed(1)} mm by the rail width<br>` : '');
  } else if (p.style === 'thread') {
    const actTurns = p.threadLen / p.threadPitch;
    html +=
      `Neck: <b>Ø${(2 * p.neckR).toFixed(1)} mm</b>, mouth opening Ø${(2 * (p.neckR - p.wall)).toFixed(1)} mm<br>` +
      `Thread: <b>${p.threadPitch} mm pitch × ${actTurns.toFixed(1)} turns</b>, ${p.td.toFixed(1)} mm deep, clearance ${p.threadClr.toFixed(2)} mm<br>` +
      `Cap closes <b>flush with the body</b> (Ø${(2 * (p.lidOutR ?? 0)).toFixed(1)} mm) — no supports, no hardware`;
  }
  return html;
}

function rebuild() {
  const p = readParams();
  currentParams = p;

  // show only the size controls relevant to the shape
  const isCyl = p.shape === 'cyl';
  $('diaLabel').style.display = isCyl ? '' : 'none';
  $('sizeXLabel').style.display = isCyl ? 'none' : '';
  $('sizeYLabel').style.display = isCyl ? 'none' : '';
  $('cradiusLabel').style.display = isCyl ? 'none' : '';
  // slide rails and the flat-back hinge only work on a rectangular wall;
  // the helical thread only works on a cylinder
  document.querySelector('#lidStyle option[value="slide"]').disabled = isCyl;
  document.querySelector('#lidStyle option[value="hinged"]').disabled = isCyl;
  document.querySelector('#lidStyle option[value="thread"]').disabled = !isCyl;
  if ($('lidStyle').value !== p.style) $('lidStyle').value = p.style;

  // show only the controls relevant to the selected style
  const isScrew = p.style === 'screw';
  $('insertSection').style.display = isScrew ? '' : 'none';
  $('cbLabel').style.display = isScrew ? '' : 'none';
  $('fitClrLabel').style.display = isScrew ? 'none' : '';
  $('threadSection').style.display = p.style === 'thread' ? '' : 'none';
  $('cutoutSection').style.display = !isCyl && p.style !== 'slide' ? '' : 'none';
  for (const name of ['North', 'East', 'South', 'West']) {
    $('dims' + name).style.display = $('cut' + name).checked ? '' : 'none';
    $('holesCfg' + name).style.display = $('style' + name).value === 'holes' ? '' : 'none';
  }
  $('engraveSection').style.display = isCyl ? '' : 'none';
  $('engraveDims').style.display = $('engrave').checked ? '' : 'none';

  clearGroup(boxGroup);
  clearGroup(lidGroup);
  clearGroup(plateGroup);
  boxGeoms = buildBox(p);
  lidGeoms = buildLid(p);
  const warns = validate(p);
  for (const g of boxGeoms) boxGroup.add(new THREE.Mesh(g, boxMat));
  for (const g of lidGeoms) lidGroup.add(new THREE.Mesh(g, lidMat));
  for (const g of buildPlatesAssembled(p)) plateGroup.add(new THREE.Mesh(g, plateMat));
  $('dlPlate').disabled = plateGroup.children.length === 0;
  updateExplode();

  controls.target.set(0, p.height / 2, 0);

  $('info').innerHTML = styleInfo(p);
  $('warnings').innerHTML = warns.map(w => `<div class="warn">⚠ ${w}</div>`).join('');
}

function updateExplode() {
  const p = currentParams;
  const lift = +$('explode').value;
  if (p.style === 'slide') {
    // slide lid sits in the groove; explode pulls it out the front instead
    lidGroup.position.y = p.slideGz0 + 0.15;
    lidGroup.position.z = lift; // group is rotated: model -y (front) maps to +z
  } else {
    lidGroup.position.y = p.height + lift;
    lidGroup.position.z = 0;
  }
  plateGroup.position.y = lift; // plates slide up out of their rails
}

function applyInsertPreset() {
  const ins = INSERTS[$('insert').value];
  $('holeD').value = ins.holeD;
  $('holeDepth').value = (ins.len + 1).toFixed(1);
  $('clearD').value = ins.clearD;
  $('headD').value = ins.headD;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('insert').addEventListener('change', () => { applyInsertPreset(); rebuild(); });
$('lidStyle').addEventListener('change', rebuild);
$('shape').addEventListener('change', rebuild);
const plateIds = ['plateT'];
for (const name of ['North', 'East', 'South', 'West']) {
  for (const pre of ['cut', 'width', 'depth', 'style', 'holeD', 'holesX', 'holesY', 'offX', 'offY']) {
    plateIds.push(pre + name);
  }
}
for (const id of ['diameter', 'sizeX', 'sizeY', 'height', 'wall', 'floor', 'cradius', 'lidT', 'fitClr',
  'counterbore', 'holeD', 'holeDepth', 'clearD', 'headD', 'bossWall', 'threadPitch', 'threadTurns',
  'engrave', 'engCount', 'engWidth', 'engDepth', 'engLength', 'engBottom',
  'filletTop', 'filletBot',
  ...plateIds]) {
  $(id).addEventListener('input', rebuild);
}
$('explode').addEventListener('input', updateExplode);

const dims = p => p.shape === 'cyl' ? `dia${p.diameter}x${p.height}` : `${p.sizeX}x${p.sizeY}x${p.height}`;
const suffix = p => `${p.style}${p.style === 'screw' ? '_' + p.insert : ''}`;
$('dlBox').addEventListener('click', () => {
  const p = currentParams;
  download(geomsToSTL(boxGeoms), `box_${dims(p)}_${suffix(p)}.stl`);
});
$('dlLid').addEventListener('click', () => {
  const p = currentParams;
  download(geomsToSTL(printOriented(lidGeoms, p)), `lid_${dims(p)}_${suffix(p)}.stl`);
});
$('dlPlate').addEventListener('click', () => {
  const p = currentParams;
  const plates = plateSideData(p);
  if (!plates.length) return;
  download(geomsToSTL(buildPlatesPrint(p)),
    `plates_${plates.map(d => d.side).join('')}_${dims(p)}.stl`);
});

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio);
}
window.addEventListener('resize', resize);

applyInsertPreset();
rebuild();
resize();

// debug handle for automated checks
window.__dbg = { boxGroup, lidGroup, get params() { return currentParams; } };

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
