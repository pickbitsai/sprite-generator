#!/usr/bin/env node
/**
 * Theme generation orchestrator — runs the full pipeline end-to-end.
 *
 * Usage:
 *   node tools/generate-theme.js <theme-id> [free-form prompt...]
 *   node tools/generate-theme.js <theme-id> --stage concept
 *   node tools/generate-theme.js <theme-id> --stage backgrounds
 *   node tools/generate-theme.js <theme-id> --from assemble
 *
 * Stages (run in order by default):
 *   1. concept       — ask Gemini to design the theme, write config.json
 *   2. backgrounds   — 3 Imagen 4 calls (one scene per level, sliced into layers)
 *   3. characters    — walk + full anim frames + portraits for all 4 chars
 *   4. enemies       — 5 themed enemy sprite sets
 *   5. bosses        — 3 themed boss sprite sets
 *   6. clean-frames  — flood-fill plain white backgrounds to transparent so
 *                      regridSheet can separate animation rows.
 *   7. validate-frames — reject frames with opaque backgrounds, fragmented
 *                       content, or off-center subjects before assembly.
 *   8. assemble      — composite individual frames into sprite sheets
 *   9. build-config  — write src/themes/<id>/theme.js
 *  10. validate      — Playwright smoke-test the themed game
 */
const { spawnSync } = require('child_process');
const path = require('path');

// Stages are grouped into generation (may need retries) and verification
// (gates that must pass). If a verification stage fails, the orchestrator
// re-runs the upstream fix-it stages automatically before failing the user.
const STAGES = [
  { name: 'concept',            script: 'theme/concept.js',            passPrompt: true },
  { name: 'backgrounds',        script: 'theme/backgrounds.js'      },
  { name: 'verify-backgrounds', script: 'theme/verify-backgrounds.js' },
  { name: 'references',         script: 'theme/references.js'       },
  { name: 'characters',         script: 'theme/characters.js'       },
  { name: 'enemies',            script: 'theme/enemies.js'          },
  { name: 'bosses',             script: 'theme/bosses.js'           },
  { name: 'clean-frames',       script: 'theme/clean-frames.js'     },
  { name: 'validate-frames',    script: 'theme/validate-frames.js'  },
  { name: 'verify-consistency', script: 'theme/verify-consistency.js', recoverArgs: ['--fix'] },
  { name: 'verify-walk-cycle',  script: 'theme/verify-walk-cycle.js' },
  { name: 'assemble',           script: 'theme/assemble.js'         },
  { name: 'verify-sheet-layout',script: 'theme/verify-sheet-layout.js' },
  { name: 'build-config',       script: 'theme/build-config.js'     },
  { name: 'verify-gameplay',    script: 'theme/verify-gameplay.js'  },
  { name: 'verify-enemy-render',script: 'theme/verify-enemy-render.js' },
  { name: 'verify-boss-render',    script: 'theme/verify-boss-render.js'  },
  { name: 'verify-pickups-render', script: 'theme/verify-pickups-render.js' },
  { name: 'verify-character-select', script: 'theme/verify-character-select.js' },
  // Visual grid exports — required deliverable for every pipeline run. Not
  // gates (they don't throw), but the PNG outputs are part of "done".
  { name: 'capture-character-select', script: 'theme/capture-character-select.js' },
  { name: 'capture-walks',      script: 'theme/capture-walks.js'       },
  { name: 'capture-character-moves', script: 'theme/capture-character-moves.js' },
  { name: 'capture-enemies',    script: 'theme/capture-enemies.js'     },
  { name: 'capture-bosses',     script: 'theme/capture-bosses.js'      },
  { name: 'capture-pickups',    script: 'theme/capture-pickups.js'     },
  { name: 'capture-backgrounds',script: 'theme/capture-backgrounds.js' },
  { name: 'capture-review-sheet', script: 'theme/capture-review-sheet.js' },
  { name: 'validate',           script: 'validate-theme.js'            },
];

// Recovery-only stages — never run in the default pipeline, only invoked by
// name from VERIFY_RECOVERY when a gate fails.
const RECOVERY_ONLY_STAGES = [
  { name: 'fix-walk-cycles',    script: 'theme/fix-walk-cycles.js' },
];

