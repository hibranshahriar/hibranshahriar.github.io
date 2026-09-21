/* =========================================================================
   content.js — PHASE 2 (real content)

   Full data for all 6 eras, per the schema frozen in the build plan §2.4.
   Era 1 transcribes spec §8.2 / build plan §2.4's worked example as-is.
   Eras 2–5 expand spec §8.4's sketch to the same level of detail. Era 6
   is the single-option Composite decision per spec §8.4.

   Nothing in this file calls or depends on any other module — it only
   defines window.Content, per the build plan's one-global-per-file rule
   (§2.2). No other phase's code should need to change for this file to
   be dropped in.
   ========================================================================= */

(function () {
  "use strict";

  var eras = [
    // ---------------------------------------------------------------------
    // ERA 1 — Stone Age  (spec §8.2 / build plan §2.4, transcribed as-is)
    // ---------------------------------------------------------------------
    {
      id: 1,
      name: "Stone Age",
      failEndingId: "harsh_winter",
      decisions: [
        {
          id: "1.1",
          title: "The First Winter",
          flavor:
            "Sustenance is thin. The colony debates whether to forage wider or huddle and wait it out.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Forage wider",
              hint: "More food, more visible",
              requires: null,
              effects: { sustenance: 15, exposure: 5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            },
            {
              label: "Huddle and conserve",
              hint: "Smaller gains, held close to home",
              requires: null,
              effects: { sustenance: 5, cohesion: 10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            },
            {
              label: "Send scouts toward the human settlement nearby",
              hint: "A bigger gamble, further from home",
              requires: null,
              effects: { sustenance: 20, exposure: 15 },
              setsFlag: "scoutedRiver",
              unlocksDecisionId: "1.3",
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        },
        {
          id: "1.2",
          title: "A Death in the Colony",
          flavor:
            "A cold snap kills several dozen. The colony must decide how to respond.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Mourn formally",
              hint: "A pause the colony can ill afford, but takes anyway",
              requires: null,
              effects: { cohesion: 15, sustenance: -5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            },
            {
              label: "Move on immediately",
              hint: "No time spent looking back",
              requires: null,
              effects: { sustenance: 5, cohesion: -10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        },
        {
          id: "1.3",
          title: "Toward the Bronze Age",
          flavor:
            "The colony has grown. Some among them look toward the humans' riverside settlement and its promise of surplus.",
          requires: { sustenance: { min: 40 } },
          availableIf: { flagEquals: { scoutedRiver: true } },
          options: [
            {
              label: "Advance toward the river settlement",
              hint: "Leave the huts behind for good",
              requires: { sustenance: { min: 40 } },
              effects: { exposure: 10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: true,
              endsRun: null,
              risk: null
            },
            {
              label: "Stay put, remain a Stone Age colony indefinitely",
              hint: "The colony remains as it is.",
              requires: null,
              effects: {},
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: "harsh_winter",
              risk: null
            },
            {
              label: "Fall back and consolidate",
              hint: "A pause, not a retreat",
              // Single-use (post-Phase 6 fix). Previously free and repeatable
              // forever, which let a run stall endlessly at Cohesion <= 40.
              // Once taken it sets "consolidated" and drops out of the list;
              // meetsPredicate reads the flag from GameState.flags.
              requires: { cohesion: { max: 40 }, flagEquals: { consolidated: false } },
              effects: { exposure: { set: 0 } },
              setsFlag: "consolidated",
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        }
      ]
    },

    // ---------------------------------------------------------------------
    // ERA 2 — Bronze Age
    // ---------------------------------------------------------------------
    {
      id: 2,
      name: "Bronze Age",
      failEndingId: "waterborne_sickness",
      decisions: [
        {
          id: "2.1",
          title: "Canals and the Dry Season",
          flavor:
            "The dry season presses on the colony's stores. Some push to dig irrigation canals through the humans' fields; others counsel patience.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Dig irrigation canals",
              hint: "A surge in food, hard to hide",
              requires: null,
              effects: { sustenance: 20, exposure: 10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: {
                baseChance: 25,
                failEffects: { population: -10, cohesion: -5 },
                failEndingId: "waterborne_sickness"
              }
            },
            {
              label: "Ration and endure",
              hint: "Slower, and nothing draws the eye",
              requires: null,
              effects: { sustenance: 8, cohesion: 5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        },
        {
          id: "2.2",
          title: "Contact with the River City",
          flavor:
            "The humans have built a city upriver — mudbrick walls, a ziggurat rising above them. The colony must decide whether to make contact.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Trade cautiously along the margins",
              hint: "Steady gains, closer to the humans than before",
              requires: null,
              effects: { sustenance: 15, exposure: 12 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: true,
              endsRun: null,
              risk: null
            },
            {
              label: "Avoid the humans entirely",
              hint: "Safer for now",
              requires: null,
              effects: { cohesion: 10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: {
                baseChance: 15,
                failEffects: { population: -5, sustenance: -5 },
                failEndingId: "waterborne_sickness"
              }
            }
          ]
        }
      ]
    },

    // ---------------------------------------------------------------------
    // ERA 3 — Medieval
    // ---------------------------------------------------------------------
    {
      id: 3,
      name: "Medieval",
      failEndingId: "plague_purge",
      decisions: [
        {
          id: "3.1",
          title: "The Bell Towers",
          flavor:
            "Cathedral bells ring across the walled town below. High in the towers, the colony finds shelter thick with dust and quiet.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Nest in the bell towers",
              hint: "Warmth and shelter, high above the square",
              requires: null,
              effects: { sustenance: 10, cohesion: 10, exposure: 5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            },
            {
              label: "Keep to the town's edges",
              hint: "Slower going, further from the bells",
              requires: null,
              effects: { sustenance: 5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        },
        {
          id: "3.2",
          title: "The Plague Question",
          flavor:
            "Sickness moves through the human quarter. The colony must decide whether to keep feeding on their waste or pull back and wait it out.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Quarantine the colony",
              hint: "Costly now, kept apart from it",
              requires: null,
              effects: { cohesion: -15, sustenance: -5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: true,
              endsRun: null,
              risk: null
            },
            {
              label: "Continue as before",
              hint: "Growth as usual, closer to the sickness",
              requires: null,
              effects: { sustenance: 15, exposure: 10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: {
                baseChance: 35,
                failEffects: { population: -15, cohesion: -10 },
                failEndingId: "plague_purge"
              }
            }
          ]
        }
      ]
    },

    // ---------------------------------------------------------------------
    // ERA 4 — Industrial
    // ---------------------------------------------------------------------
    {
      id: 4,
      name: "Industrial",
      failEndingId: "steam_engine",
      decisions: [
        {
          id: "4.1",
          title: "The Factory Floors",
          flavor:
            "Smokestacks rise over the tenement rows. Warm exhaust vents and grain-dust floors make the factories hard to ignore.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Colonize the factory floors",
              hint: "Rich pickings, right beside the machinery",
              requires: null,
              effects: { sustenance: 25, exposure: 15 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: {
                baseChance: 30,
                failEffects: { population: -15, sustenance: -10 },
                failEndingId: "steam_engine"
              }
            },
            {
              label: "Keep to the tenements",
              hint: "Modest and steady, away from the machines",
              requires: null,
              effects: { sustenance: 10, cohesion: 5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        },
        {
          id: "4.2",
          title: "The Steam Accord",
          flavor:
            "The colony debates whether to bind its fortunes to the humans' industrial expansion — the Steam Accord, they're calling it.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Commit to the Steam Accord",
              hint: "The colony's fortunes tied to the engines now",
              requires: null,
              effects: { sustenance: -10, exposure: 15 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: true,
              endsRun: null,
              risk: {
                baseChance: 25,
                failEffects: { population: -10, sustenance: -10 },
                failEndingId: "steam_engine"
              }
            },
            {
              label: "Hold off and consolidate first",
              hint: "A slower path, kept in reserve",
              requires: null,
              effects: { sustenance: 10, cohesion: 5 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        }
      ]
    },

    // ---------------------------------------------------------------------
    // ERA 5 — Modern
    // ---------------------------------------------------------------------
    {
      id: 5,
      name: "Modern",
      failEndingId: "great_spraying",
      decisions: [
        {
          id: "5.1",
          title: "Adapting to the Chemicals",
          flavor:
            "Pesticide use has become routine across the city. Some in the colony begin adjusting how and where they breed and feed.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Adapt to the pesticides",
              hint: "Slower and costly, but the city gets easier to live in",
              requires: null,
              effects: { cohesion: -15, exposure: -10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            },
            {
              label: "Carry on as before",
              hint: "Cheaper for now",
              requires: null,
              effects: { sustenance: 10 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            }
          ]
        },
        {
          id: "5.2",
          title: "The Extermination Sweeps",
          flavor:
            "Trucks move block to block, spraying as they go. The colony must decide how visible to stay.",
          requires: null,
          availableIf: null,
          options: [
            {
              label: "Go dormant during the sweeps",
              hint: "Quiet, until the trucks move on",
              requires: null,
              effects: { cohesion: -15 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: true,
              endsRun: null,
              risk: null
            },
            {
              label: "Keep growing at full rate",
              hint: "Growth doesn't wait for the trucks",
              requires: { exposure: { max: 79 } },
              effects: { sustenance: 15 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: null,
              risk: null
            },
            {
              label: "Keep growing at full rate",
              hint: "Growth doesn't wait for the trucks",
              requires: { exposure: { min: 80 } },
              effects: { sustenance: 15 },
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: "great_spraying",
              risk: null
            }
          ]
        }
      ]
    },

    // ---------------------------------------------------------------------
    // ERA 6 — AI Age
    // ---------------------------------------------------------------------
    {
      id: 6,
      name: "AI Age",
      // Deliberately unused — Era 6 is exempt from the Population-0 and
      // Sustenance Crisis checks once reached (build plan §2.6, spec
      // §7.1/§8.4). Only the Composite decision's own endsRun below can
      // end a run here.
      failEndingId: null,
      decisions: [
        {
          id: "6.1",
          title: "The Composite",
          flavor:
            "The colony's accumulated record — pattern, memory, motion — can be merged into the networked systems the humans built around them. The Council does not vote so much as arrive.",
          requires: null,
          availableIf: null,
          // Single confirm-style option, per spec §8.4's intentional
          // exception to §8.1's usual 2–4 option range.
          options: [
            {
              label: "Begin the merge",
              hint: "The record continues, differently.",
              requires: null,
              effects: {},
              setsFlag: null,
              unlocksDecisionId: null,
              advancesEra: false,
              endsRun: "the_composite",
              risk: null
            }
          ]
        }
      ]
    }
  ];

  // One shared replay-hook line, reused across every ending except The
  // Composite (spec §9.2 — "a single consistent line reused across all
  // five is the default").
  var REPLAY_HOOK = "Could it have lasted a little longer?";

  var endings = {
    harsh_winter: {
      name: "Harsh Winter",
      epilogue:
        "The stores ran out before the season turned. What remained of the colony did not survive to see the river settlement it had debated joining. The site was abandoned within the year — first by the flies, then by memory of them.",
      replayHook: REPLAY_HOOK
    },
    waterborne_sickness: {
      name: "The Waterborne Sickness",
      epilogue:
        "Sickness moved through the canals faster than the colony could retreat from them. Whatever the trade with the river city might have become, it ended here, in the runoff. The settlement's second age was also its last.",
      replayHook: REPLAY_HOOK
    },
    plague_purge: {
      name: "The Plague Purge",
      epilogue:
        "The sickness moving through the human quarter did not stay contained to humans for long. What began as disease ended as purge — the bells rang not for the colony, but against it. By the time they fell quiet, so had the walls.",
      replayHook: REPLAY_HOOK
    },
    steam_engine: {
      name: "The Steam Engine",
      epilogue:
        "The machines did not stop for the colony's arithmetic. Margins thought sufficient were not; what the factories gave, they eventually took back with interest. The engines kept running. The colony did not.",
      replayHook: REPLAY_HOOK
    },
    great_spraying: {
      name: "The Great Spraying",
      epilogue:
        "The trucks that moved block to block did not distinguish between one street and the next. What growth remained was not enough to outrun them. The spraying was, in the end, thorough.",
      replayHook: REPLAY_HOOK
    },
    the_composite: {
      name: "The Composite",
      epilogue:
        "Population: 0. Cause: none recorded. The Composite persists. Whether this constitutes survival is a matter the colony, in whatever sense it still exists, has not been asked.",
      // No replay hook, unlike every other ending — it isn't framed as
      // something to beat (spec §9.1).
      replayHook: null
    }
  };

  // Single, era-agnostic config for the Sustenance Crisis mechanic
  // (spec §7.1) — not authored per era, the same way the replay-hook
  // line above is shared rather than authored per ending.
  var sustenanceCrisis = {
    baseChance: 50,
    surviveEffects: { sustenance: 10, population: -5, cohesion: -5 },
    flavorSurvive:
      "The colony's stores ran empty and were refilled by measures the record declines to specify. Losses were sustained. The season continues."
  };

  window.Content = {
    eras: eras,
    endings: endings,
    sustenanceCrisis: sustenanceCrisis
  };
})();
