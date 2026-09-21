/* =========================================================================
   audio.js — PHASE 6 (procedural Web Audio: ambience beds + SFX)

   Owns the `GameAudio` global (build plan §2.2 — not `Audio`, which would
   shadow the native constructor) and implements exactly the API in build
   plan §2.6:

     GameAudio.init()
     GameAudio.setEraAmbience(eraNumber)
     GameAudio.playSFX(name)   // "decision_confirm" | "era_transition"
                               // | "milestone" | "ending"

   Everything is synthesised at runtime (oscillators, filtered noise, simple
   envelopes) — no audio files, no fetch(), no assets (spec §5.5). Nothing
   else is added to `window`.

   Sound design, per spec §5.5 and §1:
   - Every era has one looping "bed". All six share the same core idea — a
     small swarm of wing-beat buzzes around 150-260 Hz — and differ in what
     surrounds it: sparse wind and fire crackle (Stone Age) -> dry heat and
     canal water (Bronze) -> a low hall drone and a distant bell (Medieval)
     -> a mechanical drone with a steam chuff (Industrial) -> traffic and
     mains hum (Modern) -> clean stacked sine partials (AI Age).
   - SFX are short and dry. No stingers, no swells that announce a turn for
     the worse: the twist is protected in sound the same way it is in copy
     (spec §4.1, §5.5). The ending cue is the ambience fading out plus one
     fly winding down — nothing else.

   Autoplay gate (build plan §2.6, and one deliberate deviation — see the
   note on CREATE_CONTEXT_IN_INIT below): there is no resume() in the API.
   The AudioContext is resumed lazily inside setEraAmbience/playSFX; the
   first such call (setEraAmbience(1) in Game.startRun) happens inside the
   Start click, which is what satisfies the browser's gate.

   Failure mode (same philosophy as scene.js): if Web Audio is missing or
   throws, one console warning is logged and every call becomes a silent
   no-op. The game stays playable.
   ========================================================================= */

