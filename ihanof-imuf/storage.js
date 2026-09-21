/* =========================================================================
   storage.js — PHASE 5 (real localStorage meta-progression)

   Owns the `Records` global (build plan §2.2 — not `Storage`, which would
   shadow the native interface). Public surface is exactly the two
   functions in build plan §2.6:

     Records.recordRun({ endingId, era, population, sustenance, cohesion,
                         exposure, durationSeconds })
     Records.getSummary() -> { runsCount, bestDurationSeconds,
                               endingsReached: [id, ...] }

   Storage layout (spec §10): one JSON object under a single key.

     {
       v: 1,
       runsCount: <all runs ever recorded>,
       bestDurationSeconds: <longest run ever>,
       endingsReached: [<ending ids, in the order first reached>],
       recentRuns: [<the last MAX_RECENT_RUNS run entries>]
     }

   The aggregates (runsCount / bestDurationSeconds / endingsReached) are
   kept separately from the run log on purpose: the log is capped so it
   can't grow forever, but capping it must never make the player "lose" an
   ending they already reached, so the summary never depends on it.

   Robustness (all failure modes degrade to "works for this session only",
   never to an exception):
   - localStorage missing, blocked, or throwing (privacy modes, some
     file:// setups, quota) -> falls back to an in-memory log.
   - Corrupt or hand-edited JSON -> sanitised field by field; anything
     unusable is dropped rather than trusted.
   - Every call re-reads storage instead of trusting a cached copy, so two
     open tabs can't overwrite each other's runs with stale state.

   Only plain localStorage is used — not window.storage, which exists only
   inside Claude's artifact runtime (spec §11).
   ========================================================================= */

(function () {
  "use strict";

  var STORAGE_KEY = "ihanof-imuf.records.v1";
  var LOG_VERSION = 1;
  var MAX_RECENT_RUNS = 50;

  var warnedAboutStorage = false;

  function warnOnce(message, err) {
    if (warnedAboutStorage) return;
    warnedAboutStorage = true;
    console.warn("[Records] " + message + " Records will last for this session only.", err || "");
  }

  function probeStorage() {
    try {
      // Merely touching window.localStorage can throw a SecurityError, so
      // the access itself has to be inside the try.
      var probeKey = "__ihanof_imuf_probe__";
      window.localStorage.setItem(probeKey, "1");
      window.localStorage.removeItem(probeKey);
      return true;
    } catch (err) {
      warnOnce("localStorage is unavailable.", err);
      return false;
    }
  }

  function emptyLog() {
    return {
      v: LOG_VERSION,
      runsCount: 0,
      bestDurationSeconds: 0,
      endingsReached: [],
      recentRuns: []
    };
  }

  // Last-known-good log. It is the source of truth only while localStorage
  // is unavailable; otherwise it is overwritten by a fresh read every call.
  var memoryLog = emptyLog();
  var storageUsable = probeStorage();

  /* ---- helpers ------------------------------------------------------------ */

  function nonNegInt(value) {
    var n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.round(n);
  }

  /* ---- sanitising what comes out of storage --------------------------------- */

  function sanitizeRun(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.endingId !== "string" || !raw.endingId) return null;
    return {
      endingId: raw.endingId,
      era: nonNegInt(raw.era),
      population: nonNegInt(raw.population),
      sustenance: nonNegInt(raw.sustenance),
      cohesion: nonNegInt(raw.cohesion),
      exposure: nonNegInt(raw.exposure),
      durationSeconds: nonNegInt(raw.durationSeconds),
      at: nonNegInt(raw.at)
    };
  }

  function sanitizeLog(raw) {
    var log = emptyLog();
    if (!raw || typeof raw !== "object") return log;

    log.runsCount = nonNegInt(raw.runsCount);
    log.bestDurationSeconds = nonNegInt(raw.bestDurationSeconds);

    if (Array.isArray(raw.endingsReached)) {
      raw.endingsReached.forEach(function (id) {
        if (typeof id === "string" && id && log.endingsReached.indexOf(id) === -1) {
          log.endingsReached.push(id);
        }
      });
    }

    if (Array.isArray(raw.recentRuns)) {
      raw.recentRuns.forEach(function (entry) {
        var run = sanitizeRun(entry);
        if (run) log.recentRuns.push(run);
      });
      if (log.recentRuns.length > MAX_RECENT_RUNS) {
        log.recentRuns = log.recentRuns.slice(-MAX_RECENT_RUNS);
      }
    }

    // A log can't hold more runs than were ever counted.
    if (log.runsCount < log.recentRuns.length) log.runsCount = log.recentRuns.length;

    return log;
  }

  /* ---- load / save ------------------------------------------------------------ */

  function load() {
    if (!storageUsable) return memoryLog;

    var text;
    try {
      text = window.localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      storageUsable = false;
      warnOnce("Reading localStorage failed.", err);
      return memoryLog;
    }

    if (text === null || text === undefined) {
      memoryLog = emptyLog();
      return memoryLog;
    }

    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.warn("[Records] Stored records were unreadable and have been ignored.", err);
    }
    memoryLog = sanitizeLog(parsed);
    return memoryLog;
  }

  function save(log) {
    memoryLog = log;
    if (!storageUsable) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
    } catch (err) {
      // Most likely quota, or a privacy mode that allows reads but not
      // writes. memoryLog still holds the run for this session.
      storageUsable = false;
      warnOnce("Writing to localStorage failed.", err);
    }
  }

  /* ---- public API (build plan §2.6) ------------------------------------------- */

  function recordRun(runData) {
    if (!runData || typeof runData.endingId !== "string" || !runData.endingId) {
      console.warn("[Records] recordRun ignored: missing endingId.", runData);
      return;
    }

    var log = load();
    var entry = sanitizeRun(runData);
    entry.at = Date.now();

    log.runsCount += 1;
    if (entry.durationSeconds > log.bestDurationSeconds) {
      log.bestDurationSeconds = entry.durationSeconds;
    }
    if (log.endingsReached.indexOf(entry.endingId) === -1) {
      log.endingsReached.push(entry.endingId);
    }
    log.recentRuns.push(entry);
    if (log.recentRuns.length > MAX_RECENT_RUNS) {
      log.recentRuns = log.recentRuns.slice(-MAX_RECENT_RUNS);
    }

    save(log);
  }

  function getSummary() {
    var log = load();
    return {
      runsCount: log.runsCount,
      bestDurationSeconds: log.bestDurationSeconds,
      // Only endings actually reached — never a fixed six-slot list
      // (spec §10). A copy, so callers can't mutate stored state.
      endingsReached: log.endingsReached.slice()
    };
  }

  window.Records = {
    recordRun: recordRun,
    getSummary: getSummary
  };
})();
