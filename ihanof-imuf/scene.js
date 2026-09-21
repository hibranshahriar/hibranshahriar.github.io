/* =========================================================================
   scene.js — PHASE 3 (real Three.js scene, spec §5)

   Public surface (build plan §2.6, frozen): window.Scene with exactly
     Scene.init(containerEl)     Scene.setEra(n)
     Scene.setPopulation(count)  Scene.freeze()
   Nothing else is exposed on window.

   What lives in here
   - A persistent rig: renderer, camera, one directional "sun" + hemisphere
     ambient fill, a small pool of point lights (torches / fire / neon), a
     gradient sky dome, a ground plane and a plaza disc.
   - Six procedural era builders (spec §5.2): every building is composed
     from Box/Cone/Cylinder/Sphere primitives — no imported models, no
     external images (window grids are drawn onto tiny canvases).
   - Human-scaled flies (spec §5.2): InstancedMesh per body part — thorax,
     head, two faceted compound eyes, abdomen, two wings, six two-segment
     legs — animated procedurally, hovering and wandering near street level.
     Roughly 1 world unit = 1 metre; a fly is about as long as a person is
     tall, and the human-scale doors, vans and street furniture around them
     are built to match.
   - Background hint props (spec §4.1): fly whisk / swatter / newspaper /
     bug zapper / pest-control van, as ordinary set dressing.

   Runtime notes
   - Three.js r128 only: no CapsuleGeometry, no OrbitControls, sRGB output
     left at the r128 default so the flat palette reads as authored.
   - Scene.init() is called while #game-screen is still display:none, so the
     container has zero size at that moment. The render loop therefore
     tracks the container size every frame (plus a ResizeObserver) and skips
     drawing while it is 0.
   - Scene.setEra() after Scene.freeze() means "a new run has begun": it
     un-freezes, and resets the visible crowd to the starting population
     until Game calls setPopulation() again.
   ========================================================================= */

