/* =========================================================================
   game.js — PHASE 4 (real core loop)

   The orchestrator. Owns GameState (build plan §2.3) and every rule that
   mutates it: the idle tick and its pause-on-decision behavior (spec §3),
   the passive-tick formula (spec §7), decision eligibility and recurrence
   (build plan §2.4), risk resolution (spec §8.3), era advancement, and the
   fail/ending checks including the Sustenance Crisis (spec §7.1) and
   Era 6's exemption from both (spec §8.4, build plan §2.6).

   Everything era-specific lives in content.js as data. This file is
   era-agnostic apart from one constant, FINAL_ERA_ID, for the Era 6
   exemption — the contract names Era 6 explicitly.

   Dependency direction is one-way: Game calls Scene / GameAudio / UI /
   Records / Content. UI calls back only through the callbacks passed to
   UI.init. Game.init() at the bottom is the app's only auto-run entry
   point (build plan §2.1).
   ========================================================================= */

(function () {
  "use strict";

  /* ---- tuning constants (spec §7 / §8.3 first-pass numbers) ------------- */

  var TICK_MIN_MS = 10000;               // idle window, spec §7: 10-25 s
  var TICK_MAX_MS = 25000;

  // Dev convenience for Phase 7 balance passes: open index.html?fasttick to
  // shrink the idle window to 1-2 s. Off unless the query string asks for it.
  var FAST_TICK = /[?&]fasttick(?:[=&]|$)/.test(
    (typeof location !== "undefined" && location.search) || ""
  );
  var FAST_TICK_MIN_MS = 1000;
  var FAST_TICK_MAX_MS = 2000;

  var SUSTENANCE_PER_TICK = 3;           // spec §7: applied first
  var GROWTH_THRESHOLD = 50;             // spec §7: +1 Population per 10
  var GROWTH_STEP = 10;                  //   Sustenance above 50, computed
                                         //   from the already-updated value
  var ERA_ADVANCE_EXPOSURE_BUMP = 2;     // spec §7: one-time, on advancing

  var RISK_MIN = 5;                      // spec §8.3 clamp
  var RISK_MAX = 95;

  var FINAL_ERA_ID = 6;                  // exempt from Population-0 and
                                         // Sustenance Crisis (spec §8.4)

  // OPEN DESIGN DECISION (Phase 3 handover §5) — the Composite epilogue
  // reads "Population: 0", but Era 6 is exempt from the Population-0 check,
  // so a run can reach the Composite with a large population.
  //   true  (option A): endRun("the_composite") reports Population 0 in the
  //                     stats and empties the street, so stats, epilogue and
  //                     scene agree.
  //   false (option B): leave the real population; accept the mismatch as
  //                     part of the Composite's intended ambiguity.
  var COMPOSITE_REPORTS_ZERO_POPULATION = true;
  var COMPOSITE_ENDING_ID = "the_composite";

  var STAT_KEYS = ["population", "sustenance", "cohesion", "exposure"];

  /* ---- module-local state ------------------------------------------------ */

  // Owned and mutated only here, per §2.3. Not a global, on purpose.
  var GameState = null;

  // Per-run bookkeeping that the frozen GameState shape has no room for.
  // Kept separate so the §2.3 contract is untouched.
  //   resolved:  decision ids already used up
  //   unlocked:  decision ids opened early by an option's unlocksDecisionId
  //   active:    the decision currently on screen, with the exact (filtered)
  //              options array that was presented — onOptionChosen(index)
  //              indexes into THAT array, not decision.options
  var run = null;

  var tickTimer = null;
  var lastScenePopulation = null;

  /* ---- small helpers ----------------------------------------------------- */

  function $id(id) {
    return document.getElementById(id);
  }

  function defaultState() {
    return {
      era: 1,
      population: 50,
      sustenance: 50,
      cohesion: 50,
      exposure: 0,
      flags: {},
      runStartTime: 0,
      activeDecisionId: null,
      ended: false
    };
  }

  function newRunTracker() {
    return { resolved: {}, unlocked: {}, active: null };
  }

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function getEra(id) {
    return (
      Content.eras.filter(function (e) {
        return e.id === id;
      })[0] || null
    );
  }

  function runIsLive() {
    return !!GameState && !GameState.ended;
  }

  /* ---- stat mutation ----------------------------------------------------- */

  // Effects values are a plain number (delta) or { set: N } (build plan
  // §2.4). Stats floor at 0 — a negative Population or Sustenance has no
  // meaning and would print as such in the HUD. There is no upper cap
  // (§2.3: nothing enforces a ceiling).
  function applyEffects(effects) {
    if (!effects) return;
    Object.keys(effects).forEach(function (key) {
      if (STAT_KEYS.indexOf(key) === -1) {
        console.warn("[Game] ignoring effect on unknown stat:", key);
        return;
      }
      var value = effects[key];
      if (value && typeof value === "object" && "set" in value) {
        GameState[key] = value.set;
      } else {
        GameState[key] = GameState[key] + value;
      }
    });
    floorStats();
  }

  function floorStats() {
    STAT_KEYS.forEach(function (key) {
      if (GameState[key] < 0) GameState[key] = 0;
    });
  }

  // Push the current state to the HUD and (when it changed) the scene.
  // Pass force = true to send Population even if unchanged (run start —
  // Scene resets its crowd to a default on the first setEra after freeze).
  function syncView(force) {
    UI.renderHUD(GameState);
    if (force || GameState.population !== lastScenePopulation) {
      lastScenePopulation = GameState.population;
      Scene.setPopulation(GameState.population);
    }
  }

  /* ---- risk (spec §8.3, also reused by the Sustenance Crisis) ------------ */

  // Returns true when the roll FAILS. chance is the failure probability:
  //   clamp(baseChance - (Cohesion - 50) * 0.5, 5, 95)
  function rollFailure(baseChance) {
    var chance = clamp(baseChance - (GameState.cohesion - 50) * 0.5, RISK_MIN, RISK_MAX);
    return Math.random() * 100 < chance;
  }

  /* ---- predicates and decision eligibility (build plan §2.4) ------------- */

  // { statName: { min: N } }, { statName: { max: N } } (both inclusive), and
  // { flagEquals: { flagName: bool } }. Keys within one predicate are AND'd.
  // null / undefined is trivially satisfied. An unrecognised key fails
  // closed rather than silently offering something the data meant to gate.
  function meetsPredicate(pred) {
    if (!pred) return true;
    var keys = Object.keys(pred);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === "flagEquals") {
        var wanted = pred.flagEquals || {};
        var names = Object.keys(wanted);
        for (var j = 0; j < names.length; j++) {
          if (!!GameState.flags[names[j]] !== !!wanted[names[j]]) return false;
        }
      } else if (STAT_KEYS.indexOf(key) !== -1) {
        var bounds = pred[key] || {};
        var value = GameState[key];
        if (bounds.min !== undefined && value < bounds.min) return false;
        if (bounds.max !== undefined && value > bounds.max) return false;
      } else {
        console.warn("[Game] unknown predicate key:", key);
        return false;
      }
    }
    return true;
  }

  // A decision is eligible when it has not been resolved and:
  //   - it was opened early by an option's unlocksDecisionId, or
  //   - it has neither requires nor availableIf, or
  //   - requires OR availableIf is met (§2.4: OR'd, not AND'd, when both
  //     are present).
  function decisionEligible(decision) {
    if (run.resolved[decision.id]) return false;
    if (run.unlocked[decision.id]) return true;
    if (!decision.requires && !decision.availableIf) return true;
    if (decision.requires && meetsPredicate(decision.requires)) return true;
    if (decision.availableIf && meetsPredicate(decision.availableIf)) return true;
    return false;
  }

  function decisionHasAdvancingOption(decision) {
    return decision.options.some(function (o) {
      return !!o.advancesEra;
    });
  }

  /* ---- ticking ----------------------------------------------------------- */

  function clearTick() {
    if (tickTimer !== null) {
      clearTimeout(tickTimer);
      tickTimer = null;
    }
  }

  function scheduleTick() {
    clearTick();
    var lo = FAST_TICK ? FAST_TICK_MIN_MS : TICK_MIN_MS;
    var hi = FAST_TICK ? FAST_TICK_MAX_MS : TICK_MAX_MS;
    var delay = lo + Math.random() * (hi - lo);
    tickTimer = setTimeout(tick, delay);
    // Tells the player the colony is idling toward its next decision: a
    // gauge that fills over exactly this window. UI stops it itself when a
    // decision opens or the run ends. Guarded so a UI without the gauge
    // (a test stand-in, say) simply does nothing.
    if (typeof UI.startIdleGauge === "function") UI.startIdleGauge(delay);
  }

  // Spec §7: Sustenance +3 FIRST, then Population +1 per 10 Sustenance above
  // 50, computed from the updated Sustenance value.
  function applyPassiveTick() {
    GameState.sustenance += SUSTENANCE_PER_TICK;
    var surplus = GameState.sustenance - GROWTH_THRESHOLD;
    if (surplus > 0) {
      GameState.population += Math.floor(surplus / GROWTH_STEP);
    }
    floorStats();
  }

  function tick() {
    tickTimer = null;
    if (!runIsLive()) return;

    applyPassiveTick();
    var endingId = failCheck();
    syncView();
    if (endingId) {
      endRun(endingId);
      return;
    }

    // Presenting a decision pauses the clock (spec §3): no timer is armed
    // until the player chooses. With nothing eligible, keep idling.
    if (!presentNextDecision()) scheduleTick();
  }

  /* ---- fail / ending check (build plan §2.6) ----------------------------- */

  // Returns an ending id if the run ends here, otherwise null. Skipped
  // entirely in Era 6. Systemic checks only — anything era-specific is
  // expressed as option-level risk.failEndingId / endsRun in content.js.
  function failCheck() {
    if (GameState.era === FINAL_ERA_ID) return null;

    var era = getEra(GameState.era);
    var failEnding = era ? era.failEndingId : null;
    if (!failEnding) {
      console.warn("[Game] era " + GameState.era + " has no failEndingId; fail check skipped");
      return null;
    }

    if (GameState.population <= 0) return failEnding;

    if (GameState.sustenance <= 0) {
      var crisis = Content.sustenanceCrisis;
      if (rollFailure(crisis.baseChance)) return failEnding;

      applyEffects(crisis.surviveEffects);
      // The survival cost can itself finish the colony.
      if (GameState.population <= 0) return failEnding;

      UI.showCrisisNotice(crisis.flavorSurvive);
      GameAudio.playSFX("milestone");
    }

    return null;
  }

  /* ---- presenting decisions ---------------------------------------------- */

  // Shows the first eligible decision in array order. Returns true if one was
  // shown. A decision whose options all filter away is marked resolved and
  // skipped rather than shown empty.
  function presentNextDecision() {
    var era = getEra(GameState.era);
    if (!era) return false;

    for (var i = 0; i < era.decisions.length; i++) {
      var decision = era.decisions[i];
      if (!decisionEligible(decision)) continue;

      var options = decision.options.filter(function (o) {
        return meetsPredicate(o.requires);
      });
      if (!options.length) {
        console.warn("[Game] decision " + decision.id + " has no available options; skipping");
        run.resolved[decision.id] = true;
        continue;
      }

      run.active = { decision: decision, options: options };
      GameState.activeDecisionId = decision.id;
      UI.showDecision({
        id: decision.id,
        title: decision.title,
        flavor: decision.flavor,
        options: options
      });
      return true;
    }
    return false;
  }

  /* ---- choosing an option ------------------------------------------------ */

  function advanceEra() {
    var nextId = GameState.era + 1;
    if (!getEra(nextId)) {
      console.warn("[Game] advancesEra on the final era; ignored");
      return;
    }
    GameState.era = nextId;
    GameState.exposure += ERA_ADVANCE_EXPOSURE_BUMP;
    Scene.setEra(nextId);
    GameAudio.setEraAmbience(nextId);
    GameAudio.playSFX("era_transition");
  }

  // Wired as UI's onOptionChosen. `optionIndex` indexes the FILTERED list
  // that was presented (run.active.options), not decision.options.
  function chooseOption(optionIndex) {
    if (!runIsLive() || !run.active) return;    // also swallows double-clicks

    var decision = run.active.decision;
    var option = run.active.options[optionIndex];
    if (!option) return;

    run.active = null;
    GameState.activeDecisionId = null;

    // Effects first, then the risk roll (its failEffects land immediately).
    applyEffects(option.effects);
    var riskFailed = false;
    if (option.risk) {
      riskFailed = rollFailure(option.risk.baseChance);
      if (riskFailed) applyEffects(option.risk.failEffects);
    }
    if (option.setsFlag) GameState.flags[option.setsFlag] = true;
    if (option.unlocksDecisionId) run.unlocked[option.unlocksDecisionId] = true;

    UI.hideDecision();
    GameAudio.playSFX("decision_confirm");

    // Ending priority (build plan §2.6): (1) the option's own endsRun,
    // (2) a failed roll's risk.failEndingId. A failed roll with a null
    // failEndingId just continues, with failEffects already applied.
    var endingId = option.endsRun || (riskFailed && option.risk.failEndingId) || null;
    if (endingId) {
      syncView();
      endRun(endingId);
      return;
    }

    // (3) era advance, else (4) recurrence: a non-advancing option in a
    // decision that also offers an advancing option leaves the decision
    // unresolved, so it is presented again next cycle (§2.4).
    if (option.advancesEra) {
      run.resolved[decision.id] = true;
      advanceEra();
    } else if (!decisionHasAdvancingOption(decision)) {
      run.resolved[decision.id] = true;
    }

    var failEnding = failCheck();
    syncView();
    if (failEnding) {
      endRun(failEnding);
      return;
    }
    scheduleTick();
  }

  /* ---- ending a run ------------------------------------------------------ */

  function endRun(endingId) {
    if (!GameState || GameState.ended) return;
    clearTick();
    GameState.ended = true;
    GameState.activeDecisionId = null;
    if (run) run.active = null;
    UI.hideDecision();

    if (endingId === COMPOSITE_ENDING_ID && COMPOSITE_REPORTS_ZERO_POPULATION) {
      GameState.population = 0;
    }
    // Empties the street behind the ending overlay when Population is 0
    // (spec §9.2); Scene accepts setPopulation after freeze either way.
    syncView();

    Scene.freeze();
    GameAudio.playSFX("ending");

    var durationSeconds = Math.round((Date.now() - GameState.runStartTime) / 1000);
    var ending = Content.endings[endingId];
    if (!ending) {
      console.warn("[Game] unknown ending id:", endingId);
      ending = { name: "Unknown", epilogue: "", replayHook: null };
    }

    var stats = {
      population: GameState.population,
      sustenance: GameState.sustenance,
      cohesion: GameState.cohesion,
      exposure: GameState.exposure
    };

    Records.recordRun({
      endingId: endingId,
      era: GameState.era,
      population: stats.population,
      sustenance: stats.sustenance,
      cohesion: stats.cohesion,
      exposure: stats.exposure,
      durationSeconds: durationSeconds
    });

    UI.showEnding({
      endingId: endingId,
      epilogue: ending.epilogue,
      replayHook: ending.replayHook,
      era: GameState.era,
      stats: stats,
      durationSeconds: durationSeconds
    });
  }

  /* ---- run lifecycle ----------------------------------------------------- */

  function startRun() {
    clearTick();
    GameState = defaultState();
    GameState.runStartTime = Date.now();
    run = newRunTracker();
    lastScenePopulation = null;

    UI.showGameScreen();
    Scene.setEra(1);                    // also un-freezes after a prior run
    syncView(true);                     // real Population, not Scene's default
    GameAudio.setEraAmbience(1);        // the Start click satisfies the autoplay gate

    scheduleTick();
  }

  function restart() {
    clearTick();
    GameState = null;
    run = null;
    UI.showTitleScreen();
  }

  function openRecords() {
    UI.showRecords(Records.getSummary());
  }

  function closeRecords() {
    UI.hideRecords();
  }

  function init() {
    Scene.init($id("scene-container"));
    GameAudio.init();
    UI.init({
      onStartRun: startRun,
      onOptionChosen: chooseOption,
      onRestart: restart,
      onOpenRecords: openRecords,
      onCloseRecords: closeRecords
    });
    UI.showTitleScreen();
  }

  window.Game = {
    init: init,
    startRun: startRun
  };

  // Only auto-run entry point in the whole app, per §2.1.
  init();
})();