// Which stages are verification gates (read-only checks that must pass). When
// one fails, the orchestrator retries the listed upstream stages once before
// giving up — lets us auto-recover from the common "frame regenerated dirty"
// case without user intervention.
//
// For `verify-consistency` the recovery is more involved: we run the gate
// with --fix (which deletes drifted frames), then re-run characters/enemies/
// bosses so the generators produce replacements via image-edit against the
// reference. That's the "drift → regenerate only the broken frames" loop.
const VERIFY_RECOVERY = {
  'validate-frames':    ['clean-frames'],
  'verify-consistency': ['verify-consistency:--fix', 'characters', 'enemies', 'bosses', 'clean-frames', 'validate-frames'],
  // For walk-cycle failures, img2img+ControlNet against the existing frames
  // is surgical: keeps identity, only repaints legs. That's what
  // fix-walk-cycles does. Fall back to full regeneration only if that still
  // fails.
  'verify-walk-cycle':  ['fix-walk-cycles', 'clean-frames', 'validate-frames'],
  'verify-sheet-layout':['assemble'],
  'verify-gameplay':    ['clean-frames', 'validate-frames', 'assemble', 'build-config'],
  // Enemy render failures almost always mean the engine's cell-size
  // constants (ENEMY_FRAME_W/H) don't match the themed sheet's 256×256.
  // Rebuilding theme.js re-emits window.THEME.enemyFrameW/H; rerunning
  // assemble re-packs the sheet on the clean grid.
  'verify-enemy-render':['assemble', 'build-config'],
  'verify-boss-render': ['assemble', 'build-config'],
  // Pickup-render failure almost always = theme dropped a shared sheet
  // key (e.g. 'items') from regridConfig, so rebuild the theme file.
  'verify-pickups-render':['build-config'],
  // Background-file failures recover by rerunning the backgrounds stage
  // (which regenerates scenes + re-slices). If a particular level still
  // fails after that, operator intervention is needed.
  'verify-character-select': ['assemble', 'build-config'],
  'verify-backgrounds': ['backgrounds'],
};

function parseArgs(argv) {
  const args = { stages: null, fromStage: null, themeId: null, prompt: [] };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--stage' || a === '--only') {
      args.stages = (rest[++i] || '').split(',');
    } else if (a === '--from') {
      args.fromStage = rest[++i];
    } else if (!a.startsWith('--')) {
      if (!args.themeId) args.themeId = a.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      else args.prompt.push(a);
    }
  }
  return args;
}

function runStage(stage, themeId, prompt, extraArgs) {
  const scriptPath = path.join(__dirname, stage.script);
  const args = [scriptPath, themeId];
  if (stage.passPrompt && prompt && prompt.length) args.push(...prompt);
  if (extraArgs && extraArgs.length) args.push(...extraArgs);
  console.log(`\n==== [stage:${stage.name}] node ${stage.script} ${args.slice(1).join(' ')}\n`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\n==== [stage:${stage.name}] FAILED with status ${r.status}`);
    return false;
  }
  return true;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.themeId) {
    console.error('Usage: node tools/generate-theme.js <theme-id> [prompt...]');
    process.exit(1);
  }

  let stages = STAGES;
  if (args.stages) {
    stages = STAGES.filter(s => args.stages.includes(s.name));
  } else if (args.fromStage) {
    const idx = STAGES.findIndex(s => s.name === args.fromStage);
    if (idx < 0) { console.error(`Unknown stage: ${args.fromStage}`); process.exit(1); }
    stages = STAGES.slice(idx);
  }

  console.log(`[orchestrator] theme=${args.themeId} stages=${stages.map(s=>s.name).join(',')}`);

  const findStage = (name) =>
    STAGES.find(s => s.name === name) ||
    RECOVERY_ONLY_STAGES.find(s => s.name === name);

  for (const s of stages) {
    let ok = runStage(s, args.themeId, args.prompt);

    // If a verification gate fails, try recovering by rerunning the known
    // fix-it stages once, then retry the gate. Keeps the workflow recursive
    // without infinite loops.
    if (!ok && VERIFY_RECOVERY[s.name]) {
      console.error(`[orchestrator] ${s.name} failed — attempting recovery via ${VERIFY_RECOVERY[s.name].join(', ')}`);
      let recovered = true;
      for (const recEntry of VERIFY_RECOVERY[s.name]) {
        // Allow "stage:--flag" shorthand in the recovery list: runs the
        // named stage with extra CLI args (used for verify-consistency:--fix).
        const [recName, ...recArgs] = recEntry.split(':');
        const rec = findStage(recName);
        if (!rec) { recovered = false; break; }
        if (!runStage(rec, args.themeId, args.prompt, recArgs)) { recovered = false; break; }
      }
      if (recovered) {
        console.error(`[orchestrator] retrying ${s.name} after recovery`);
        ok = runStage(s, args.themeId, args.prompt);
      }
    }

    if (!ok) {
      console.error(`\n[orchestrator] aborting — stage "${s.name}" failed after recovery attempt.`);
      console.error(`Retry from this stage with: node tools/generate-theme.js ${args.themeId} --from ${s.name}`);
      process.exit(2);
    }
  }

  console.log(`\n[orchestrator] ALL DONE — open:`);
  console.log(`  http://localhost:8080/index.html?theme=${args.themeId}   (after npm start)`);
}

main();