(function () {
  "use strict";

  var T = window.THREE;

  // ------------------------------------------------------------------ tunables
  var MAX_FLIES = 36;            // visual ceiling regardless of Population (§2.6)
  var DEFAULT_POPULATION = 50;   // spec §7 starting value, used until told otherwise
  var FLY_SIZE = 0.85;           // global fly scale knob (1 unit ~ 1 metre)
  var HINT_SCALE = 2.0;          // hand tools are drawn oversized so they stay legible at frame distance
  var VIEW_SHIFT = 0.26;         // lifts the picture so the decision panel (bottom third) covers ground, not flies
  var GROW_DUR = 1.7;            // seconds for one building to rise
  var ERA_TWEEN = 2.6;           // seconds for light/palette/camera cross-fade between eras
  var DEG = Math.PI / 180;
  var TAU = Math.PI * 2;

  // ------------------------------------------------------------------ utils
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { return t * t * (3 - 2 * t); }
  function angleDiff(a, b) {
    var d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------ era rigs
  // Spec §5.4's palette / light table, plus the camera framing and the area
  // the flies are allowed to wander in. Cross-faded on Scene.setEra().
  //   sun*   : directional light colour / intensity / azimuth (deg from +Z toward +X) / elevation
  //   hemi*  : ambient fill (sky colour, ground colour, intensity)
  //   horizon/zenith : sky-dome gradient; the horizon colour also drives the fog
  //   cam*/look* : camera position and look-at target;  fov in degrees
  //   body/abd/eye/wing/leg : fly palette (eyes take the era's accent colour)
  var ERA = {
    1: {
      name: "Stone Age",
      sunC: "#ff9a4d", sunI: 1.3, sunAz: -55, sunEl: 13,
      hemiSky: "#9a7350", hemiGnd: "#3a2716", hemiI: 0.72,
      horizon: "#d98a4e", zenith: "#4d3d55", fogNear: 70, fogFar: 300,
      ground: "#5d4128", plaza: "#a4733d",
      camX: 0, camY: 4.4, camZ: 23, lookX: 0, lookY: 5.4, lookZ: -6, fov: 52,
      body: "#2a1f18", abd: "#4d3b2a", eye: "#d24a2a", eyeEmis: 0.6, wing: "#ffe2b8", wingOp: 0.6, leg: "#22190f",
      area: { x0: -11, x1: 11, z0: -4, z1: 9, yMin: 1.3, yMax: 3.0 }, shadow: 62
    },
    2: {
      name: "Bronze Age",
      sunC: "#fff0bd", sunI: 1.05, sunAz: -40, sunEl: 62,
      hemiSky: "#c3d3e0", hemiGnd: "#c8ae76", hemiI: 0.5,
      horizon: "#ecd9a8", zenith: "#6fa4d6", fogNear: 90, fogFar: 340,
      ground: "#b89f6a", plaza: "#c9b078",
      camX: 0, camY: 4.8, camZ: 25, lookX: 0, lookY: 6.6, lookZ: -8, fov: 54,
      body: "#2b2620", abd: "#3a3a52", eye: "#2c62d0", eyeEmis: 0.55, wing: "#ffffff", wingOp: 0.5, leg: "#2a2418",
      area: { x0: -12, x1: 12, z0: -3, z1: 9, yMin: 1.3, yMax: 3.0 }, shadow: 66
    },
    3: {
      name: "Medieval",
      sunC: "#c9ccd3", sunI: 0.95, sunAz: -45, sunEl: 48,
      hemiSky: "#a1a9b3", hemiGnd: "#4f5148", hemiI: 0.8,
      horizon: "#a3a9b0", zenith: "#737b86", fogNear: 60, fogFar: 250,
      ground: "#5a6150", plaza: "#6c6a64",
      camX: 0, camY: 5, camZ: 26, lookX: 0, lookY: 9, lookZ: -8, fov: 56,
      body: "#211f22", abd: "#3a3140", eye: "#2fbf8a", eyeEmis: 0.55, wing: "#f2f4ff", wingOp: 0.5, leg: "#1e1c20",
      area: { x0: -11, x1: 11, z0: -3, z1: 9, yMin: 1.3, yMax: 3.0 }, shadow: 70
    },
    4: {
      name: "Industrial",
      sunC: "#bcc196", sunI: 0.7, sunAz: -40, sunEl: 38,
      hemiSky: "#78806a", hemiGnd: "#2f2f26", hemiI: 0.78,
      horizon: "#6a6f57", zenith: "#353b2f", fogNear: 40, fogFar: 190,
      ground: "#262822", plaza: "#37382f",
      camX: 0, camY: 5, camZ: 27, lookX: 0, lookY: 7.6, lookZ: -10, fov: 58,
      body: "#5b5a4c", abd: "#6b6a55", eye: "#d9ae2e", eyeEmis: 0.6, wing: "#dfe6c8", wingOp: 0.5, leg: "#3c3b30",
      area: { x0: -11, x1: 11, z0: -3, z1: 9, yMin: 1.3, yMax: 3.0 }, shadow: 72
    },
    5: {
      name: "Modern",
      sunC: "#f4f8ff", sunI: 0.95, sunAz: -35, sunEl: 52,
      hemiSky: "#a8c6e8", hemiGnd: "#6a6f76", hemiI: 0.55,
      horizon: "#cfe0f2", zenith: "#5d8fc4", fogNear: 110, fogFar: 400,
      ground: "#34373c", plaza: "#6a6f77",
      camX: 0, camY: 5, camZ: 30, lookX: 0, lookY: 8, lookZ: -14, fov: 60,
      body: "#22252b", abd: "#2f3644", eye: "#ff3fa8", eyeEmis: 0.6, wing: "#ffffff", wingOp: 0.5, leg: "#1c1f24",
      area: { x0: -11, x1: 11, z0: -3, z1: 10, yMin: 1.3, yMax: 3.2 }, shadow: 84
    },
    6: {
      name: "AI Age",
      sunC: "#e9f7ff", sunI: 0.3, sunAz: -30, sunEl: 60,
      hemiSky: "#f5faff", hemiGnd: "#dfe8f2", hemiI: 0.85,
      horizon: "#eef4fb", zenith: "#b7c7ee", fogNear: 130, fogFar: 430,
      ground: "#93a2b4", plaza: "#aebccc",
      camX: 0, camY: 5, camZ: 30, lookX: 0, lookY: 8.5, lookZ: -16, fov: 60,
      body: "#1b2030", abd: "#2a2f4a", eye: "#66f2ff", eyeEmis: 0.7, wing: "#e6f4ff", wingOp: 0.5, leg: "#171b28",
      area: { x0: -11, x1: 11, z0: -3, z1: 10, yMin: 1.3, yMax: 3.2 }, shadow: 92
    }
  };

  // Post-Phase 6 camera nudge: sit a little higher and tilt down a little
  // more, so individual flies read against the ground rather than blending
  // into the building backdrop. Applied once to every era's framing, so the
  // per-era values above stay as originally tuned. Both are world units
  // (1 unit ~ 1 metre); set both to 0 to restore the original framing.
  var CAM_RAISE = 0.8;           // added to each era's camY
  var LOOK_DROP = 0.4;           // subtracted from each era's lookY (steeper downward angle)
  Object.keys(ERA).forEach(function (k) {
    ERA[k].camY += CAM_RAISE;
    ERA[k].lookY -= LOOK_DROP;
  });

  // Which fields are cross-faded between eras.
  var SCALARS = ["sunI", "sunAz", "sunEl", "hemiI", "fogNear", "fogFar",
                 "camX", "camY", "camZ", "lookX", "lookY", "lookZ", "fov",
                 "eyeEmis", "wingOp", "shadow"];
  var COLORS = ["sunC", "hemiSky", "hemiGnd", "horizon", "zenith", "ground", "plaza",
                "body", "abd", "eye", "wing", "leg"];

  function makeLook() {
    var o = {};
    SCALARS.forEach(function (k) { o[k] = 0; });
    COLORS.forEach(function (k) { o[k] = new T.Color(); });
    return o;
  }
  function loadLook(dst, cfg) {
    SCALARS.forEach(function (k) { dst[k] = cfg[k]; });
    COLORS.forEach(function (k) { dst[k].set(cfg[k]); });
  }
  function copyLook(dst, src) {
    SCALARS.forEach(function (k) { dst[k] = src[k]; });
    COLORS.forEach(function (k) { dst[k].copy(src[k]); });
  }
  function mixLook(dst, a, b, t) {
    SCALARS.forEach(function (k) { dst[k] = lerp(a[k], b[k], t); });
    COLORS.forEach(function (k) { dst[k].copy(a[k]).lerp(b[k], t); });
  }

  // ------------------------------------------------------------------ module state
  var dead = !T;                 // true if Three.js or WebGL is unavailable -> every API call is a no-op
  var inited = false;
  var container = null, renderer = null, scene = null, camera = null, resizeObs = null;
  var sun = null, sunTarget = null, hemi = null, skyMesh = null, groundMesh = null, plazaMesh = null;
  var lamps = [];
  var viewW = 0, viewH = 0;
  var lastNow = 0, time = 0;

  var currentEra = 0;
  var frozen = false;
  var cur = T ? makeLook() : null;
  var from = T ? makeLook() : null;
  var to = T ? makeLook() : null;
  var lookT = 1, lookDur = 0.001;
  var flyArea = ERA[1].area;

  var B = null;                  // builder currently being populated (module-level so helpers stay terse)
  var eraState = null;           // { root, items, updaters, age, ... } for the era on screen
  var dying = [];                // eras that are sinking away after a transition

  // ------------------------------------------------------------------ flies
  var flies = [];
  var fm = {};                   // fly materials
  var fmesh = {};                // fly instanced meshes
  var LOC = {};                  // static local matrices for body parts
  var popTarget = 0;

  var _m = null, _m2 = null, _flyM = null, _wm = null, _q = null, _q2 = null, _e = null;
  var _p = null, _s = null, _v1 = null, _p2 = null, _s2 = null, UP = null;

  function visibleCountFor(pop) {
    // Capped, log-shaped mapping (§2.6): a few dozen flies reads as a busy street.
    if (!(pop > 0)) return 0;
    return clamp(Math.round(3 * Math.log(pop + 1) / Math.LN2 + 1), 1, MAX_FLIES);
  }

  function mkLocal(px, py, pz, sx, sy, sz, rx) {
    var m = new T.Matrix4();
    var q = new T.Quaternion().setFromEuler(new T.Euler(rx || 0, 0, 0));
    m.compose(new T.Vector3(px, py, pz), q, new T.Vector3(sx, sy, sz));
    return m;
  }

  function buildFlies() {
    _m = new T.Matrix4(); _m2 = new T.Matrix4(); _flyM = new T.Matrix4(); _wm = new T.Matrix4();
    _q = new T.Quaternion(); _q2 = new T.Quaternion(); _e = new T.Euler();
    _p = new T.Vector3(); _s = new T.Vector3(); _v1 = new T.Vector3();
    _p2 = new T.Vector3(); _s2 = new T.Vector3(); UP = new T.Vector3(0, 1, 0);

    // --- geometries (all unit-sized; proportions live in the local matrices) ---
    var gBall = new T.SphereGeometry(1, 9, 7);
    var gEye = new T.IcosahedronGeometry(1, 1);          // faceted -> reads as a compound eye
    var gLeg = new T.CylinderGeometry(0.038, 0.03, 1, 5);
    gLeg.translate(0, 0.5, 0);                            // base at origin, grows along +Y

    // Wing: a flat ellipse in the XZ plane, root at the origin, tip toward +X, trailing back (-Z).
    var shp = new T.Shape();
    shp.absellipse(0.75, 0, 0.78, 0.31, 0, TAU, false, 0);
    var gWingA = new T.ShapeGeometry(shp, 12);
    gWingA.rotateX(-Math.PI / 2);
    gWingA.translate(0, 0, -0.26);
    var gWingB = gWingA.clone();
    gWingB.scale(-1, 1, 1);                               // mirrored for the other side (material is double-sided)

    // --- materials ---
    fm.body = new T.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, flatShading: true });
    fm.abd = new T.MeshStandardMaterial({ color: 0x333344, roughness: 0.6, flatShading: true });
    fm.eye = new T.MeshStandardMaterial({ color: 0xcc3322, emissive: 0xcc3322, emissiveIntensity: 0.6, roughness: 0.35, flatShading: true });
    fm.wing = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.25, transparent: true, opacity: 0.5, side: T.DoubleSide, depthWrite: false, flatShading: true });
    fm.leg = new T.MeshStandardMaterial({ color: 0x222222, roughness: 0.8, flatShading: true });

    function mk(geo, mat, per, shadow) {
      var im = new T.InstancedMesh(geo, mat, MAX_FLIES * per);
      im.frustumCulled = false;
      im.castShadow = !!shadow;
      im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      im.count = 0;
      scene.add(im);
      return im;
    }
    fmesh.thorax = mk(gBall, fm.body, 1, true);
    fmesh.head = mk(gBall, fm.body, 1, true);
    fmesh.eyes = mk(gEye, fm.eye, 2, true);
    fmesh.abd = mk(gBall, fm.abd, 1, true);
    fmesh.wingA = mk(gWingA, fm.wing, 1, false);
    fmesh.wingB = mk(gWingB, fm.wing, 1, false);
    fmesh.legs = mk(gLeg, fm.leg, 12, false);
    fmesh.wingA.renderOrder = 2;
    fmesh.wingB.renderOrder = 2;

    // --- static local placement, in fly space: +Z forward, +Y up ---
    LOC.thorax = mkLocal(0, 0, 0.05, 0.44, 0.42, 0.52);
    LOC.head = mkLocal(0, -0.04, 0.62, 0.25, 0.23, 0.25);
    LOC.eyeA = mkLocal(0.21, 0.02, 0.73, 0.22, 0.22, 0.22);
    LOC.eyeB = mkLocal(-0.21, 0.02, 0.73, 0.22, 0.22, 0.22);
    LOC.abd = mkLocal(0, -0.06, -0.74, 0.3, 0.29, 0.64, -0.18);

    for (var i = 0; i < MAX_FLIES; i++) {
      flies.push({
        x: 0, y: 2, z: 0, tx: 0, ty: 2, tz: 0,
        yaw: Math.random() * TAU, pitch: 0, roll: 0, turn: 0,
        speed: 0, maxSpeed: 2, pause: Math.random(),
        wp: Math.random() * TAU, wf: Math.random() * 1.5,
        bob: Math.random() * TAU, size: 0.92 + Math.random() * 0.16,
        vis: 0, want: false, px: 0, pz: 0
      });
    }
  }

  function pickTarget(f) {
    var a = flyArea;
    f.tx = a.x0 + Math.random() * (a.x1 - a.x0);
    f.tz = a.z0 + Math.random() * (a.z1 - a.z0);
    f.ty = a.yMin + Math.pow(Math.random(), 1.4) * (a.yMax - a.yMin);
    f.maxSpeed = 1.3 + Math.random() * 2.1;
  }

  function spawnFly(f) {
    var a = flyArea;
    f.x = a.x0 + Math.random() * (a.x1 - a.x0);
    f.z = a.z0 + Math.random() * (a.z1 - a.z0);
    f.y = a.yMin + Math.random() * (a.yMax - a.yMin);
    f.yaw = Math.random() * TAU;
    f.speed = 0; f.turn = 0; f.px = 0; f.pz = 0;
    f.pause = Math.random() * 0.8;
    pickTarget(f);
  }

  function setLegSeg(index, sx, sy, sz, ex, ey, ez) {
    _v1.set(ex - sx, ey - sy, ez - sz);
    var len = _v1.length();
    if (len < 1e-4) len = 1e-4;
    _v1.multiplyScalar(1 / len);
    _q2.setFromUnitVectors(UP, _v1);
    _p2.set(sx, sy, sz);
    _s2.set(1, len, 1);
    _m2.compose(_p2, _q2, _s2);
    _m.multiplyMatrices(_flyM, _m2);
    fmesh.legs.setMatrixAt(index, _m);
  }

  // Leg rows: front / middle / hind. Each leg = attach point on the thorax -> knee -> foot.
  var LEGROWS = [
    { z: 0.28, k: 0.20, f: 0.34 },
    { z: 0.04, k: 0.04, f: 0.08 },
    { z: -0.20, k: -0.24, f: -0.42 }
  ];

  function updateFlies(dt, t) {
    var i, j, f, g, live = 0;

    // 1. presence + steering
    for (i = 0; i < MAX_FLIES; i++) {
      f = flies[i];
      f.want = i < popTarget;
      if (f.want && f.vis <= 0) spawnFly(f);
      if (f.want) f.vis = Math.min(1, f.vis + dt * 1.2);
      else f.vis = Math.max(0, f.vis - dt * 1.5);
      if (f.vis <= 0) continue;
      live = i + 1;

      var dx = f.tx - f.x, dz = f.tz - f.z;
      var dist = Math.sqrt(dx * dx + dz * dz);
      var moving = f.pause <= 0;
      if (!moving) {
        f.pause -= dt;
        if (f.pause <= 0) pickTarget(f);
      } else if (dist < 0.7) {
        f.pause = 0.3 + Math.random() * 1.6;
      }
      var goalSpeed = moving ? f.maxSpeed * Math.min(1, dist / 3 + 0.25) : 0;
      f.speed += (goalSpeed - f.speed) * Math.min(1, dt * 1.8);
      if (moving && dist > 0.05) {
        var diff = angleDiff(Math.atan2(dx, dz), f.yaw);
        var step = clamp(diff, -2.4 * dt, 2.4 * dt);
        f.yaw += step;
        f.turn += (step / dt - f.turn) * Math.min(1, dt * 4);
      } else {
        f.turn *= Math.max(0, 1 - dt * 3);
      }
      f.x += Math.sin(f.yaw) * f.speed * dt + f.px * dt;
      f.z += Math.cos(f.yaw) * f.speed * dt + f.pz * dt;
      f.y += (f.ty - f.y) * Math.min(1, dt * 1.1);
      f.px *= Math.max(0, 1 - dt * 4);
      f.pz *= Math.max(0, 1 - dt * 4);
      f.pitch += (f.speed * 0.07 - f.pitch) * Math.min(1, dt * 3);
      f.roll += (clamp(-f.turn * 0.16, -0.4, 0.4) - f.roll) * Math.min(1, dt * 4);
      f.wp += dt * TAU * (6.5 + f.wf);
    }

    // 2. gentle personal-space separation so bodies don't interpenetrate
    for (i = 0; i < live; i++) {
      f = flies[i];
      if (f.vis < 0.4) continue;
      for (j = i + 1; j < live; j++) {
        g = flies[j];
        if (g.vis < 0.4) continue;
        var ax = f.x - g.x, ay = f.y - g.y, az = f.z - g.z;
        var d2 = ax * ax + ay * ay + az * az;
        if (d2 < 3.8 && d2 > 1e-4) {
          var d = Math.sqrt(d2);
          var push = (1.95 - d) * 1.6;
          f.px += (ax / d) * push; f.pz += (az / d) * push;
          g.px -= (ax / d) * push; g.pz -= (az / d) * push;
        }
      }
    }

    // 3. write instance matrices
    for (i = 0; i < live; i++) {
      f = flies[i];
      var cnt = i;
      if (f.vis <= 0) {
        // fully gone but below a live slot: collapse to nothing
        _flyM.makeScale(0, 0, 0);
      } else {
        var bob = Math.sin(t * 2.1 + f.bob) * 0.11;
        _q.setFromEuler(_e.set(f.pitch, f.yaw, f.roll, "YXZ"));
        _p.set(f.x, f.y + bob, f.z);
        _s.setScalar(f.size * FLY_SIZE * ease(f.vis));
        _flyM.compose(_p, _q, _s);
      }

      _m.multiplyMatrices(_flyM, LOC.thorax); fmesh.thorax.setMatrixAt(cnt, _m);
      _m.multiplyMatrices(_flyM, LOC.head); fmesh.head.setMatrixAt(cnt, _m);
      _m.multiplyMatrices(_flyM, LOC.abd); fmesh.abd.setMatrixAt(cnt, _m);
      _m.multiplyMatrices(_flyM, LOC.eyeA); fmesh.eyes.setMatrixAt(cnt * 2, _m);
      _m.multiplyMatrices(_flyM, LOC.eyeB); fmesh.eyes.setMatrixAt(cnt * 2 + 1, _m);

      // wings: hinge at the top of the thorax, flap about the fly's own long (Z) axis
      var ang = 0.42 + 0.62 * Math.sin(f.wp);
      _wm.makeRotationZ(ang); _wm.setPosition(0.15, 0.27, 0.1);
      _m.multiplyMatrices(_flyM, _wm); fmesh.wingA.setMatrixAt(cnt, _m);
      _wm.makeRotationZ(-ang); _wm.setPosition(-0.15, 0.27, 0.1);
      _m.multiplyMatrices(_flyM, _wm); fmesh.wingB.setMatrixAt(cnt, _m);

      // legs: three pairs, each two segments, dangling with a slow wiggle
      for (var row = 0; row < 3; row++) {
        var R = LEGROWS[row];
        var sw = Math.sin(t * 3.1 + f.bob + row * 1.7) * 0.09;
        for (var sd = 0; sd < 2; sd++) {
          var side = sd === 0 ? 1 : -1;
          var ax0 = side * 0.19, ay0 = -0.22, az0 = R.z;
          var kx = side * 0.55, ky = -0.05 + sw * 0.5, kz = R.z + R.k * 0.7;
          var fx = side * 0.62, fy = -0.78, fz = R.z + R.f * 0.75 + sw;
          var li = cnt * 12 + row * 4 + sd * 2;
          setLegSeg(li, ax0, ay0, az0, kx, ky, kz);
          setLegSeg(li + 1, kx, ky, kz, fx, fy, fz);
        }
      }
    }

    var names = ["thorax", "head", "eyes", "abd", "wingA", "wingB", "legs"];
    var per = [1, 1, 2, 1, 1, 1, 12];
    for (i = 0; i < names.length; i++) {
      var im = fmesh[names[i]];
      im.count = live * per[i];
      im.instanceMatrix.needsUpdate = true;
    }
  }

  function setFlyPopulation(count) {
    popTarget = visibleCountFor(count);
  }

  // ------------------------------------------------------------------ builder helpers
  // Every era builder fills a THREE.Group through these. Geometry / materials /
  // textures are tracked on the builder `B` so a retired era can be disposed cleanly.

  function M(color, o) {
    o = o || {};
    var key = color + "|" + JSON.stringify(o);
    if (B.cache[key]) return B.cache[key];
    var m = new T.MeshStandardMaterial({
      color: color,
      roughness: o.rough == null ? 0.9 : o.rough,
      metalness: o.metal || 0,
      flatShading: o.flat !== false,
      side: o.double ? T.DoubleSide : T.FrontSide,
      transparent: o.opacity != null && o.opacity < 1,
      opacity: o.opacity == null ? 1 : o.opacity,
      depthWrite: !(o.opacity != null && o.opacity < 1)
    });
    if (o.emissive) { m.emissive = new T.Color(o.emissive); m.emissiveIntensity = o.ei == null ? 1 : o.ei; }
    B.cache[key] = m;
    B.mats.push(m);
    return m;
  }

  // Unlit, self-illuminated material for lamps, neon, windows, flames.
  function MB(color, o) {
    o = o || {};
    var key = "basic|" + color + "|" + JSON.stringify(o);
    if (B.cache[key]) return B.cache[key];
    var m = new T.MeshBasicMaterial({
      color: color,
      transparent: o.opacity != null && o.opacity < 1,
      opacity: o.opacity == null ? 1 : o.opacity,
      depthWrite: !(o.opacity != null && o.opacity < 1),
      side: o.double ? T.DoubleSide : T.FrontSide
    });
    B.cache[key] = m;
    B.mats.push(m);
    return m;
  }

  function mesh(parent, g, m, x, y, z, ry) {
    B.geos.push(g);
    var me = new T.Mesh(g, m);
    me.position.set(x || 0, y || 0, z || 0);
    if (ry) me.rotation.y = ry;
    var lit = !m.isMeshBasicMaterial;
    me.castShadow = lit && !(m.transparent);
    me.receiveShadow = lit;
    parent.add(me);
    return me;
  }

  // All of these sit with their BASE at (x, y, z) so buildings can rise from the ground.
  function box(p, w, h, d, c, x, y, z, ry, o) {
    var g = new T.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
    return mesh(p, g, M(c, o), x, y, z, ry);
  }
  function cyl(p, rt, rb, h, c, x, y, z, seg, o) {
    var g = new T.CylinderGeometry(rt, rb, h, seg || 10); g.translate(0, h / 2, 0);
    return mesh(p, g, M(c, o), x, y, z);
  }
  function cone(p, r, h, c, x, y, z, seg, o) {
    var g = new T.ConeGeometry(r, h, seg || 8); g.translate(0, h / 2, 0);
    return mesh(p, g, M(c, o), x, y, z);
  }
  function ball(p, r, c, x, y, z, seg, o) {
    var g = new T.SphereGeometry(r, seg || 8, Math.max(4, Math.round((seg || 8) * 0.7)));
    return mesh(p, g, M(c, o), x, y, z);
  }
  function rock(p, r, c, x, y, z, sx, sy, sz) {
    var g = new T.DodecahedronGeometry(r, 0);
    g.scale(sx || 1, sy || 0.7, sz || 1);
    return mesh(p, g, M(c), x, y, z);
  }
  function glowBox(p, w, h, d, c, x, y, z, ry, o) {
    var g = new T.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
    return mesh(p, g, MB(c, o), x, y, z, ry);
  }
  function glowBall(p, r, c, x, y, z) {
    return mesh(p, new T.SphereGeometry(r, 8, 6), MB(c), x, y, z);
  }

  // Gable prism: ridge runs along X (length w), base depth d, height h. Rotate `ry` for a front-facing gable.
  function prism(p, w, h, d, c, x, y, z, ry, o) {
    var hw = w / 2, hd = d / 2;
    var A = [-hw, 0, -hd], Bv = [-hw, 0, hd], C = [-hw, h, 0];
    var A2 = [hw, 0, -hd], B2 = [hw, 0, hd], C2 = [hw, h, 0];
    var tris = [A, Bv, C, A2, C2, B2, Bv, B2, C2, Bv, C2, C, A, C, C2, A, C2, A2, A, A2, B2, A, B2, Bv];
    var pos = [];
    tris.forEach(function (v) { pos.push(v[0], v[1], v[2]); });
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    var mo = o || {}; mo.double = true;
    return mesh(p, g, M(c, mo), x, y, z, ry);
  }

  // A registered top-level group: rises from the ground when its era appears, sinks when it retires.
  function bld(x, z, ry, delay) {
    var g = new T.Group();
    g.position.set(x || 0, 0, z || 0);
    if (ry) g.rotation.y = ry;
    g.scale.y = 0.001;
    B.root.add(g);
    B.items.push({ g: g, d: delay == null ? B.rng() * 1.5 : delay });
    return g;
  }
  function faceTo(x, z, tx, tz) { return Math.atan2(tx - x, tz - z); }

  // ---- canvas-drawn window grids (spec §5.2: "repeating window-grid or emissive-strip material") ----
  // One canvas pair per facade, sized exactly to its window count, so the grid never gets sliced.
  function facadeTex(nx, ny, s) {
    if (typeof document === "undefined") return {};
    var cell = 8, W = nx * cell, H = ny * cell;
    var c1 = document.createElement("canvas"), c2 = document.createElement("canvas");
    c1.width = c2.width = W; c1.height = c2.height = H;
    var a = c1.getContext("2d"), b = c2.getContext("2d");
    a.fillStyle = s.wall; a.fillRect(0, 0, W, H);
    b.fillStyle = "#000"; b.fillRect(0, 0, W, H);
    for (var r = 0; r < ny; r++) {
      for (var c = 0; c < nx; c++) {
        var lit = B.rng() < s.litProb;
        var x = c * cell, y = r * cell;
        if (s.strips) {
          a.fillStyle = lit ? s.litDim : s.glass;
          a.fillRect(x, y + 3, cell, 2);
          if (lit) { b.fillStyle = s.lit; b.fillRect(x, y + 3, cell, 2); }
        } else {
          a.fillStyle = lit ? s.litDim : (B.rng() < 0.5 ? s.glass : s.glassAlt);
          a.fillRect(x + 1, y + 1, cell - 2, cell - 2);
          if (lit) { b.fillStyle = s.lit; b.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
        }
      }
    }
    var t1 = new T.CanvasTexture(c1), t2 = new T.CanvasTexture(c2);
    t1.magFilter = t2.magFilter = T.NearestFilter;
    B.texs.push(t1, t2);
    return { map: t1, emissiveMap: t2 };
  }

  var STYLE = {
    brick: { wall: "#43302a", glass: "#161210", glassAlt: "#1f1915", lit: "#f0b04c", litDim: "#8a6a30", litProb: 0.22, ei: 0.6, roof: "#2a2622", cw: 3.2, ch: 3.6, rough: 0.95 },
    glass: { wall: "#2a4560", glass: "#6ea6d6", glassAlt: "#5b93c4", lit: "#ffeeb0", litDim: "#c9dcea", litProb: 0.14, ei: 0.35, roof: "#5a6b7c", cw: 3, ch: 3.6, rough: 0.35, metal: 0.25 },
    concrete: { wall: "#a3a7ad", glass: "#3d5468", glassAlt: "#4b6379", lit: "#ffeeb0", litDim: "#c9c3a0", litProb: 0.1, ei: 0.3, roof: "#7d8188", cw: 3.4, ch: 3.6, rough: 0.9 },
    ai: { wall: "#f3f6fa", glass: "#d5e9f5", glassAlt: "#e5f1f9", lit: "#4ff0ff", litDim: "#9fe8f2", litProb: 0.34, ei: 0.9, roof: "#e8eef4", cw: 3, ch: 3.4, rough: 0.4, metal: 0.05, strips: true }
  };

  function facadeMats(w, d, h, s) {
    var nyy = Math.max(2, Math.round(h / s.ch));
    var tX = facadeTex(Math.max(2, Math.round(d / s.cw)), nyy, s);
    var tZ = facadeTex(Math.max(2, Math.round(w / s.cw)), nyy, s);
    function side(t) {
      var m = new T.MeshStandardMaterial({
        map: t.map || null, emissiveMap: t.emissiveMap || null,
        emissive: new T.Color(0xffffff), emissiveIntensity: s.ei,
        roughness: s.rough, metalness: s.metal || 0, flatShading: true
      });
      B.mats.push(m);
      return m;
    }
    return [side(tX), side(tX), M(s.roof), M(s.roof), side(tZ), side(tZ)];
  }

  function tower(p, w, d, h, x, y, z, style) {
    var g = new T.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
    B.geos.push(g);
    var me = new T.Mesh(g, facadeMats(w, d, h, style));
    me.position.set(x, y, z);
    me.castShadow = me.receiveShadow = true;
    p.add(me);
    return me;
  }

  // ---- lights claimed by an era (fire, torches, neon) ----
  function lamp(x, y, z, color, intensity, dist, flicker) {
    B.lamps.push({ x: x, y: y, z: z, c: color, i: intensity, d: dist, fl: flicker || 0 });
  }

  // ---- hint props (spec §4.1) — ordinary set dressing, never labelled ----
  function gridTex() {
    if (typeof document === "undefined") return null;
    var c = document.createElement("canvas"); c.width = 40; c.height = 48;
    var x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, 40, 48);
    for (var i = 4; i < 36; i += 5) for (var j = 4; j < 44; j += 5) x.clearRect(i, j, 3, 3);
    var t = new T.CanvasTexture(c); t.magFilter = T.NearestFilter; B.texs.push(t);
    return t;
  }
  function newsTex() {
    if (typeof document === "undefined") return null;
    var c = document.createElement("canvas"); c.width = 64; c.height = 64;
    var x = c.getContext("2d");
    x.fillStyle = "#dcd6c0"; x.fillRect(0, 0, 64, 64);
    x.fillStyle = "#2b2823"; x.fillRect(4, 6, 56, 10);          // headline block
    x.fillStyle = "#6f6a5c";
    for (var y = 22; y < 60; y += 5) x.fillRect(4, y, 22 + ((y * 7) % 30), 2);
    x.fillStyle = "#8d8676"; x.fillRect(36, 22, 24, 22);        // photo block
    var t = new T.CanvasTexture(c); B.texs.push(t);
    return t;
  }

  // Flyswatter leaning against something. Sized up by HINT_SCALE so it survives the camera distance.
  function swatter(parent, x, y, z, ry, tilt, col) {
    var g = new T.Group();
    g.position.set(x, y, z); g.rotation.y = ry || 0; g.rotation.z = tilt || 0;
    g.scale.setScalar(HINT_SCALE);
    parent.add(g);
    cyl(g, 0.04, 0.05, 0.8, "#3b2a1a", 0, 0, 0, 6);
    var pg = new T.BoxGeometry(0.5, 0.62, 0.035); pg.translate(0, 0.31, 0);
    var tex = gridTex();
    var pm = new T.MeshStandardMaterial({ color: col, roughness: 0.6, map: tex, alphaTest: 0.5, side: T.DoubleSide });
    B.mats.push(pm);
    mesh(g, pg, pm, 0, 0.8, 0);
    return g;
  }

  function newspaper(parent, x, y, z, ry) {
    var g = new T.CylinderGeometry(0.22, 0.22, 1.5, 10);
    var m = new T.MeshStandardMaterial({ color: "#ffffff", map: newsTex(), roughness: 0.95, flatShading: true });
    B.mats.push(m);
    var me = mesh(parent, g, m, x, y, z);
    me.rotation.z = Math.PI / 2; me.rotation.y = ry || 0;
    me.scale.setScalar(HINT_SCALE * 0.8);
    return me;
  }

  function bugZapper(parent, x, y, z, glowCol) {
    var g = new T.Group(); g.position.set(x, y, z); parent.add(g);
    box(g, 0.9, 0.12, 0.5, "#2a2d33", 0, 0, 0);
    glowBox(g, 0.7, 1.1, 0.4, glowCol, 0, 0.12, 0);
    box(g, 0.9, 0.12, 0.5, "#2a2d33", 0, 1.22, 0);
    return g;
  }

  // Pest-control van, parked side-on to the camera (front toward +X). Real-vehicle scale.
  function pestVan(x, z, ry, delay, clean) {
    var g = bld(x, z, ry, delay);
    var body = clean ? "#f2f5f8" : "#d8d6ca";
    box(g, 5.0, 2.4, 2.3, body, -0.6, 0.55, 0);
    box(g, 1.9, 1.7, 2.3, clean ? "#e3e8ee" : "#c7c5b8", 2.85, 0.55, 0);
    box(g, 0.14, 0.9, 2.0, "#1c2430", 3.82, 1.4, 0);
    box(g, 5.02, 0.5, 2.34, clean ? "#4a90a8" : "#3f7a4a", -0.6, 1.0, 0);
    [-2.4, 2.9].forEach(function (wx) {
      [-1.05, 1.05].forEach(function (wz) {
        var wg = new T.CylinderGeometry(0.55, 0.55, 0.4, 12); wg.rotateX(Math.PI / 2);
        mesh(g, wg, M("#15151a"), wx, 0.55, wz);
      });
    });
    // an unreadable brand mark on the camera-facing side
    var ring = new T.TorusGeometry(0.55, 0.1, 5, 14);
    mesh(g, ring, M(clean ? "#2f6f86" : "#2f5a3a"), -0.6, 2.05, 1.17);
    var dot = new T.SphereGeometry(0.22, 6, 5); dot.scale(1.3, 0.8, 0.3);
    mesh(g, dot, M(clean ? "#2f6f86" : "#2f5a3a"), -0.6, 2.05, 1.19);
    return g;
  }

  // ------------------------------------------------------------------ ERA 1 — Stone Age
  // Neolithic settlement: mud-and-thatch huts around a communal fire on cleared earth.
  function buildStoneAge(b) {
    var r = b.rng, root = b.root;
    var MUD = "#8c6238", THATCH = "#b98d46", DARK = "#1a1108", STONE = "#6c675e";

    function hut(x, z, s) {
      var g = bld(x, z, faceTo(x, z, 0, 3));
      cyl(g, 2.65 * s, 2.9 * s, 2.4 * s, MUD, 0, 0, 0, 9);
      cone(g, 3.95 * s, 3.4 * s, THATCH, 0, 2.3 * s, 0, 9);
      cone(g, 0.5 * s, 0.9 * s, "#6b4a26", 0, 5.4 * s, 0, 6);
      box(g, 1.6 * s, 2.05 * s, 0.6 * s, DARK, 0, 0, 2.62 * s);
      box(g, 2.0 * s, 0.25 * s, 0.7 * s, "#5a3a1c", 0, 2.05 * s, 2.62 * s);
    }
    [[-18, -8, 1], [-26, -16, 1.1], [-12, -20, 0.95], [4, -25, 1.15], [18, -19, 1], [26, -8, 1.05],
     [25, 4, 0.9], [-25, 4, 0.95], [10, -35, 1.2], [-8, -37, 1.1], [-39, -10, 1.05], [38, -22, 1]]
      .forEach(function (h) { hut(h[0], h[1], h[2]); });

    // communal fire
    var fg = bld(0, -1, 0, 0.2);
    for (var k = 0; k < 9; k++) {
      var a = (k / 9) * TAU;
      rock(fg, 0.42, STONE, Math.cos(a) * 1.5, 0.25, Math.sin(a) * 1.5, 1, 0.75, 1);
    }
    [0, 1, 2].forEach(function (i) {
      var lg = cyl(fg, 0.16, 0.18, 2.1, "#4a3220", 0, 0.2, 0, 6);
      lg.rotation.z = Math.PI / 2; lg.rotation.y = i * 1.05; lg.position.y = 0.3 + i * 0.05;
    });
    var flames = [
      cone(fg, 0.75, 2.3, "#ff7a1f", 0, 0.3, 0, 7),
      cone(fg, 0.5, 1.7, "#ffb62e", 0.15, 0.3, 0.1, 6),
      cone(fg, 0.3, 1.2, "#fff0a0", -0.05, 0.3, -0.05, 5)
    ];
    flames.forEach(function (f) { f.material = MB(f.material.color.getStyle ? f.material.color.getStyle() : "#ff8a2b"); f.castShadow = false; f.receiveShadow = false; });
    lamp(0, 2, -1, "#ff8a3c", 2.4, 36, 1);
    b.updaters.push(function (t) {
      flames.forEach(function (f, i) {
        var s = 1 + Math.sin(t * (9 + i * 3) + i * 2) * 0.13 + Math.sin(t * 23 + i) * 0.05;
        f.scale.set(1 + (s - 1) * 0.6, s, 1 + (s - 1) * 0.6);
      });
    });

    // drying rack
    var dr = bld(-10.5, 6.5, 0.3, 0.6);
    cyl(dr, 0.13, 0.15, 2.7, "#5b3e22", -1.6, 0, 0, 6);
    cyl(dr, 0.13, 0.15, 2.7, "#5b3e22", 1.6, 0, 0, 6);
    var beam = cyl(dr, 0.1, 0.1, 3.6, "#6a4a2a", -1.8, 2.5, 0, 6); beam.rotation.z = -Math.PI / 2;
    for (var h = 0; h < 4; h++) box(dr, 0.55, 1.1 + (h % 2) * 0.3, 0.06, h % 2 ? "#9a6a3c" : "#7a5230", -1.1 + h * 0.75, 1.3 - (h % 2) * 0.2, 0);

    // standing stones
    [[-6.5, -15, 0.1, 3.4], [0.5, -17, -0.06, 4.6], [7, -15.5, 0.08, 3.8]].forEach(function (s) {
      var sg = bld(s[0], s[1], 0, 0.9);
      var st = box(sg, 1.5, s[3], 1.0, "#6b675f", 0, 0, 0); st.rotation.z = s[2];
    });

    // palisade arc + boulders + pines
    var pal = bld(0, 0, 0, 1.0);
    for (var d = -158; d <= -22; d += 4.6) {
      var ang = d * DEG, px = Math.cos(ang) * 50, pz = Math.sin(ang) * 46 - 8;
      if (pz > 6) continue;
      var hgt = 3 + r() * 0.8;
      cyl(pal, 0.22, 0.26, hgt, "#6a4a2a", px, 0, pz, 6);
      cone(pal, 0.26, 0.8, "#6a4a2a", px, hgt, pz, 6);
    }
    for (var i = 0; i < 7; i++) {
      var bg = bld(-46 + i * 15 + r() * 6, -46 - r() * 20, 0, r() * 1.5);
      rock(bg, 1.6 + r() * 1.6, "#6d6960", 0, 0.5, 0, 1, 0.6 + r() * 0.3, 1);
    }
    for (var n = 0; n < 22; n++) {
      var ta = (-170 + n * 7.2 + r() * 4) * DEG, tr = 62 + r() * 34;
      var tg = bld(Math.cos(ta) * tr, Math.sin(ta) * tr * 0.9 - 14, 0, r() * 1.6);
      var th = 8 + r() * 6;
      cyl(tg, 0.3, 0.4, th * 0.4, "#4a3520", 0, 0, 0, 6);
      cone(tg, 2.6, th * 0.65, "#33452a", 0, th * 0.25, 0, 7);
      cone(tg, 1.9, th * 0.5, "#3b5230", 0, th * 0.55, 0, 7);
    }
  }

  // ------------------------------------------------------------------ ERA 2 — Bronze Age
  // River-valley city: mudbrick, a stepped ziggurat, irrigation canals, palms.
  function buildBronzeAge(b) {
    var r = b.rng, root = b.root;
    var BRICK = "#c39a5b", BRICK2 = "#cfa868", DARK = "#2a1d10", LAPIS = "#2a5db0";

    // ziggurat, stairway facing the plaza
    var zg = bld(0, -36, 0, 0.1);
    box(zg, 32, 4.2, 26, BRICK, 0, 0, 0);
    box(zg, 24, 4.2, 19, BRICK2, 0, 4.2, -1);
    box(zg, 16, 4.2, 12, BRICK, 0, 8.4, -2);
    box(zg, 7.5, 3.4, 6.5, LAPIS, 0, 12.6, -2);
    box(zg, 8.4, 0.5, 7.4, "#e6d3a0", 0, 16, -2);
    box(zg, 2.4, 2.6, 0.5, "#10141c", 0, 12.6, 1.3);
    var steps = 26, run = 0.42, rise = 12.6 / steps;
    for (var s = 0; s < steps; s++) box(zg, 4.2, rise * (s + 1), run, "#dcc088", 0, 0, 13.6 - s * run);

    function mudHouse(x, z, w, d, h) {
      var g = bld(x, z, faceTo(x, z, 0, 4) * 0.5);
      var c = r() < 0.5 ? BRICK : BRICK2;
      box(g, w, h, d, c, 0, 0, 0);
      box(g, w + 0.3, 0.45, 0.35, "#b48a4d", 0, h, d / 2 - 0.1);
      box(g, w + 0.3, 0.45, 0.35, "#b48a4d", 0, h, -d / 2 + 0.1);
      box(g, 0.35, 0.45, d, "#b48a4d", w / 2 - 0.1, h, 0);
      box(g, 0.35, 0.45, d, "#b48a4d", -w / 2 + 0.1, h, 0);
      box(g, 1.9, 2.5, 0.4, DARK, r() * 1.2 - 0.6, 0, d / 2 + 0.02);
      box(g, 2.3, 0.28, 0.5, LAPIS, 0, 2.5, d / 2 + 0.02);
      box(g, 0.7, 0.9, 0.3, DARK, w / 2 - 1.3, h * 0.6, d / 2 + 0.02);
      if (r() < 0.6) cyl(g, 0.5, 0.4, 0.9, "#a86f45", -w / 2 + 1.2, h + 0.4, -0.5, 8);
    }
    [[-19, -5, 8, 7, 5], [-30, -14, 9, 8, 6.5], [-42, -6, 8, 7, 4.8], [-21, -22, 8, 7, 7], [-47, -22, 9, 8, 6],
     [19, -6, 8, 7, 5.5], [31, -13, 9, 8, 6.8], [43, -5, 8, 7, 5], [22, -22, 8, 7, 7.2], [46, -22, 9, 8, 5.8],
     [-8, -20, 6, 6, 4.6], [9, -21, 6, 6, 5]].forEach(function (h) { mudHouse(h[0], h[1], h[2], h[3], h[4]); });

    // city wall with merlons
    var wall = bld(0, -68, 0, 1.0);
    box(wall, 130, 8, 2.4, "#c9a468", 0, 0, 0);
    for (var m = -62; m <= 62; m += 3.6) box(wall, 1.7, 1.5, 2.6, "#c9a468", m, 8, 0);
    box(wall, 7, 11, 4, "#b8925a", 0, 0, 0.3);

    // irrigation canals: lapis water between raised banks
    function canal(x, z, w, d) {
      var bank = box(root, w + 1.2, 0.35, d + 1.2, "#b39560", x, 0.02, z, 0, { rough: 1 });
      bank.castShadow = false;
      var water = glowBox(root, w, 0.06, d, "#2a72b8", x, 0.36, z);
      b.canals = (b.canals || []); b.canals.push(water);
    }
    canal(0, -11.5, 130, 3.6);
    canal(-27, 3, 3.4, 30);
    canal(27, 3, 3.4, 30);

    // date palms
    for (var p = 0; p < 12; p++) {
      var px = (p < 6 ? -1 : 1) * (14 + (p % 6) * 8 + r() * 4), pz = -2 - r() * 30;
      if (Math.abs(px) < 18 && pz > -30) px += px < 0 ? -12 : 12;
      var pg = bld(px, pz, 0, r() * 1.6);
      var trunk = cyl(pg, 0.3, 0.45, 6.5, "#7a5a34", 0, 0, 0, 6);
      trunk.rotation.z = (r() - 0.5) * 0.15;
      for (var l = 0; l < 7; l++) {
        var lf = box(pg, 0.5, 0.1, 3.4, "#4b7a3a", 0, 6.3, 0, 0);
        lf.rotation.y = (l / 7) * TAU; lf.rotation.x = -0.45;
        lf.position.set(Math.sin(lf.rotation.y) * 0.9, 6.3, Math.cos(lf.rotation.y) * 0.9);
      }
    }

    // hint: a fly whisk propped against a doorway
    var hg = bld(-13.2, 4.5, 0.1, 0.9);
    var hl = 1.7 * HINT_SCALE * 0.6, lean = 0.32;
    var handle = cyl(hg, 0.06, 0.07, hl, "#5a3d22", 0, 0, 0, 6);
    handle.rotation.z = lean;
    var tuft = cone(hg, 0.4, 1.4, "#e9dfc4", 0, 0, 0, 8);
    tuft.rotation.z = Math.PI + lean;
    tuft.position.set(-Math.sin(lean) * (hl + 1.4), Math.cos(lean) * (hl + 1.4), 0);
  }

  // ------------------------------------------------------------------ ERA 3 — Medieval
  // Walled town: cathedral, timber-frame houses, market square, torchlit.
  function buildMedieval(b) {
    var r = b.rng, root = b.root;
    var STONE = "#8d8b85", STONE2 = "#7d7b76", SLATE = "#464b57", TIMBER = "#4a3524", PLASTER = "#d8cbac";
    var JEWEL = ["#3a62c9", "#c9483a", "#2f9e63", "#d6a629"];

    // cathedral (facade toward the camera)
    var cg = bld(8, -54, 0, 0.1);
    box(cg, 12, 14, 30, STONE, 0, 0, 0);
    prism(cg, 30.6, 6.5, 12.8, SLATE, 0, 14, 0, Math.PI / 2);
    [-1, 1].forEach(function (sx) {
      box(cg, 5, 8, 26, STONE2, sx * 8.5, 0, -1);
      prism(cg, 26.4, 3.2, 5.6, SLATE, sx * 8.5, 8, -1, Math.PI / 2);
      for (var w = 0; w < 4; w++) {
        var lw = glowBox(cg, 0.3, 4.2, 1.5, JEWEL[(w + (sx > 0 ? 2 : 0)) % 4], sx * 11.05, 2.2, -9 + w * 6);
      }
      // twin towers with pyramid spires
      box(cg, 5.6, 25, 5.6, STONE, sx * 4.4, 0, 12.4);
      var sp = cone(cg, 4.1, 13, "#3d4350", sx * 4.4, 25, 12.4, 4); sp.rotation.y = Math.PI / 4;
      glowBox(cg, 1.1, 4, 0.3, JEWEL[(sx > 0 ? 1 : 3)], sx * 4.4 - 0.55, 14, 15.3);
      glowBox(cg, 1.1, 3, 0.3, JEWEL[(sx > 0 ? 0 : 2)], sx * 4.4 - 0.55, 19.5, 15.3);
    });
    box(cg, 6, 9, 6, STONE, 0, 14, -2);
    var mid = cone(cg, 4.4, 17, "#3d4350", 0, 23, -2, 4); mid.rotation.y = Math.PI / 4;
    box(cg, 3.4, 6.4, 0.6, "#15110d", 0, 0, 15.0);
    prism(cg, 0.6, 2.7, 3.4, "#15110d", 0, 6.4, 15.0, Math.PI / 2);
    var rose = new T.CylinderGeometry(2.1, 2.1, 0.4, 14); rose.rotateX(Math.PI / 2);
    mesh(cg, rose, MB("#3f6ad6"), 0, 11, 15.1);
    var rose2 = new T.CylinderGeometry(1.2, 1.2, 0.45, 8); rose2.rotateX(Math.PI / 2);
    mesh(cg, rose2, MB("#d6a629"), 0, 11, 15.15);

    // timber-frame houses
    function timberHouse(x, z, w, d, h1, h2, roofCol) {
      var g = bld(x, z, faceTo(x, z, 0, 8) * 0.55);
      box(g, w, h1, d, PLASTER, 0, 0, 0);
      box(g, w + 0.7, h2, d + 0.7, "#e2d6b8", 0, h1, 0);
      [-1, 1].forEach(function (sx) {
        [-1, 1].forEach(function (sz) { box(g, 0.3, h1 + h2, 0.3, TIMBER, sx * w / 2, 0, sz * d / 2); });
      });
      box(g, w + 0.9, 0.3, 0.3, TIMBER, 0, h1 - 0.15, d / 2 + 0.36);
      var len = Math.sqrt(w * w + h2 * h2);
      var dg = box(g, 0.22, len, 0.22, TIMBER, -w / 2, h1, d / 2 + 0.4); dg.rotation.z = -Math.atan2(w, h2);
      box(g, 1.5, 2.3, 0.3, "#2a1c10", -w / 4, 0, d / 2 + 0.02);
      var lit = r() < 0.6;
      [-1, 1].forEach(function (sx) {
        box(g, 0.9, 1.1, 0.3, "#20160d", sx * w * 0.28, h1 + 1, d / 2 + 0.4);
        if (lit) glowBox(g, 0.6, 0.8, 0.2, "#e8a548", sx * w * 0.28, h1 + 1.15, d / 2 + 0.52);
      });
      prism(g, d + 1.6, 3.6 + r(), w + 1.6, roofCol, 0, h1 + h2, 0, Math.PI / 2);
      box(g, 0.9, 2.2, 0.9, "#6a655c", w * 0.25, h1 + h2 + 1.2, -d * 0.2);
    }
    var ROOFS = ["#7a3f2c", "#5c3a2a", "#8a5a34", "#6a3a30"];
    [[-16, -8, 6, 5.5, 3.2, 3.2], [-25, -16, 7, 6, 3.4, 3.4], [-35, -9, 6, 5.5, 3.2, 2.8], [-42, -22, 7, 6, 3.4, 3.2],
     [-14, -21, 6, 6, 3.2, 3.6], [-24, -28, 7, 6, 3.4, 3.4],
     [17, -8, 6, 5.5, 3.2, 3.2], [27, -17, 7, 6, 3.4, 3.4], [37, -9, 6, 5.5, 3.2, 2.8], [43, -24, 7, 6, 3.4, 3.2],
     [26, -29, 7, 6, 3.4, 3.4], [-4, -22, 6, 5, 3.2, 3]].forEach(function (h, i) {
      timberHouse(h[0], h[1], h[2], h[3], h[4], h[5], ROOFS[i % 4]);
    });

    // market stalls at the plaza edge
    function stall(x, z, c1, c2) {
      var g = bld(x, z, faceTo(x, z, 0, 6) * 0.8, r() * 1.5);
      box(g, 3.2, 1.0, 1.4, "#6a4a2a", 0, 0, 0);
      [-1, 1].forEach(function (sx) { box(g, 0.14, 2.7, 0.14, "#4a3320", sx * 1.5, 0, 0.6); box(g, 0.14, 2.4, 0.14, "#4a3320", sx * 1.5, 0, -0.6); });
      for (var i = 0; i < 4; i++) {
        var aw = box(g, 0.85, 0.08, 2.3, i % 2 ? c1 : c2, -1.29 + i * 0.86, 2.55, 0, 0);
        aw.rotation.x = 0.22;
      }
      box(g, 0.6, 0.45, 0.6, "#8a6a3a", -0.9, 1.0, 0.1);
      box(g, 0.6, 0.35, 0.6, "#a4472f", 0.4, 1.0, 0.1);
      ball(g, 0.3, "#c9a032", 1.1, 1.3, 0.1, 6);
    }
    stall(-15.5, 3.5, "#a63b34", "#e6dcc0");
    stall(15.5, 3.5, "#2f6a9a", "#e6dcc0");
    stall(-14, -3.5, "#2f8a55", "#e6dcc0");
    stall(14, -3.8, "#c48a2a", "#e6dcc0");
    // hint: a plain wooden swatter propped against the left stall
    var sg = bld(-13.7, 3.2, 0, 0.9);
    swatter(sg, 0, 0, 0, 0.3, 0.22, "#8a6238");

    // well
    var wg = bld(-4.5, -9, 0, 0.5);
    cyl(wg, 1.3, 1.4, 1.2, "#8a8780", 0, 0, 0, 10);
    box(wg, 0.18, 2.6, 0.18, "#4a3320", -1.2, 0, 0);
    box(wg, 0.18, 2.6, 0.18, "#4a3320", 1.2, 0, 0);
    prism(wg, 3.4, 1.2, 2.2, "#6a3f2c", 0, 2.6, 0);

    // town wall + round towers
    var tw = bld(0, -74, 0, 1.0);
    box(tw, 150, 10, 3, "#7e7c76", 0, 0, 0);
    for (var m = -70; m <= 70; m += 4) box(tw, 2, 1.6, 3.2, "#7e7c76", m, 10, 0);
    [-34, 34].forEach(function (x) {
      var t = bld(x, -72, 0, 1.2);
      cyl(t, 4.2, 4.6, 16, "#77756f", 0, 0, 0, 12);
      cone(t, 5.4, 6.5, SLATE, 0, 16, 0, 12);
    });

    // torches on posts (the torchlit point-lights of spec §5.4)
    [[-10, 2], [10, 2], [-6, -10], [7, -8]].forEach(function (p, i) {
      var g = bld(p[0], p[1], 0, 0.7);
      cyl(g, 0.1, 0.13, 3, "#3a2718", 0, 0, 0, 6);
      glowBall(g, 0.28, "#ffb347", 0, 3.25, 0);
      lamp(p[0], 3.4, p[1], "#ff9a3c", 1.5, 22, 1);
    });
  }

  // ------------------------------------------------------------------ ERA 4 — Industrial
  // Factory town: smokestacks, sawtooth roofs, rail line with a train, soot-dark tenements.
  function buildIndustrial(b) {
    var r = b.rng, root = b.root;
    var BRASS = "#b08d3a";
    var smokes = [];

    function stack(x, z, h, rad, delay) {
      var g = bld(x, z, 0, delay);
      cyl(g, rad * 0.72, rad, h, "#4a2f27", 0, 0, 0, 12);
      for (var k = 1; k <= 3; k++) {
        var rr = lerp(rad, rad * 0.72, k / 4) + 0.1;
        cyl(g, rr, rr, 0.35, BRASS, 0, h * k / 4, 0, 12);
      }
      cyl(g, rad * 0.86, rad * 0.72, 0.8, "#2a1d18", 0, h, 0, 12);
      for (var p = 0; p < 4; p++) {
        var mat = new T.MeshBasicMaterial({ color: "#3b3c36", transparent: true, opacity: 0.5, depthWrite: false });
        var geo = new T.IcosahedronGeometry(1, 0);
        B.mats.push(mat); B.geos.push(geo);
        var puff = new T.Mesh(geo, mat);
        puff.userData.noGrow = true; puff.visible = false;
        root.add(puff);
        smokes.push({ m: puff, mat: mat, x: x, z: z, y: h + 0.8, ph: p / 4 + r() * 0.08 });
      }
    }

    function factory(x, z, w, d, h, delay) {
      var g = bld(x, z, 0, delay);
      tower(g, w, d, h, 0, 0, 0, STYLE.brick);
      var n = Math.floor(w / 6.6);
      for (var i = 0; i < n; i++) prism(g, d + 0.6, 3.2, 6.6, "#1c1c1a", -w / 2 + 3.3 + i * 6.6 + (w - n * 6.6) / 2, h, 0, Math.PI / 2);
      box(g, 3, 4.5, 0.4, "#100d0b", -w / 4, 0, d / 2 + 0.02);
    }
    factory(0, -58, 42, 20, 13, 0.2);
    factory(-27, -34, 26, 16, 12, 0.5);
    factory(30, -38, 28, 16, 14, 0.6);
    stack(-36, -46, 34, 1.6, 0.9);
    stack(-19, -46, 40, 1.5, 1.0);
    stack(37, -50, 36, 1.7, 1.1);
    stack(-8, -70, 44, 1.8, 1.2);
    stack(14, -68, 38, 1.6, 1.3);

    function tenement(x, z, w, d, h) {
      var g = bld(x, z, 0);
      tower(g, w, d, h, 0, 0, 0, STYLE.brick);
      for (var i = 0; i < 4; i++) cyl(g, 0.3, 0.3, 1.1 + r() * 0.5, "#2a1f1a", -w / 2 + 1 + i * (w - 2) / 3, h, r() * 2 - 1, 6);
    }
    tenement(-39, -9, 9, 8, 17);
    tenement(-53, -21, 9, 9, 21);
    tenement(41, -10, 9, 8, 19);
    tenement(55, -22, 9, 9, 16);

    // rail line + a train that crosses behind the plaza
    var RZ = -14;
    box(root, 190, 0.22, 4.8, "#2a2823", 0, 0.02, RZ, 0, { rough: 1 });
    [-0.75, 0.75].forEach(function (o) { box(root, 190, 0.28, 0.22, "#77766c", 0, 0.24, RZ + o, 0, { metal: 0.5, rough: 0.5 }); });
    var sg = new T.BoxGeometry(0.4, 0.2, 2.6);
    B.geos.push(sg);
    var sleepers = new T.InstancedMesh(sg, M("#3a2a1c"), 95);
    var sm = new T.Matrix4();
    for (var i = 0; i < 95; i++) { sm.setPosition(-94 + i * 2, 0.3, RZ); sleepers.setMatrixAt(i, sm); }
    sleepers.receiveShadow = true;
    root.add(sleepers);

    var train = new T.Group();
    train.position.set(-90, 0.3, RZ);
    root.add(train);
    var bg = new T.CylinderGeometry(1.15, 1.15, 5, 10); bg.rotateZ(Math.PI / 2);
    mesh(train, bg, M("#1e1e20", { metal: 0.3 }), 0.6, 2.05, 0);
    cyl(train, 0.32, 0.46, 1.5, "#131313", 2.4, 3.0, 0, 8);
    ball(train, 0.5, BRASS, 0.4, 3.15, 0, 7, { metal: 0.6 });
    box(train, 2.4, 3.1, 2.7, "#3a2c24", -2.2, 0.9, 0);
    box(train, 2.8, 0.3, 3.1, "#22201d", -2.2, 4.0, 0);
    [-1, 0.6, 2.2].forEach(function (wx) {
      [-1.2, 1.2].forEach(function (wz) {
        var wg = new T.CylinderGeometry(0.85, 0.85, 0.28, 12); wg.rotateX(Math.PI / 2);
        mesh(train, wg, M("#151515"), wx, 0.85, wz);
      });
    });
    [["#5a3a26", 0], ["#2b2b2b", 1], ["#5a3a26", 2]].forEach(function (w) {
      var wx = -8.2 - w[1] * 7.6;
      box(train, 6.4, 2.5, 2.9, w[0], wx, 0.7, 0);
      if (w[0] === "#2b2b2b") box(train, 5.8, 0.7, 2.5, "#111", wx, 3.2, 0);
      [-1.6, 1.6].forEach(function (o) {
        [-1.2, 1.2].forEach(function (wz) {
          var wg = new T.CylinderGeometry(0.6, 0.6, 0.26, 10); wg.rotateX(Math.PI / 2);
          mesh(train, wg, M("#151515"), wx + o, 0.6, wz);
        });
      });
    });

    b.updaters.push(function (t, dt) {
      train.position.x += 7.5 * dt;
      if (train.position.x > 100) train.position.x = -100;
      smokes.forEach(function (s) {
        var ph = (t * 0.09 + s.ph) % 1;
        s.m.visible = b.age > 1.4;
        s.m.position.set(s.x + ph * 9, s.y + ph * 16, s.z + Math.sin(ph * 6 + s.ph * 9));
        s.m.scale.setScalar(1.3 + ph * 4.2);
        s.mat.opacity = 0.55 * (1 - ph) * Math.min(1, ph * 8);
      });
    });

    // gas lamps
    [-12, 12].forEach(function (x) {
      var g = bld(x, 4.5, 0, 0.8);
      cyl(g, 0.1, 0.14, 3.6, "#1c1a17", 0, 0, 0, 6);
      glowBall(g, 0.32, "#f1cf6a", 0, 3.9, 0);
    });
    lamp(-12, 4, 4.5, "#e6c45a", 1.3, 28, 0.4);

    // hints: a rolled newspaper on a stoop, and the pest-control van (from Era 4 on)
    var st = bld(-16, 6.5, 0, 0.9);
    box(st, 3.2, 0.5, 1.8, "#4a4640", 0, 0, 0);
    newspaper(st, 0, 0.9, 0, 0.3);
    pestVan(17, 1.5, 0, 1.0, false);
  }

  // ------------------------------------------------------------------ ERA 5 — Modern
  // Glass towers, a traffic road, neon, a power grid overhead.
  function buildModern(b) {
    var r = b.rng, root = b.root;
    var cars = [];

    function skyscraper(x, z, w, d, h, kind) {
      var g = bld(x, z, 0);
      tower(g, w, d, h, 0, 0, 0, STYLE.glass);
      if (kind === 1) { tower(g, w * 0.66, d * 0.66, h * 0.16, 0, h, 0, STYLE.glass); }
      if (kind === 2) { var cp = cone(g, Math.max(w, d) * 0.72, 9, "#8fa6bb", 0, h, 0, 4, { metal: 0.5, rough: 0.3 }); cp.rotation.y = Math.PI / 4; }
      if (kind === 3) { cyl(g, 0.14, 0.2, 11, "#c7ccd2", 0, h, 0, 5); glowBall(g, 0.35, "#ff4040", 0, h + 11, 0); }
    }
    [[-52, -34, 14, 12, 30, 1], [-34, -46, 12, 12, 46, 3], [-16, -38, 10, 10, 26, 0], [4, -60, 16, 14, 56, 2],
     [22, -44, 12, 12, 38, 3], [40, -38, 14, 14, 30, 1], [56, -52, 12, 12, 44, 0], [-68, -56, 14, 14, 42, 2],
     [-46, -82, 16, 14, 64, 3], [22, -92, 18, 16, 68, 1], [50, -84, 14, 14, 52, 0], [-10, -84, 14, 14, 48, 2],
     [74, -34, 12, 12, 26, 0], [-82, -30, 12, 12, 24, 1]]
      .forEach(function (t) { skyscraper(t[0], t[1], t[2], t[3], t[4], t[5]); });

    // neon-fronted mid-rises + hints (swatter on a windowsill, bug zapper on the wall)
    function midrise(x, z, w, d, h, neonA, neonB) {
      var g = bld(x, z, 0, 0.3);
      tower(g, w, d, h, 0, 0, 0, STYLE.concrete);
      box(g, w * 0.9, 0.3, 0.7, "#b9bcc2", 0, 2.6, d / 2 + 0.05);
      glowBox(g, 6.2, 1.1, 0.3, neonA, -1, 3.1, d / 2 + 0.2);
      glowBox(g, 0.5, 4.4, 0.3, neonB, w / 2 - 1.4, 2.2, d / 2 + 0.2);
      box(g, 2, 2.6, 0.4, "#1c2230", -w / 2 + 2, 0, d / 2 + 0.02);
      return g;
    }
    var left = midrise(-31, -14, 12, 10, 17, "#ff3fa8", "#38e1ff");
    var right = midrise(32, -14, 12, 10, 15, "#38e1ff", "#ffb02e");
    box(left, 3.2, 0.25, 1.0, "#b9bcc2", 2.6, 4.6, 5.3);
    swatter(left, 2.6, 4.85, 5.3, 0.15, 0.2, "#d24a3a");
    bugZapper(right, -2.6, 3.4, 5.25, "#8fb7ff");
    lamp(-30, 4, -6, "#ff3fa8", 1.1, 24, 0);
    lamp(30, 4, -6, "#38e1ff", 1.1, 24, 0);

    // road, sidewalks, lane dashes
    box(root, 190, 0.05, 9.6, "#2d2f33", 0, 0.03, -9.2, 0, { rough: 1 });
    box(root, 190, 0.16, 1.6, "#a5a8ae", 0, 0.03, -3.6, 0, { rough: 1 });
    box(root, 190, 0.16, 1.6, "#a5a8ae", 0, 0.03, -14.8, 0, { rough: 1 });
    for (var d = -84; d <= 84; d += 7) glowBox(root, 2.6, 0.02, 0.22, "#e8e8e0", d, 0.09, -9.2);

    function car(x, z, dir, col, speed) {
      var g = bld(x, z, dir > 0 ? 0 : Math.PI, r() * 1.2);
      box(g, 4.2, 0.95, 1.9, col, 0, 0.35, 0, 0, { metal: 0.4, rough: 0.4 });
      box(g, 2.2, 0.85, 1.7, "#243040", -0.2, 1.3, 0, 0, { metal: 0.6, rough: 0.2 });
      [-1.3, 1.3].forEach(function (wx) {
        [-0.85, 0.85].forEach(function (wz) {
          var wg = new T.CylinderGeometry(0.38, 0.38, 0.3, 10); wg.rotateX(Math.PI / 2);
          mesh(g, wg, M("#101012"), wx, 0.38, wz);
        });
      });
      [-0.6, 0.6].forEach(function (o) {
        glowBox(g, 0.1, 0.25, 0.4, "#fff6c8", 2.1, 0.7, o);
        glowBox(g, 0.1, 0.25, 0.4, "#ff3030", -2.1, 0.7, o);
      });
      cars.push({ g: g, dir: dir, speed: speed });
    }
    var CC = ["#c9382f", "#e0e0dc", "#2f5fa8", "#d9a92a", "#3c3f46", "#f0f0f0", "#2e8a5a", "#8a3fa8"];
    for (var c = 0; c < 5; c++) car(-70 + c * 30 + r() * 8, -7.6, 1, CC[c % 8], 7 + r() * 5);
    for (var c2 = 0; c2 < 5; c2++) car(-60 + c2 * 30 + r() * 8, -10.8, -1, CC[(c2 + 3) % 8], 6 + r() * 5);
    b.updaters.push(function (t, dt) {
      cars.forEach(function (c) {
        c.g.position.x += c.dir * c.speed * dt;
        if (c.g.position.x > 95) c.g.position.x = -95;
        if (c.g.position.x < -95) c.g.position.x = 95;
      });
    });

    // street lamps + traffic lights
    [-32, -20, -8, 8, 20, 32].forEach(function (x) {
      var g = bld(x, -4.2, 0, 0.6);
      cyl(g, 0.1, 0.14, 6.2, "#3a3f46", 0, 0, 0, 6);
      box(g, 1.4, 0.12, 0.12, "#3a3f46", 0.6, 6.1, 0);
      glowBox(g, 0.7, 0.16, 0.34, "#fff2c9", 1.15, 6.0, 0);
    });
    [-5, 5].forEach(function (x) {
      var g = bld(x, -4.4, 0, 0.7);
      cyl(g, 0.08, 0.1, 4.6, "#2a2d33", 0, 0, 0, 6);
      box(g, 0.4, 1.2, 0.35, "#1a1c20", 0, 4.6, 0);
      glowBall(g, 0.13, "#ff4040", 0, 5.55, 0.2);
      glowBall(g, 0.13, "#3a3a20", 0, 5.2, 0.2);
      glowBall(g, 0.13, "#20402a", 0, 4.85, 0.2);
    });

    // power grid: two pylons in the foreground carry wires across the sky
    var pg = bld(0, 0, 0, 1.0);
    var wireMat = new T.LineBasicMaterial({ color: "#14171b" });
    B.mats.push(wireMat);
    function pylon(x, z, h) {
      [-1, 1].forEach(function (sx) {
        [-1, 1].forEach(function (sz) { box(pg, 0.36, h, 0.36, "#4a4f55", x + sx * 1.3, 0, z + sz * 1.3); });
      });
      [0.2, 0.42, 0.64].forEach(function (f) {
        box(pg, 2.9, 0.22, 0.22, "#4a4f55", x, h * f, z - 1.3);
        box(pg, 2.9, 0.22, 0.22, "#4a4f55", x, h * f, z + 1.3);
        box(pg, 0.22, 0.22, 2.9, "#4a4f55", x - 1.3, h * f, z);
        box(pg, 0.22, 0.22, 2.9, "#4a4f55", x + 1.3, h * f, z);
      });
      box(pg, 0.4, 0.4, 10, "#4a4f55", x, h * 0.86, z);
      box(pg, 0.4, 0.4, 7.4, "#4a4f55", x, h * 0.7, z);
      [-4.6, 4.6].forEach(function (o) { cyl(pg, 0.2, 0.2, 0.8, "#c8ccd2", x, h * 0.86 - 0.8, z + o, 6); });
      [-3.4, 3.4].forEach(function (o) { cyl(pg, 0.2, 0.2, 0.8, "#c8ccd2", x, h * 0.7 - 0.8, z + o, 6); });
    }
    var PZ = -1, PH = 20;
    var pylonsX = [-84, -28, 28, 84];
    pylonsX.forEach(function (x) { pylon(x, PZ, PH); });
    for (var s = 0; s < pylonsX.length - 1; s++) {
      [[PH * 0.86 - 0.8, -4.6], [PH * 0.86 - 0.8, 4.6], [PH * 0.7 - 0.8, -3.4], [PH * 0.7 - 0.8, 3.4]].forEach(function (w) {
        var pts = [], span = pylonsX[s + 1] - pylonsX[s];
        for (var k = 0; k <= 24; k++) {
          var u = k / 24;
          pts.push(pylonsX[s] + span * u, w[0] - 2.6 * (1 - Math.pow(2 * u - 1, 2)), PZ + w[1]);
        }
        var lg = new T.BufferGeometry();
        lg.setAttribute("position", new T.Float32BufferAttribute(pts, 3));
        B.geos.push(lg);
        pg.add(new T.Line(lg, wireMat));
      });
    }

    // hint: the pest-control van at the edge of frame
    pestVan(16, 2.5, 0, 1.0, false);
  }

  // ------------------------------------------------------------------ ERA 6 — AI Age
  // Chrome and white, cyan/violet emissive spires, drones, networked lights.
  function buildAIAge(b) {
    var r = b.rng, root = b.root;
    var WHITE = "#f1f5f9", CYAN = "#3fe6ff", VIOLET = "#9a6bff";
    var rings = [], tops = [];

    function spire(x, z, h, col, delay) {
      var g = bld(x, z, 0, delay);
      cyl(g, 4.6, 5.3, 5, WHITE, 0, 0, 0, 16, { metal: 0.05, rough: 0.4 });
      cyl(g, 0.7, 3.4, h, WHITE, 0, 4.6, 0, 16, { metal: 0.05, rough: 0.4 });
      for (var k = 1; k <= 7; k++) {
        var f = k / 8, rad = lerp(3.4, 0.7, f) + 0.16;
        var rm = new T.MeshBasicMaterial({ color: col });
        B.mats.push(rm);
        var rg = new T.CylinderGeometry(rad, rad, 0.42, 16);
        mesh(g, rg, rm, 0, 4.6 + h * f, 0);
        rings.push({ m: rm, c: new T.Color(col), k: k, off: x * 0.05 });
      }
      glowBall(g, 0.8, col, 0, h + 5.4, 0);
      tops.push(new T.Vector3(x, h + 5.4, z));
    }
    [[-44, -68, 52, CYAN], [-14, -80, 64, VIOLET], [16, -72, 46, CYAN], [44, -76, 58, VIOLET],
     [-76, -80, 44, VIOLET], [76, -78, 50, CYAN]].forEach(function (s, i) { spire(s[0], s[1], s[2], s[3], 0.2 + i * 0.15); });

    function aiTower(x, z, w, d, h, round) {
      var g = bld(x, z, 0);
      if (round) {
        cyl(g, w / 2, w / 2 + 0.6, h, WHITE, 0, 0, 0, 20, { metal: 0.05, rough: 0.4 });
        for (var k = 1; k < 6; k++) {
          var bg = new T.CylinderGeometry(w / 2 + 0.12, w / 2 + 0.12, 0.3, 20);
          mesh(g, bg, MB(k % 2 ? CYAN : VIOLET), 0, h * k / 6, 0);
        }
      } else {
        tower(g, w, d, h, 0, 0, 0, STYLE.ai);
      }
      tops.push(new T.Vector3(x, h + 0.5, z));
    }
    aiTower(-30, -44, 12, 12, 34, false);
    aiTower(30, -46, 12, 12, 40, false);
    aiTower(-58, -50, 14, 14, 44, false);
    aiTower(58, -52, 14, 14, 34, false);
    aiTower(-4, -50, 11, 11, 28, true);
    aiTower(2, -100, 20, 18, 56, false);
    // data halls with emissive strips
    [[-36, -22], [36, -22]].forEach(function (p, i) {
      var g = bld(p[0], p[1], 0, 0.3);
      tower(g, 20, 12, 7, 0, 0, 0, STYLE.ai);
      glowBox(g, 18, 0.25, 0.2, i ? VIOLET : CYAN, 0, 4.6, 6.05);
      glowBox(g, 18, 0.25, 0.2, i ? VIOLET : CYAN, 0, 1.8, 6.05);
    });

    // floor grid on the plaza
    var gp = [];
    for (var gx = -48; gx <= 48; gx += 4) gp.push(gx, 0.07, -24, gx, 0.07, 16);
    for (var gz = -24; gz <= 16; gz += 4) gp.push(-48, 0.07, gz, 48, 0.07, gz);
    var gg = new T.BufferGeometry();
    gg.setAttribute("position", new T.Float32BufferAttribute(gp, 3));
    var gm = new T.LineBasicMaterial({ color: "#7fe8ff", transparent: true, opacity: 0.32 });
    B.geos.push(gg); B.mats.push(gm);
    root.add(new T.LineSegments(gg, gm));

    // network lines between tower tops, with pulses travelling along them
    var netMat = new T.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.5 });
    B.mats.push(netMat);
    var curves = [];
    for (var i = 0; i < tops.length; i++) {
      var A = tops[i], C = tops[(i + 2) % tops.length];
      var mid = new T.Vector3().addVectors(A, C).multiplyScalar(0.5); mid.y += 12;
      var pts = [], arr = [];
      for (var k = 0; k <= 30; k++) {
        var u = k / 30;
        var px = (1 - u) * (1 - u) * A.x + 2 * (1 - u) * u * mid.x + u * u * C.x;
        var py = (1 - u) * (1 - u) * A.y + 2 * (1 - u) * u * mid.y + u * u * C.y;
        var pz = (1 - u) * (1 - u) * A.z + 2 * (1 - u) * u * mid.z + u * u * C.z;
        pts.push(px, py, pz); arr.push([px, py, pz]);
      }
      var lg = new T.BufferGeometry();
      lg.setAttribute("position", new T.Float32BufferAttribute(pts, 3));
      B.geos.push(lg);
      var line = new T.Line(lg, netMat);
      line.userData.noGrow = true; line.visible = false;
      root.add(line);
      var pulse = glowBall(root, 0.7, i % 2 ? VIOLET : CYAN, 0, 0, 0);
      pulse.userData.noGrow = true; pulse.visible = false;
      curves.push({ line: line, pulse: pulse, pts: arr, off: r() });
    }

    // drones
    var drones = [];
    for (var d = 0; d < 10; d++) {
      var dg = new T.Group();
      dg.userData.noGrow = true; dg.visible = false;
      var body = new T.CylinderGeometry(0.55, 0.45, 0.2, 10);
      mesh(dg, body, M("#e8eef4", { metal: 0.4, rough: 0.3 }), 0, 0, 0);
      mesh(dg, new T.BoxGeometry(0.5, 0.08, 0.5), MB(d % 2 ? VIOLET : CYAN), 0, -0.14, 0);
      var blades = [];
      [[0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]].forEach(function (o) {
        var bl = mesh(dg, new T.BoxGeometry(0.8, 0.03, 0.09), M("#39414d"), o[0], 0.16, o[1]);
        blades.push(bl);
      });
      root.add(dg);
      drones.push({ g: dg, blades: blades, cx: (r() - 0.5) * 70, cy: 6 + r() * 18, cz: -30 + r() * 34,
        ax: 10 + r() * 22, ay: 1 + r() * 3, az: 6 + r() * 12, sp: 0.12 + r() * 0.16, ph: r() * TAU });
    }
    var tmp = new T.Vector3();
    b.updaters.push(function (t, dt) {
      var show = b.age > 1.6;
      rings.forEach(function (g) {
        var p = 0.5 + 0.5 * Math.sin(t * 1.8 - g.k * 0.8 + g.off);
        g.m.color.copy(g.c).multiplyScalar(0.28 + 0.72 * p);
      });
      curves.forEach(function (c) {
        c.line.visible = show; c.pulse.visible = show;
        var u = (t * 0.16 + c.off) % 1, idx = Math.min(c.pts.length - 1, Math.floor(u * (c.pts.length - 1)));
        var q = c.pts[idx];
        c.pulse.position.set(q[0], q[1], q[2]);
      });
      drones.forEach(function (d) {
        d.g.visible = show;
        var a = t * d.sp + d.ph;
        var x = d.cx + Math.sin(a) * d.ax, y = d.cy + Math.sin(a * 1.7) * d.ay, z = d.cz + Math.cos(a * 0.9) * d.az;
        tmp.set(x - d.g.position.x, 0, z - d.g.position.z);
        if (tmp.lengthSq() > 1e-6) d.g.rotation.y = Math.atan2(tmp.x, tmp.z);
        d.g.position.set(x, y, z);
        d.blades.forEach(function (bl) { bl.rotation.y += dt * 50; });
      });
    });

    // hints: a UV bug-zapper column at the plaza edge, and the (cleaner) pest-control van
    var zg = bld(-16, 4, 0, 1.0);
    cyl(zg, 0.5, 0.6, 1.1, WHITE, 0, 0, 0, 10);
    mesh(zg, new T.CylinderGeometry(0.32, 0.32, 1.4, 10), MB("#9a7dff"), 0, 1.8, 0);
    cyl(zg, 0.46, 0.5, 0.15, WHITE, 0, 2.5, 0, 10);
    pestVan(17, 2.5, 0, 1.1, true);
    lamp(-20, 8, -4, "#4ff0ff", 0.9, 40, 0);
    lamp(20, 8, -4, "#9a6bff", 0.9, 40, 0);
  }

  // ------------------------------------------------------------------ era manager
  var BUILDERS = { 1: buildStoneAge, 2: buildBronzeAge, 3: buildMedieval, 4: buildIndustrial, 5: buildModern, 6: buildAIAge };

  function buildEra(n) {
    var b = {
      era: n, root: new T.Group(), items: [], updaters: [], lamps: [],
      geos: [], mats: [], texs: [], cache: {}, rng: makeRng(1000 + n * 77), age: 0, done: false
    };
    B = b;
    try {
      BUILDERS[n](b);
    } catch (e) {
      console.error("[Scene] building era " + n + " failed:", e);
    }
    B = null;
    // any root-level piece the builder didn't register (rails, canals, road...) rises with the rest
    var reg = [];
    b.items.forEach(function (it) { reg.push(it.g); });
    b.root.children.forEach(function (c) {
      if (c.userData.noGrow || reg.indexOf(c) !== -1) return;
      c.scale.y = 0.001;
      b.items.push({ g: c, d: 0.3 });
    });
    scene.add(b.root);
    return b;
  }

  function disposeEra(b) {
    scene.remove(b.root);
    b.geos.forEach(function (g) { g.dispose(); });
    b.mats.forEach(function (m) { m.dispose(); });
    b.texs.forEach(function (t) { t.dispose(); });
  }

  function retireEra(b) {
    b.updaters = [];
    b.root.children.forEach(function (c) { if (c.userData.noGrow) c.visible = false; });
    dying.push({ b: b, t: 0 });
  }

  function updateGrowth(b, dt) {
    b.age += dt;
    if (b.done) return;
    var all = true;
    for (var i = 0; i < b.items.length; i++) {
      var it = b.items[i];
      var k = clamp((b.age - it.d) / GROW_DUR, 0, 1);
      it.g.scale.y = Math.max(0.001, ease(k));
      if (k < 1) all = false;
    }
    if (all) b.done = true;
  }

  function updateDying(dt) {
    for (var n = dying.length - 1; n >= 0; n--) {
      var d = dying[n], all = true;
      d.t += dt;
      d.b.items.forEach(function (it) {
        var k = clamp((d.t - it.d * 0.5) / 0.9, 0, 1);
        it.g.scale.y = Math.max(0.001, 1 - ease(k));
        if (k < 1) all = false;
      });
      if (all) { disposeEra(d.b); dying.splice(n, 1); }
    }
  }

  function assignLamps(specs) {
    for (var i = 0; i < lamps.length; i++) {
      var L = lamps[i], s = specs[i];
      if (s) {
        L.light.position.set(s.x, s.y, s.z);
        L.light.color.set(s.c);
        L.light.distance = s.d;
        L.target = s.i; L.fl = s.fl;
      } else {
        L.target = 0;
      }
    }
  }

  // ------------------------------------------------------------------ rig update
  var skyT = null;

  function updateSky() {
    var col = skyMesh.geometry.attributes.color, arr = col.array, hz = cur.horizon, zn = cur.zenith;
    for (var i = 0; i < skyT.length; i++) {
      var t = skyT[i];
      arr[i * 3] = lerp(hz.r, zn.r, t);
      arr[i * 3 + 1] = lerp(hz.g, zn.g, t);
      arr[i * 3 + 2] = lerp(hz.b, zn.b, t);
    }
    col.needsUpdate = true;
  }

  function applyLook() {
    var az = cur.sunAz * DEG, el = cur.sunEl * DEG;
    sun.color.copy(cur.sunC);
    sun.intensity = cur.sunI;
    sun.position.set(sunTarget.position.x + Math.cos(el) * Math.sin(az) * 170,
                     sunTarget.position.y + Math.sin(el) * 170,
                     sunTarget.position.z + Math.cos(el) * Math.cos(az) * 170);
    var sc = sun.shadow.camera, e = cur.shadow;
    if (Math.abs(sc.right - e) > 0.05) {
      sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e;
      sc.updateProjectionMatrix();
    }
    hemi.color.copy(cur.hemiSky);
    hemi.groundColor.copy(cur.hemiGnd);
    hemi.intensity = cur.hemiI;
    scene.fog.color.copy(cur.horizon);
    scene.fog.near = cur.fogNear; scene.fog.far = cur.fogFar;
    renderer.setClearColor(cur.horizon);
    groundMesh.material.color.copy(cur.ground);
    plazaMesh.material.color.copy(cur.plaza);

    fm.body.color.copy(cur.body);
    fm.body.emissive.copy(cur.body).multiplyScalar(0.3);
    fm.abd.color.copy(cur.abd);
    fm.abd.emissive.copy(cur.abd).multiplyScalar(0.25);
    fm.eye.color.copy(cur.eye);
    fm.eye.emissive.copy(cur.eye);
    fm.eye.emissiveIntensity = cur.eyeEmis;
    fm.wing.color.copy(cur.wing);
    fm.wing.opacity = cur.wingOp;
    fm.leg.color.copy(cur.leg);
    fm.leg.emissive.copy(cur.leg).multiplyScalar(0.3);
    updateSky();
  }

  function updateCamera(t) {
    var aspect = viewW / viewH;
    var fit = clamp(1.6 / aspect, 1, 2.4);            // narrow windows pull the camera back
    var lx = cur.lookX, ly = cur.lookY, lz = cur.lookZ;
    var px = lx + (cur.camX - lx) * fit, py = ly + (cur.camY - ly) * fit, pz = lz + (cur.camZ - lz) * fit;
    // slow sway only — no orbit, no player control (spec §5.2)
    var dx = Math.sin(t * 0.13) * 0.9 + Math.sin(t * 0.047 + 1.3) * 0.5;
    var dy = Math.sin(t * 0.09 + 0.6) * 0.25;
    var dz = Math.sin(t * 0.07 + 2.1) * 0.7;
    camera.position.set(px + dx, py + dy, pz + dz);
    camera.lookAt(lx + Math.sin(t * 0.09 + 2) * 0.6, ly + Math.sin(t * 0.07) * 0.3, lz);
    camera.rotateZ(Math.sin(t * 0.05) * 0.004);
    camera.fov = cur.fov;
    camera.updateProjectionMatrix();
    skyMesh.position.copy(camera.position);
  }

  function checkSize() {
    var w = container.clientWidth | 0, h = container.clientHeight | 0;
    if (w === viewW && h === viewH) return;
    viewW = w; viewH = h;
    if (w > 0 && h > 0) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.setViewOffset(w, h, 0, Math.round(h * VIEW_SHIFT), w, h);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
    lastNow = now;
    checkSize();
    if (viewW <= 0 || viewH <= 0) return;          // container hidden (title screen)
    time += dt;

    if (!frozen) {
      if (lookT < 1) {
        lookT = Math.min(1, lookT + dt / lookDur);
        mixLook(cur, from, to, ease(lookT));
        applyLook();
      }
      if (eraState) updateGrowth(eraState, dt);
      updateDying(dt);
    }
    if (eraState) eraState.updaters.forEach(function (u) { u(time, dt); });

    lamps.forEach(function (L, i) {
      var flick = 1 + L.fl * (Math.sin(time * 13 + i * 3) * 0.08 + Math.sin(time * 31 + i) * 0.05);
      L.light.intensity += (L.target * flick - L.light.intensity) * Math.min(1, dt * 3);
    });

    updateFlies(dt, time);
    updateCamera(time);
    renderer.render(scene, camera);
  }

  // ------------------------------------------------------------------ public API
  function init(containerEl) {
    if (inited || dead) return;
    if (!T) { dead = true; console.warn("[Scene] THREE is not loaded; Scene is disabled."); return; }
    container = containerEl;
    try {
      renderer = new T.WebGLRenderer({ antialias: true });
    } catch (e) {
      dead = true;
      console.warn("[Scene] WebGL is unavailable; Scene is disabled.", e);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    var cv = renderer.domElement;
    cv.style.cssText = "display:block;width:100%;height:100%";
    container.appendChild(cv);

    scene = new T.Scene();
    scene.fog = new T.Fog(0x000000, 60, 260);
    camera = new T.PerspectiveCamera(48, 1.6, 0.5, 1500);

    // the sun and its ambient fill
    sun = new T.DirectionalLight(0xffffff, 1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.05;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 420;
    sunTarget = new T.Object3D();
    sunTarget.position.set(0, 0, -18);
    scene.add(sunTarget);
    sun.target = sunTarget;
    scene.add(sun);
    hemi = new T.HemisphereLight(0xffffff, 0x444444, 0.7);
    scene.add(hemi);

    // fixed pool of point lights: fire / torches / neon, claimed per era
    for (var i = 0; i < 5; i++) {
      var pl = new T.PointLight(0xffffff, 0, 30, 2);
      scene.add(pl);
      lamps.push({ light: pl, target: 0, fl: 0 });
    }

    // sky dome with a vertical gradient
    var sg = new T.SphereGeometry(700, 24, 14);
    var n = sg.attributes.position.count;
    skyT = new Float32Array(n);
    for (var v = 0; v < n; v++) skyT[v] = ease(clamp(sg.attributes.position.getY(v) / 700 / 0.6, 0, 1));
    sg.setAttribute("color", new T.BufferAttribute(new Float32Array(n * 3), 3));
    skyMesh = new T.Mesh(sg, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide, fog: false, depthWrite: false }));
    skyMesh.renderOrder = -1;
    skyMesh.frustumCulled = false;
    scene.add(skyMesh);

    // ground + plaza
    var gg = new T.PlaneGeometry(1800, 1800); gg.rotateX(-Math.PI / 2);
    groundMesh = new T.Mesh(gg, new T.MeshStandardMaterial({ roughness: 1 }));
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);
    var pg = new T.CircleGeometry(26, 48); pg.rotateX(-Math.PI / 2);
    plazaMesh = new T.Mesh(pg, new T.MeshStandardMaterial({ roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    plazaMesh.position.set(0, 0.03, -1);
    plazaMesh.scale.set(1.55, 1, 1);
    plazaMesh.receiveShadow = true;
    scene.add(plazaMesh);

    buildFlies();
    popTarget = visibleCountFor(DEFAULT_POPULATION);

    loadLook(cur, ERA[1]);
    copyLook(from, cur); copyLook(to, cur);
    applyLook();
    flyArea = ERA[1].area;

    if (typeof ResizeObserver !== "undefined") {
      resizeObs = new ResizeObserver(function () { checkSize(); });
      resizeObs.observe(container);
    }
    inited = true;
    requestAnimationFrame(frame);
  }

  function setEra(n) {
    if (dead || !inited) return;
    n = Math.round(n);
    if (!(n >= 1 && n <= 6)) return;

    if (frozen) {
      // a new run begins: un-freeze and restore the starting crowd until Game says otherwise
      frozen = false;
      popTarget = visibleCountFor(DEFAULT_POPULATION);
    }
    if (n === currentEra) return;

    var first = currentEra === 0;
    copyLook(from, cur);
    loadLook(to, ERA[n]);
    lookT = 0;
    lookDur = first ? 0.001 : ERA_TWEEN;

    if (eraState) retireEra(eraState);
    eraState = buildEra(n);
    eraState.age = first ? 0 : -0.5;               // let the old era start sinking before the new one rises
    assignLamps(eraState.lamps);
    flyArea = ERA[n].area;
    currentEra = n;
  }

  function setPopulation(count) {
    if (dead) return;
    setFlyPopulation(count);
  }

  function freeze() {
    if (dead || !inited || frozen) return;
    frozen = true;
    // finish any transition in progress so the final scene is coherent, then hold it
    lookT = 1;
    mixLook(cur, from, to, 1);
    applyLook();
    if (eraState) {
      eraState.age = 999;
      eraState.items.forEach(function (it) { it.g.scale.y = 1; });
      eraState.done = true;
    }
    dying.forEach(function (d) { disposeEra(d.b); });
    dying.length = 0;
  }

  window.Scene = {
    init: init,
    setEra: setEra,
    setPopulation: setPopulation,
    freeze: freeze
  };
})();