(function () {
  "use strict";

  /* ---- tuning (Phase 7 balance knobs) ----------------------------------------- */

  // DEVIATION FROM BUILD PLAN §2.6, flagged in the Phase 6 handover:
  // the plan says init() "sets up the AudioContext" at page load. Browsers
  // print an autoplay warning for a context constructed before any user
  // gesture, and Phase 6's definition of done is "no AudioContext warnings
  // in the console". With this false, init() only checks that Web Audio
  // exists; the context is built on the first real call, inside the Start
  // click, where it starts already running. Set true for the literal
  // contract behaviour (context built at page load, resumed lazily).
  var CREATE_CONTEXT_IN_INIT = false;

  var MASTER_LEVEL = 0.5;     // was 0.8; x0.75 (about -2.5 dB) after playtest feedback
  var AMBIENCE_LEVEL = 0.6; //0.9
  var SFX_LEVEL = 1.3; //0.9

  // Trim per era so the six beds sit at a similar loudness (measured
  // offline in audio-test.js). Index 0 = Era 1.
  var ERA_TRIM_DB = [0.6, 1.5, -2.6, -0.2, 0.4, -0.2];

  var FIRST_FADE_IN_SECONDS = 2.5;   // first bed of a run
  var CROSSFADE_SECONDS = 3;         // era -> era
  var ENDING_FADE_SECONDS = 6;       // ambience out behind the ending card

  var REVERB_SECONDS = 1.6;
  var REVERB_SEND_AMBIENCE = 0.12;
  var REVERB_SEND_SFX = 0.2;

  var LAST_ERA = 6;
  var NOISE_SECONDS = 4;             // length of the shared looping noise buffers
  var PUMP_INTERVAL_MS = 100;        // how often bed schedulers wake up
  var LOOKAHEAD_SECONDS = 0.35;      // how far ahead they schedule one-shots

  /* ---- module state ----------------------------------------------------------- */

  var ctx = null;
  var master = null;
  var ambienceBus = null;
  var sfxBus = null;
  var noise = null;                  // { white, pink } shared AudioBuffers

  var bed = null;                    // the live bed, or null
  var currentEra = null;
  var initialized = false;
  var unavailable = false;
  var warnedUnavailable = false;
  var pausedByHidden = false;

  /* ---- small helpers ---------------------------------------------------------- */

  function warn(message, err) {
    console.warn("[GameAudio] " + message, err || "");
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function getContextConstructor() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function markUnavailable(message, err) {
    unavailable = true;
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      warn(message + " The game will run without sound.", err);
    }
  }

  /* ---- context setup ---------------------------------------------------------- */

  function makeNoiseBuffer(kind) {
    var rate = ctx.sampleRate;
    var length = Math.floor(NOISE_SECONDS * rate);
    var fade = Math.floor(0.1 * rate);
    var raw = new Float32Array(length + fade);
    var i;

    if (kind === "pink") {
      // Paul Kellet's economy pink-noise filter.
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (i = 0; i < raw.length; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    } else {
      for (i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1;
    }

    // Loop seam: the tail past `length` is cross-faded into the head, so the
    // sample after the last one is the original sequence's next sample.
    var buffer = ctx.createBuffer(1, length, rate);
    var data = buffer.getChannelData(0);
    for (i = 0; i < length; i++) data[i] = raw[i];
    for (i = 0; i < fade; i++) {
      var x = (i / fade) * Math.PI / 2;
      data[i] = raw[i] * Math.sin(x) + raw[length + i] * Math.cos(x);
    }

    // Normalise to a known RMS so filter/gain choices mean the same thing
    // for both colours.
    var sum = 0;
    for (i = 0; i < length; i++) sum += data[i] * data[i];
    var scale = 0.3 / Math.sqrt(sum / length || 1);
    for (i = 0; i < length; i++) data[i] *= scale;
    return buffer;
  }

  function makeImpulse() {
    // A short, dark, exponentially decaying stereo tail — enough room to
    // stop the synthesis sounding like it's inside the listener's head.
    var rate = ctx.sampleRate;
    var length = Math.floor(REVERB_SECONDS * rate);
    var buffer = ctx.createBuffer(2, length, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buffer.getChannelData(ch);
      var lp = 0;
      for (var i = 0; i < length; i++) {
        var decay = Math.pow(1 - i / length, 3.2);
        lp += ((Math.random() * 2 - 1) - lp) * 0.35;
        data[i] = lp * decay;
      }
    }
    return buffer;
  }

  function buildGraph() {
    var compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;
    compressor.connect(ctx.destination);

    master = ctx.createGain();
    master.gain.value = MASTER_LEVEL;
    master.connect(compressor);

    ambienceBus = ctx.createGain();
    ambienceBus.gain.value = AMBIENCE_LEVEL;
    ambienceBus.connect(master);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = SFX_LEVEL;
    sfxBus.connect(master);

    var convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse();
    var reverbIn = ctx.createGain();
    reverbIn.connect(convolver);
    convolver.connect(master);

    var ambienceSend = ctx.createGain();
    ambienceSend.gain.value = REVERB_SEND_AMBIENCE;
    ambienceBus.connect(ambienceSend);
    ambienceSend.connect(reverbIn);

    var sfxSend = ctx.createGain();
    sfxSend.gain.value = REVERB_SEND_SFX;
    sfxBus.connect(sfxSend);
    sfxSend.connect(reverbIn);

    noise = { white: makeNoiseBuffer("white"), pink: makeNoiseBuffer("pink") };
  }

  function ensureContext() {
    if (ctx) return true;
    if (unavailable) return false;

    var Ctor = getContextConstructor();
    if (!Ctor) {
      markUnavailable("Web Audio is not available in this browser.");
      return false;
    }

    try {
      try {
        ctx = new Ctor({ latencyHint: "playback" });
      } catch (optionsErr) {
        ctx = new Ctor();      // older engines reject the options argument
      }
      buildGraph();
    } catch (err) {
      try { if (ctx && ctx.close) ctx.close(); } catch (ignore) { /* nothing to do */ }
      ctx = null;
      markUnavailable("Could not set up Web Audio.", err);
      return false;
    }
    return true;
  }

  // The lazy resume. Called at the top of every real entry point; cheap when
  // the context is already running. Skipped while the tab is hidden so a
  // background tab never starts making noise.
  function ensureRunning() {
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () { /* still gated; retried next call */ });
    } catch (err) { /* same */ }
  }

  function onVisibilityChange() {
    if (!ctx) return;
    if (document.hidden) {
      if (ctx.state === "running") {
        pausedByHidden = true;
        try {
          var s = ctx.suspend();
          if (s && s.catch) s.catch(function () {});
        } catch (err) { /* nothing to do */ }
      }
    } else if (pausedByHidden) {
      pausedByHidden = false;
      try {
        var r = ctx.resume();
        if (r && r.catch) r.catch(function () {});
      } catch (err) { /* nothing to do */ }
    }
  }

  /* ---- automation helpers ----------------------------------------------------- */

  // Equal-power fade built from plain linear ramps, so it behaves the same in
  // every engine (setValueCurveAtTime has stricter overlap rules). Starts from
  // wherever the parameter currently is, so interrupting a fade never jumps.
  function fade(param, target, seconds) {
    var t0 = ctx.currentTime;
    var from = param.value;
    var steps = 12;
    var rising = target > from;
    param.cancelScheduledValues(t0);
    param.setValueAtTime(from, t0);
    for (var i = 1; i <= steps; i++) {
      var x = i / steps;
      var shape = rising ? Math.sin(x * Math.PI / 2) : 1 - Math.cos(x * Math.PI / 2);
      param.linearRampToValueAtTime(from + (target - from) * shape, t0 + seconds * x);
    }
  }

  function makePanner(position) {
    if (!ctx.createStereoPanner) return null;
    var p = ctx.createStereoPanner();
    p.pan.value = position;
    return p;
  }

  /* ---- one-shot voices (used by SFX and by scheduled bed events) --------------- */

  // A filtered noise burst with a fast attack and an exponential decay.
  // o: { dur, attack, level, type, freq, freqEnd, q, pan }
  function burst(dest, t, o) {
    var src = ctx.createBufferSource();
    src.buffer = noise.white;

    var filter = ctx.createBiquadFilter();
    filter.type = o.type || "bandpass";
    filter.frequency.setValueAtTime(o.freq, t);
    filter.Q.value = o.q === undefined ? 0.8 : o.q;
    if (o.freqEnd) filter.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);

    var g = ctx.createGain();
    var attack = Math.min(o.attack || 0.002, o.dur * 0.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    src.connect(filter);
    filter.connect(g);
    var pan = o.pan !== undefined ? makePanner(o.pan) : null;
    if (pan) {
      g.connect(pan);
      pan.connect(dest);
    } else {
      g.connect(dest);
    }

    src.start(t, Math.random() * (NOISE_SECONDS - o.dur - 0.1), o.dur + 0.05);
    src.onended = function () {
      src.disconnect();
      filter.disconnect();
      g.disconnect();
      if (pan) pan.disconnect();
    };
  }

  // An enveloped oscillator: linear attack, exponential decay.
  // o: { freq, freqEnd, glide, type, level, attack, decay, lp, wobbleRate,
  //      wobbleCents, pan }
  function tone(dest, t, o) {
    var attack = o.attack || 0.003;
    var end = t + attack + o.decay;

    var osc = ctx.createOscillator();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.freqEnd) {
      osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + (o.glide || attack + o.decay));
    }

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, end);

    var extras = [];
    var last = osc;
    osc.connect(g);
    last = g;
    if (o.lp) {
      var lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = o.lp;
      lp.Q.value = 0.7;
      last.connect(lp);
      last = lp;
      extras.push(lp);
    }
    var pan = o.pan !== undefined ? makePanner(o.pan) : null;
    if (pan) {
      last.connect(pan);
      last = pan;
      extras.push(pan);
    }
    last.connect(dest);

    var lfo = null;
    var lfoGain = null;
    if (o.wobbleRate) {
      lfo = ctx.createOscillator();
      lfo.frequency.value = o.wobbleRate;
      lfoGain = ctx.createGain();
      lfoGain.gain.value = o.wobbleCents || 10;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start(t);
      lfo.stop(end + 0.05);
    }

    osc.start(t);
    osc.stop(end + 0.05);
    osc.onended = function () {
      osc.disconnect();
      g.disconnect();
      extras.forEach(function (n) { n.disconnect(); });
      if (lfo) {
        lfo.disconnect();
        lfoGain.disconnect();
      }
    };
  }

  /* ---- ambience bed machinery ------------------------------------------------- */

  // A bed is one era's looping soundscape: a set of always-running sources
  // (oscillators, looping noise) plus optional wall-clock schedulers that
  // drop one-shots (crackle, chuffs, bells) just ahead of the audio clock.
  // bed.out carries the fade, bed.dest carries the per-era trim.

  function track(bed, node) {
    bed.nodes.push(node);
    return node;
  }

  function trackSource(bed, src) {
    bed.nodes.push(src);
    bed.pending++;
    src.onended = function () {
      bed.pending--;
      if (bed.pending <= 0 && !bed.alive) disposeBed(bed);
    };
    return src;
  }

  function disposeBed(bed) {
    if (bed.disposed) return;
    bed.disposed = true;
    bed.nodes.forEach(function (n) {
      try { n.disconnect(); } catch (err) { /* already gone */ }
    });
    bed.nodes = [];
  }

  function bOsc(bed, type, freq) {
    var o = trackSource(bed, ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    o.start();
    return o;
  }

  function bNoise(bed, kind) {
    var s = trackSource(bed, ctx.createBufferSource());
    s.buffer = noise[kind];
    s.loop = true;
    // Random start point so two beds (or two crossfaded runs) never share
    // the same noise phase.
    s.start(0, Math.random() * NOISE_SECONDS);
    return s;
  }

  function bGain(bed, value) {
    var g = track(bed, ctx.createGain());
    g.gain.value = value;
    return g;
  }

  function bFilter(bed, type, freq, q) {
    var f = track(bed, ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q === undefined ? 0.7 : q;
    return f;
  }

  // Connects a -> b -> c ..., returns the last node.
  function chain() {
    for (var i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]);
    return arguments[arguments.length - 1];
  }

  // A sine LFO added onto an AudioParam: the param moves by +/- depth
  // around its own value.
  function bLfo(bed, rate, depth, param) {
    var o = bOsc(bed, "sine", rate);
    var g = bGain(bed, depth);
    chain(o, g, param);
    return o;
  }

  // Runs fn(time) for each event just before it is due, spaced by gapFn()
  // seconds. Uses the audio clock for timing, so events land precisely even
  // though the wake-up timer doesn't. Idles while the context isn't running.
  function schedule(bed, fn, gapFn, firstDelay) {
    var next = ctx.currentTime + firstDelay;
    var id = setInterval(function () {
      if (!bed.alive || !ctx || ctx.state !== "running") return;
      var now = ctx.currentTime;
      if (next < now) next = now;                  // after a stall: resume, don't burst
      var horizon = now + LOOKAHEAD_SECONDS;
      while (next < horizon) {
        try {
          fn(next);
        } catch (err) {
          warn("scheduled event failed", err);
        }
        next += Math.max(0.02, gapFn());
      }
    }, PUMP_INTERVAL_MS);
    bed.timers.push(id);
  }

  // One wing-beat voice: a lowpassed saw (or other) at roughly 190 Hz with a
  // slow pitch wander, a fast small flutter, and a slow swell so individual
  // flies drift in and out of the mix.
  // o: { freq, type, cutoff, level, pan, swell (0-1), flutter (cents) }
  function buzzVoice(bed, o) {
    var osc = bOsc(bed, o.type || "sawtooth", o.freq);
    var lp = bFilter(bed, "lowpass", o.cutoff || 800, 0.7);
    var g = bGain(bed, o.level);
    var pan = o.pan !== undefined ? makePanner(o.pan) : null;
    chain(osc, lp, g);
    if (pan) {
      track(bed, pan);
      chain(g, pan, bed.dest);
    } else {
      g.connect(bed.dest);
    }

    bLfo(bed, rand(0.15, 0.5), o.wander === undefined ? 14 : o.wander, osc.detune);
    var flutter = o.flutter === undefined ? 7 : o.flutter;
    if (flutter > 0) bLfo(bed, rand(7, 13), flutter, osc.detune);
    if (o.swell) bLfo(bed, rand(0.04, 0.16), o.level * o.swell, g.gain);
  }

  function buzzSwarm(bed, count, o) {
    for (var i = 0; i < count; i++) {
      buzzVoice(bed, {
        freq: o.freq * (1 + rand(-o.spread, o.spread)),
        type: o.type,
        cutoff: o.cutoff,
        level: o.level,
        pan: count === 1 ? 0 : rand(-0.75, 0.75),
        swell: o.swell,
        wander: o.wander,
        flutter: o.flutter
      });
    }
  }

  // A steady band of coloured noise: source -> filter -> gain -> bed.
  // Returns { filter, gain } so callers can attach LFOs.
  function noiseBand(bed, kind, type, freq, q, level) {
    var src = bNoise(bed, kind);
    var f = bFilter(bed, type, freq, q);
    var g = bGain(bed, level);
    chain(src, f, g, bed.dest);
    return { filter: f, gain: g };
  }

  // A drone partial: oscillator -> optional lowpass -> gain -> bed.
  function drone(bed, type, freq, level, cutoff, detuneCents) {
    var o = bOsc(bed, type, freq);
    if (detuneCents) o.detune.value = detuneCents;
    var g = bGain(bed, level);
    if (cutoff) {
      chain(o, bFilter(bed, "lowpass", cutoff, 0.7), g, bed.dest);
    } else {
      chain(o, g, bed.dest);
    }
    return { osc: o, gain: g };
  }

  // A cheap fire-crackle event: 1-3 very short bright noise ticks.
  function crackle(bed, t, level) {
    var n = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 2) : 1;
    for (var i = 0; i < n; i++) {
      burst(bed.dest, t + i * rand(0.012, 0.05), {
        dur: rand(0.012, 0.04),
        attack: 0.001,
        level: level * rand(0.35, 1),
        type: "bandpass",
        freq: rand(1600, 5200),
        q: 1.3,
        pan: rand(-0.6, 0.6)
      });
    }
  }

  // A soft, distant bell: inharmonic partials with different decay times.
  function bell(bed, t, f0, level) {
    var partials = [
      { r: 0.5, a: 0.5, d: 5.5 },
      { r: 1.0, a: 1.0, d: 6.5 },
      { r: 1.19, a: 0.45, d: 4.0 },
      { r: 1.56, a: 0.3, d: 3.2 },
      { r: 2.0, a: 0.35, d: 2.8 },
      { r: 2.51, a: 0.16, d: 1.8 },
      { r: 3.3, a: 0.08, d: 1.1 }
    ];
    var pan = rand(-0.5, 0.5);
    partials.forEach(function (p) {
      tone(bed.dest, t, {
        freq: f0 * p.r,
        level: level * p.a,
        attack: 0.006,
        decay: p.d,
        lp: 2200,
        pan: pan
      });
    });
  }

  /* ---- the six beds ----------------------------------------------------------- */

  var BEDS = {
    // 1 — Stone Age: sparse and organic. Wind, a small fire, a few flies.
    1: function (bed) {
      var wind = noiseBand(bed, "pink", "bandpass", 520, 0.6, 0.36);
      bLfo(bed, 0.05, 240, wind.filter.frequency);
      bLfo(bed, 0.083, 0.14, wind.gain.gain);

      noiseBand(bed, "pink", "lowpass", 130, 0.7, 0.08);        // earth-low air

      schedule(bed, function (t) { crackle(bed, t, 0.075); },
        function () { return rand(0.12, 1.3); }, 0.3);

      buzzSwarm(bed, 2, { freq: 186, spread: 0.12, cutoff: 620, level: 0.025, swell: 0.9 }); //lev 0.5
    },

    // 2 — Bronze Age: dry, bright heat, canal water, a low open-fifth drone.
    2: function (bed) {
      var wind = noiseBand(bed, "pink", "bandpass", 700, 0.5, 0.2);
      bLfo(bed, 0.06, 240, wind.filter.frequency);
      bLfo(bed, 0.1, 0.07, wind.gain.gain);

      var shimmer = noiseBand(bed, "white", "highpass", 5200, 0.7, 0.03);   // heat haze
      bLfo(bed, 0.19, 0.02, shimmer.gain.gain);

      var water = noiseBand(bed, "white", "bandpass", 950, 2.6, 0.06);      // irrigation canal
      bLfo(bed, 5.3, 380, water.filter.frequency);
      bLfo(bed, 8.7, 260, water.filter.frequency);
      bLfo(bed, 2.9, 0.03, water.gain.gain);

      var d1 = drone(bed, "triangle", 98, 0.05, 420);
      var d2 = drone(bed, "triangle", 146.8, 0.032, 420, 4);
      bLfo(bed, 0.05, 0.03, d1.gain.gain);
      bLfo(bed, 0.07, 0.02, d2.gain.gain);

      buzzSwarm(bed, 3, { freq: 192, spread: 0.12, cutoff: 700, level: 0.02, swell: 0.7 }); //lev 0.4
    },

    // 3 — Medieval: overcast wind, a stone-hall drone, torch crackle, and an
    // occasional distant bell.
    3: function (bed) {
      var wind = noiseBand(bed, "pink", "lowpass", 520, 0.6, 0.3);
      bLfo(bed, 0.045, 0.1, wind.gain.gain);

      var hall = [
        drone(bed, "sine", 73.4, 0.042, 500, 0),
        drone(bed, "triangle", 110, 0.028, 520, -3),
        drone(bed, "triangle", 110, 0.028, 520, 5),       // beating pair around A2
        drone(bed, "sine", 146.8, 0.017, 600, 0)
      ];
      bLfo(bed, 0.06, 0.017, hall[0].gain.gain);
      bLfo(bed, 0.09, 0.011, hall[3].gain.gain);

      schedule(bed, function (t) { crackle(bed, t, 0.045); },
        function () { return rand(0.4, 2.4); }, 0.6);

      var notes = [196, 220, 261.6, 293.7, 329.6];
      schedule(bed, function (t) {
        bell(bed, t, notes[Math.floor(Math.random() * notes.length)], 0.03);
      }, function () { return rand(18, 38); }, rand(9, 16));

      buzzSwarm(bed, 3, { freq: 188, spread: 0.13, cutoff: 640, level: 0.019, swell: 0.7 }); //lev 0.038
    },

    // 4 — Industrial: a mechanical drone under a steady four-count steam chuff.
    4: function (bed) {
      var a = drone(bed, "sawtooth", 55, 0.06, 240, 0);
      drone(bed, "sawtooth", 55.9, 0.05, 240, 0);           // slow beat against the first
      drone(bed, "square", 110, 0.016, 320, 0);
      bLfo(bed, 0.08, 0.02, a.gain.gain);

      noiseBand(bed, "pink", "lowpass", 100, 0.7, 0.22);    // rumble

      var beat = 0;
      schedule(bed, function (t) {
        var strong = beat % 4 === 0;
        burst(bed.dest, t, {
          dur: 0.13, attack: 0.012, level: strong ? 0.1 : 0.045,
          type: "bandpass", freq: 1100, q: 0.7, pan: -0.15
        });
        if (strong) {
          tone(bed.dest, t, { freq: 62, freqEnd: 44, level: 0.09, attack: 0.006, decay: 0.16 });
        }
        beat++;
      }, function () { return 0.34; }, 0.5);

      schedule(bed, function (t) {                          // a far-off clank
        var f = rand(620, 900);
        tone(bed.dest, t, { freq: f, level: 0.016, attack: 0.002, decay: 0.28, pan: rand(-0.7, 0.7) });
        tone(bed.dest, t, { freq: f * 1.62, level: 0.01, attack: 0.002, decay: 0.16, pan: rand(-0.7, 0.7) });
      }, function () { return rand(5, 12); }, rand(3, 7));

      buzzSwarm(bed, 3, { freq: 166, spread: 0.1, type: "sawtooth", cutoff: 520, level: 0.016, swell: 0.5 }); //lev 0.032
    },

    // 5 — Modern: traffic wash, mains hum, a faint neon whine.
    5: function (bed) {
      var traffic = noiseBand(bed, "pink", "lowpass", 300, 0.7, 0.22);
      bLfo(bed, 0.07, 0.08, traffic.gain.gain);
      bLfo(bed, 0.13, 0.04, traffic.gain.gain);

      var hiss = noiseBand(bed, "pink", "bandpass", 950, 0.5, 0.075);       // tyre hiss
      bLfo(bed, 0.09, 0.04, hiss.gain.gain);

      drone(bed, "sine", 100, 0.032, 0, 0);
      drone(bed, "sine", 200, 0.016, 0, 0);
      drone(bed, "sine", 300, 0.007, 0, 0);

      var neon = bOsc(bed, "sawtooth", 100);
      chain(neon, bFilter(bed, "bandpass", 2400, 8), bGain(bed, 0.012), bed.dest);

      var air = noiseBand(bed, "white", "bandpass", 2000, 0.6, 0.008);      // ventilation
      bLfo(bed, 0.11, 0.004, air.gain.gain);

      buzzSwarm(bed, 3, { freq: 204, spread: 0.1, cutoff: 1000, level: 0.016, swell: 0.4, flutter: 4 }); //lev 0.032
    },

    // 6 — AI Age: clean synthetic hum. Stacked sine partials with slow beating,
    // a faint high shimmer, sparse data ticks, and buzz reduced to a pure tone.
    6: function (bed) {
      var partials = [
        { f: 110, a: 0.06, beat: 0.5 },
        { f: 220.4, a: 0.045, beat: 0.8 },
        { f: 329.6, a: 0.03, beat: 0.6 },
        { f: 440.9, a: 0.02, beat: 1.1 }
      ];
      partials.forEach(function (p) {
        var d = drone(bed, "sine", p.f, p.a, 0, 0);
        bLfo(bed, 0.04 + p.beat * 0.05, 6, d.osc.detune);
        bLfo(bed, 0.05 + p.beat * 0.03, p.a * 0.35, d.gain.gain);
      });

      var sh1 = drone(bed, "sine", 1760, 0.006, 0, 0);
      var sh2 = drone(bed, "sine", 2637, 0.004, 0, 0);
      bLfo(bed, 0.13, 0.004, sh1.gain.gain);
      bLfo(bed, 0.09, 0.003, sh2.gain.gain);

      noiseBand(bed, "pink", "lowpass", 180, 0.7, 0.04);

      schedule(bed, function (t) {
        tone(bed.dest, t, {
          freq: rand(2000, 3400), level: 0.014, attack: 0.001, decay: 0.012, pan: rand(-0.8, 0.8)
        });
      }, function () { return rand(0.6, 3); }, 1);

      buzzSwarm(bed, 2, { freq: 200, spread: 0.05, type: "sine", cutoff: 900, level: 0.025, swell: 0.3, wander: 5, flutter: 0 }); //lev 0.05
    }
  };

  /* ---- bed lifecycle ---------------------------------------------------------- */

  function createBed(era) {
    var b = { era: era, alive: true, disposed: false, nodes: [], timers: [], pending: 0, out: null, dest: null };
    b.out = ctx.createGain();
    b.out.gain.value = 0;
    b.out.connect(ambienceBus);
    b.dest = ctx.createGain();
    b.dest.gain.value = dbToGain(ERA_TRIM_DB[era - 1] || 0);
    b.dest.connect(b.out);
    b.nodes.push(b.out, b.dest);

    try {
      BEDS[era](b);
    } catch (err) {
      retireBed(b, 0.05);     // stop whatever had already started
      throw err;
    }
    return b;
  }

  // Fades a bed out and stops it. Cleanup is driven by the sources' own
  // "ended" events (audio-clock time), so a suspended context can't leave a
  // half-faded bed torn down early.
  function retireBed(b, seconds) {
    if (!b || !b.alive) return;
    b.alive = false;
    b.timers.forEach(function (id) { clearInterval(id); });
    b.timers = [];
    fade(b.out.gain, 0, seconds);
    var stopAt = ctx.currentTime + seconds + 0.1;
    b.nodes.forEach(function (n) {
      if (typeof n.stop === "function") {
        try { n.stop(stopAt); } catch (err) { /* never started */ }
      }
    });
    if (b.pending <= 0) disposeBed(b);
  }

  /* ---- SFX -------------------------------------------------------------------- */

  var SFX = {
    // A ledger stamp: a short wooden thud and a paper tick.
    decision_confirm: function (t) {
      tone(sfxBus, t, { freq: 210, freqEnd: 118, level: 0.26, attack: 0.002, decay: 0.16 });
      burst(sfxBus, t, { dur: 0.05, attack: 0.001, level: 0.16, type: "lowpass", freq: 900, q: 0.7 });
      burst(sfxBus, t, { dur: 0.025, attack: 0.001, level: 0.045, type: "bandpass", freq: 3200, q: 1.5 });
    },

    // A soft, low swell (a fifth and an octave) with a page-turn of air,
    // stepping up a whole tone per era so progress is felt, not announced.
    era_transition: function (t) {
      var era = currentEra || 2;
      var root = 146.83 * Math.pow(2, (era - 2) * 2 / 12);
      var s = t + 0.08;                                     // trails the confirm thud
      tone(sfxBus, s, { freq: root, level: 0.1, attack: 0.9, decay: 1.5, type: "sine" });
      tone(sfxBus, s, { freq: root * 1.5, level: 0.065, attack: 0.9, decay: 1.5, type: "sine" });
      tone(sfxBus, s, { freq: root * 2, level: 0.04, attack: 0.9, decay: 1.5, type: "triangle", lp: 900 });
      burst(sfxBus, s, {
        dur: 1.3, attack: 0.5, level: 0.05, type: "bandpass", freq: 500, freqEnd: 1800, q: 0.8
      });
    },

    // Two dry, soft ticks — a small mark on the record.
    milestone: function (t) {
      tone(sfxBus, t, { freq: 784, level: 0.13, attack: 0.003, decay: 0.15 });
      tone(sfxBus, t + 0.12, { freq: 587, level: 0.1, attack: 0.003, decay: 0.17 });
      burst(sfxBus, t, { dur: 0.02, attack: 0.001, level: 0.03, type: "bandpass", freq: 2800, q: 1.2 });
    },

    // The ambience goes out behind the card while one fly winds down. That
    // is the whole cue: no stinger, nothing that tells the player how to feel.
    ending: function (t) {
      if (bed) {
        retireBed(bed, ENDING_FADE_SECONDS);
        bed = null;
      }
      currentEra = null;
      tone(sfxBus, t + 0.2, {
        freq: 196, freqEnd: 92, glide: 4.6, type: "sawtooth", level: 0.11,
        attack: 0.5, decay: 4.6, lp: 900, wobbleRate: 0.4, wobbleCents: 20
      });
      tone(sfxBus, t + 0.4, { freq: 98, type: "sine", level: 0.09, attack: 2.2, decay: 3.6 });
    }
  };

  /* ---- public API (build plan §2.6) --------------------------------------------- */

  function init() {
    if (initialized) return;
    initialized = true;

    if (!getContextConstructor()) {
      markUnavailable("Web Audio is not available in this browser.");
      return;
    }
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    if (CREATE_CONTEXT_IN_INIT) ensureContext();
  }

  function setEraAmbience(eraNumber) {
    var era = Math.round(Number(eraNumber));
    if (!(era >= 1 && era <= LAST_ERA)) {
      warn("setEraAmbience ignored: era must be 1-" + LAST_ERA + ", got", eraNumber);
      return;
    }
    if (!ensureContext()) return;
    ensureRunning();

    if (bed && bed.alive && currentEra === era) return;        // already playing it

    var previous = bed;
    var next;
    try {
      next = createBed(era);
    } catch (err) {
      warn("could not build the era " + era + " ambience", err);
      return;                                                  // keep the old bed running
    }

    bed = next;
    currentEra = era;
    fade(next.out.gain, 1, previous ? CROSSFADE_SECONDS : FIRST_FADE_IN_SECONDS);
    retireBed(previous, CROSSFADE_SECONDS);
  }

  function playSFX(name) {
    var voice = Object.prototype.hasOwnProperty.call(SFX, name) ? SFX[name] : null;
    if (!voice) {
      warn("playSFX ignored: unknown cue", name);
      return;
    }
    if (!ensureContext()) return;
    ensureRunning();
    try {
      voice(ctx.currentTime + 0.02);
    } catch (err) {
      warn("could not play " + name, err);
    }
  }

  window.GameAudio = {
    init: init,
    setEraAmbience: setEraAmbience,
    playSFX: playSFX
  };
})();
