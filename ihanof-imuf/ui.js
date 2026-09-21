/* =========================================================================
   ui.js — PHASE 5 (real DOM rendering and input wiring)

   Owns the `UI` global (build plan §2.2) and implements exactly the API in
   build plan §2.6. Dependency direction stays one-way: Game calls UI, and
   UI reaches back only through the callbacks handed to UI.init. The one
   thing this file reads from another module is Content.eras /
   Content.endings for display lookups (era names, the "X / 6" denominator)
   — read-only data, never a call into another module's behaviour.

   Conventions this file relies on (Phase 4 handover §3):
   - onOptionChosen(i) sends an index into the list that was PRESENTED, i.e.
     the already-filtered options array Game passed to showDecision. This
     file renders that array in order, so the DOM index is the right one.
   - The decision and HUD state objects are read-only here. Nothing is
     mutated and no reference is kept beyond a call.

   Twist protection (spec §4.1): no tooltips, no title attributes, no
   warning copy. The only "bold vs. safe" signal is the left-border colour
   from style.css, chosen by isBold() below — never stated in words.
   ========================================================================= */

(function () {
  "use strict";

  /* ---- tuning ----------------------------------------------------------------- */

  // How long a surviving-Sustenance-Crisis line stays up. Long enough to
  // read one dry sentence; it also clears early when the player resolves
  // a decision, or when the screen changes.
  var CRISIS_NOTICE_MS = 6000;

  // An option reads as "bold" (spec §8.1: bigger reward, bigger risk to
  // Exposure or Cohesion) if it carries a risk roll, or if it raises
  // Exposure by at least this much. Risk alone would miss Era 1 entirely,
  // where every option is guaranteed.
  var BOLD_EXPOSURE_THRESHOLD = 10;

  // How often the idle gauge redraws. Progress is computed from the clock,
  // not counted in steps, so a throttled background tab catches up
  // correctly when it returns.
  var GAUGE_STEP_MS = 100;

  /* ---- module state ----------------------------------------------------------- */

  var callbacks = {};
  var initialized = false;
  var crisisTimer = null;
  var focusBeforeRecords = null;
  var gaugeTimer = null;

  /* ---- small helpers ---------------------------------------------------------- */

  function $(id) {
    return document.getElementById(id);
  }

  function isHidden(el) {
    return el.classList.contains("hidden");
  }

  // Callbacks are looked up at call time, so a repeated UI.init(...) simply
  // swaps them rather than double-wiring anything.
  function fire(name, arg) {
    if (typeof callbacks[name] === "function") callbacks[name](arg);
  }

  function whole(value) {
    var n = Number(value);
    return isFinite(n) ? Math.round(n) : 0;
  }

  function eraName(eraId) {
    var eras = (typeof Content !== "undefined" && Content.eras) || [];
    for (var i = 0; i < eras.length; i++) {
      if (eras[i].id === eraId) return eras[i].name;
    }
    return null;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function formatDuration(totalSeconds) {
    var seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (seconds < 1) return "less than a second";
    var minutes = Math.floor(seconds / 60);
    var rest = seconds % 60;
    if (minutes === 0) return plural(rest, "second");
    if (rest === 0) return plural(minutes, "minute");
    return plural(minutes, "minute") + ", " + plural(rest, "second");
  }

  /* Modal screens (ending, records) sit on top of live screens. `inert`
     takes the screens underneath out of the tab order and away from
     assistive tech while a modal is open, without any focus-trap code.
     Derived from what is actually visible, so it can never get stuck. */
  function syncInert() {
    var recordsOpen = !isHidden($("records-panel"));
    var endingOpen = !isHidden($("ending-screen"));
    $("title-screen").inert = recordsOpen;
    $("game-screen").inert = recordsOpen || endingOpen;
  }

  /* ---- init ------------------------------------------------------------------ */

  function init(cb) {
    callbacks = cb || {};
    if (initialized) return;
    initialized = true;

    $("title-start-btn").addEventListener("click", function () {
      fire("onStartRun");
    });
    $("title-records-btn").addEventListener("click", function () {
      fire("onOpenRecords");
    });
    $("ending-restart-btn").addEventListener("click", function () {
      fire("onRestart");
    });
    $("records-close-btn").addEventListener("click", function () {
      fire("onCloseRecords");
    });

    // One delegated listener for every option button. Buttons are rebuilt
    // on each decision, so per-button listeners would need cleanup; this
    // never does.
    $("decision-options-list").addEventListener("click", function (event) {
      var target = event.target;
      var btn = target && target.closest ? target.closest(".decision-option-btn") : null;
      if (!btn || !this.contains(btn)) return;
      var index = Number(btn.dataset.optionIndex);
      if (isFinite(index)) fire("onOptionChosen", index);
    });

    // Records is a dialog: clicking the dimmed backdrop or pressing Escape
    // closes it, both by asking Game (which calls UI.hideRecords back).
    $("records-panel").addEventListener("click", function (event) {
      if (event.target === this) fire("onCloseRecords");
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !isHidden($("records-panel"))) {
        fire("onCloseRecords");
      }
    });

    // Attributes index.html doesn't carry (Phase 1 owns the markup; these
    // only add semantics, no new ids or classes).
    $("decision-panel").setAttribute("role", "group");
    $("decision-panel").setAttribute("aria-label", "Decision");
    var card = document.querySelector("#ending-screen .ending-card");
    if (card) {
      // Focusable by script only, so the epilogue is read out on arrival
      // without a stray Space/Enter being able to trigger "Begin again".
      card.setAttribute("tabindex", "-1");
      card.style.outline = "none";
    }
  }

  /* ---- HUD -------------------------------------------------------------------- */

  function renderHUD(state) {
    if (!state) return;
    $("hud-era-name").textContent = eraName(state.era) || "Era " + whole(state.era);
    $("hud-population").textContent = whole(state.population);
    $("hud-sustenance").textContent = whole(state.sustenance);
    $("hud-cohesion").textContent = whole(state.cohesion);
    $("hud-exposure").textContent = whole(state.exposure);
  }

  /* ---- decisions ------------------------------------------------------------- */

  function isBold(option) {
    if (option.risk) return true;
    var exposure = option.effects && option.effects.exposure;
    return typeof exposure === "number" && exposure >= BOLD_EXPOSURE_THRESHOLD;
  }

  function buildOptionButton(option, index) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "decision-option-btn decision-option-btn--" + (isBold(option) ? "bold" : "safe");
    btn.dataset.optionIndex = String(index);

    var label = document.createElement("span");
    label.className = "decision-option-label";
    label.textContent = option.label || "";
    btn.appendChild(label);

    if (option.hint) {
      var hint = document.createElement("span");
      hint.className = "decision-option-hint";
      hint.textContent = option.hint;
      btn.appendChild(hint);
    }
    return btn;
  }

  function showDecision(decision) {
    if (!decision) return;
    var panel = $("decision-panel");
    var list = $("decision-options-list");

    $("decision-flavor-text").textContent = decision.flavor || "";
    list.textContent = "";
    (decision.options || []).forEach(function (option, index) {
      list.appendChild(buildOptionButton(option, index));
    });

    panel.setAttribute("aria-label", decision.title || "Decision");
    panel.classList.remove("hidden");
    stopIdleGauge();   // the wait is over; it restarts after the choice
  }

  function hideDecision() {
    $("decision-panel").classList.add("hidden");
    // The player has moved on; a survived-crisis line shouldn't outlive
    // the decision it arrived with. (Game shows the notice AFTER this call
    // when a crisis resolves during a decision, so that case is unaffected.)
    clearCrisisNotice();
  }

  /* ---- crisis notice ---------------------------------------------------------- */

  function showCrisisNotice(flavorText) {
    if (!flavorText) return;
    var notice = $("crisis-notice");
    // Un-hide first, then set the text, so the aria-live region announces
    // the change rather than a node that appeared already filled.
    notice.classList.remove("hidden");
    notice.textContent = flavorText;

    if (crisisTimer) clearTimeout(crisisTimer);
    crisisTimer = setTimeout(clearCrisisNotice, CRISIS_NOTICE_MS);
  }

  function clearCrisisNotice() {
    if (crisisTimer) {
      clearTimeout(crisisTimer);
      crisisTimer = null;
    }
    var notice = $("crisis-notice");
    notice.classList.add("hidden");
    notice.textContent = "";
  }

  /* ---- idle gauge -------------------------------------------------------------- */

  // A slim bar that fills over the idle window before the next decision
  // (Game passes the exact window length), so the player can see the colony
  // is going somewhere rather than staring at a static screen. It carries
  // no numbers and no hint of what the next decision will be (spec §4.1).

  function setGaugeProgress(fraction) {
    var fill = $("idle-gauge-fill");
    if (!fill) return;
    var f = Math.min(1, Math.max(0, fraction));
    fill.style.transform = "scaleX(" + f.toFixed(4) + ")";
  }

  function stopIdleGauge() {
    if (gaugeTimer !== null) {
      clearInterval(gaugeTimer);
      gaugeTimer = null;
    }
    var gauge = $("idle-gauge");
    if (!gauge) return;
    gauge.classList.add("hidden");
    setGaugeProgress(0);
  }

  function startIdleGauge(durationMs) {
    var gauge = $("idle-gauge");
    stopIdleGauge();
    var total = Number(durationMs);
    if (!gauge || !isFinite(total) || total <= 0) return;

    var startedAt = Date.now();
    setGaugeProgress(0);
    gauge.classList.remove("hidden");

    gaugeTimer = setInterval(function () {
      var progress = (Date.now() - startedAt) / total;
      setGaugeProgress(progress);
      // Hold at full until Game opens the decision (or idles again), which
      // is what hides or restarts it.
      if (progress >= 1 && gaugeTimer !== null) {
        clearInterval(gaugeTimer);
        gaugeTimer = null;
      }
    }, GAUGE_STEP_MS);
  }

  /* ---- ending ----------------------------------------------------------------- */

  function showEnding(data) {
    data = data || {};
    var stats = data.stats || {};

    $("ending-epilogue-text").textContent = data.epilogue || "";

    var name = eraName(data.era);
    $("ending-stats").textContent =
      "Reached Era " + whole(data.era) + (name ? ", " + name : "") + ". " +
      "Final figures: Population " + whole(stats.population) +
      ", Sustenance " + whole(stats.sustenance) +
      ", Cohesion " + whole(stats.cohesion) +
      ", Exposure " + whole(stats.exposure) + ".";

    $("ending-session-length").textContent =
      "Your colony lasted " + formatDuration(data.durationSeconds) + ".";

    var replay = $("ending-replay-hook");
    if (data.replayHook) {
      replay.textContent = data.replayHook;
      replay.classList.remove("hidden");
    } else {
      // The Composite has no replay hook (spec §9.1) — the line is
      // removed entirely rather than left as an empty paragraph.
      replay.textContent = "";
      replay.classList.add("hidden");
    }

    clearCrisisNotice();
    stopIdleGauge();
    $("ending-screen").classList.remove("hidden");
    syncInert();

    var card = document.querySelector("#ending-screen .ending-card");
    if (card && card.focus) card.focus({ preventScroll: true });
  }

  /* ---- screens ---------------------------------------------------------------- */

  function showTitleScreen() {
    var cameFromEnding = !isHidden($("ending-screen"));

    $("title-screen").classList.remove("hidden");
    $("game-screen").classList.add("hidden");
    $("ending-screen").classList.add("hidden");
    $("records-panel").classList.add("hidden");
    focusBeforeRecords = null;
    $("decision-panel").classList.add("hidden");
    clearCrisisNotice();
    stopIdleGauge();
    syncInert();

    // Focus was on the (now hidden) restart button; hand it to the
    // natural next action. Not done at first page load, where a focus ring
    // on the Start button would look like a glitch.
    if (cameFromEnding) $("title-start-btn").focus({ preventScroll: true });
  }

  function showGameScreen() {
    $("game-screen").classList.remove("hidden");
    $("title-screen").classList.add("hidden");
    $("ending-screen").classList.add("hidden");
    $("records-panel").classList.add("hidden");
    $("decision-panel").classList.add("hidden");
    clearCrisisNotice();
    stopIdleGauge();
    syncInert();
  }

  /* ---- records ----------------------------------------------------------------- */

  function addRecordsLine(list, className, text) {
    var item = document.createElement("li");
    item.className = className;
    item.textContent = text;
    list.appendChild(item);
  }

  function showRecords(summary) {
    var list = $("records-list");
    list.textContent = "";

    // Only endings this build actually knows about, in the order they
    // were first reached. Nothing else is ever listed: no locked slots,
    // no silhouettes (spec §10).
    var known = (typeof Content !== "undefined" && Content.endings) || {};
    var reached = ((summary && summary.endingsReached) || []).filter(function (id) {
      return Object.prototype.hasOwnProperty.call(known, id);
    });

    if (reached.length === 0) {
      // Deliberately doesn't say "no endings yet" — that would tell a
      // first-time player that endings exist (spec §4.1, §10).
      addRecordsLine(list, "records-empty", "The record is empty.");
    } else {
      reached.forEach(function (id) {
        addRecordsLine(list, "records-ending", known[id].name || id);
      });

      // "X / 6" only appears once at least one ending exists (spec v0.5 §10).
      addRecordsLine(
        list,
        "records-count",
        reached.length + " of " + Object.keys(known).length + " endings recorded"
      );

      var runs = whole(summary.runsCount);
      var best = whole(summary.bestDurationSeconds);
      var detail = (runs === 1 ? "1 colony" : runs + " colonies") + " recorded";
      if (best > 0) detail += ". Longest lasted " + formatDuration(best);
      addRecordsLine(list, "records-count", detail + ".");
    }

    focusBeforeRecords = document.activeElement;
    $("records-panel").classList.remove("hidden");
    syncInert();
    $("records-close-btn").focus({ preventScroll: true });
  }

  function hideRecords() {
    $("records-panel").classList.add("hidden");
    syncInert();

    var back = focusBeforeRecords;
    focusBeforeRecords = null;
    if (back && back.focus && document.body.contains(back) && !back.closest(".hidden")) {
      back.focus({ preventScroll: true });
    }
  }

  /* ---- public surface (build plan §2.6) --------------------------------------- */

  window.UI = {
    init: init,
    renderHUD: renderHUD,
    showDecision: showDecision,
    hideDecision: hideDecision,
    showEnding: showEnding,
    showTitleScreen: showTitleScreen,
    showGameScreen: showGameScreen,
    showRecords: showRecords,
    hideRecords: hideRecords,
    showCrisisNotice: showCrisisNotice,
    startIdleGauge: startIdleGauge,
    stopIdleGauge: stopIdleGauge
  };
})();
