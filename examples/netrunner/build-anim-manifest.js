#!/usr/bin/env node
/**
 * Builds animation manifests for all 4 Netrunner Legacy character classes.
 *
 * Generates per-class JSON manifests compatible with generate.js, producing
 * directional animation frames in the Diablo 1 / Gauntlet top-down style.
 *
 * Usage: node build-anim-manifest.js
 *
 * Outputs:
 *   netrunner-anim-manifest.json
 *   street_samurai-anim-manifest.json
 *   infiltrator-anim-manifest.json
 *   rigger-anim-manifest.json
 *   all-classes-anim-manifest.json  (combined)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Character class definitions
// ---------------------------------------------------------------------------
const CLASSES = {
  netrunner: {
    folder: 'netrunner-full',
    color: 'cyan',
    colorDesc: 'glowing cyan',
    appearance: 'lean build, dark hooded jacket with glowing cyan circuit line accents, cyan visor over eyes, dark pants and tech-enhanced boots',
    appearanceBack: 'lean build, dark hooded jacket with glowing cyan circuit line accents, hood up, dark pants and tech-enhanced boots',
    weapon: 'energy pistol',
    weaponAction: 'firing energy weapon, bright cyan muzzle flash',
    dashTrail: 'cyan digital glitch trail',
    deathDetail: 'cyan circuit accents flickering and going dark, visor dimming',
    special: 'hacker',
  },
  street_samurai: {
    folder: 'street_samurai-full',
    color: 'red',
    colorDesc: 'glowing red',
    appearance: 'heavy muscular build, dark armored vest with glowing red cybernetic implant lines, metal jaw plate, cybernetic arm with red accents, combat pants and heavy boots',
    appearanceBack: 'heavy muscular build, dark armored vest with glowing red cybernetic implant lines, broad shoulders, cybernetic arm visible, combat pants and heavy boots',
    weapon: 'large plasma blade',
    weaponAction: 'swinging glowing red plasma blade in a wide arc',
    dashTrail: 'red energy afterimage trail',
    deathDetail: 'red cybernetic implants sputtering and powering down',
    special: 'melee fighter',
  },
  infiltrator: {
    folder: 'infiltrator-full',
    color: 'purple',
    colorDesc: 'glowing purple',
    appearance: 'slim agile build, sleek dark bodysuit with glowing purple stealth-tech lines, half-face mask with purple lens, twin holstered daggers, lightweight boots',
    appearanceBack: 'slim agile build, sleek dark bodysuit with glowing purple stealth-tech lines, back visible, twin daggers sheathed on lower back, lightweight boots',
    weapon: 'twin energy daggers',
    weaponAction: 'slashing with glowing purple twin energy daggers in a quick strike',
    dashTrail: 'purple phase-shift ghosting trail',
    deathDetail: 'purple stealth lines fading out, body becoming partially transparent',
    special: 'assassin',
  },
  rigger: {
    folder: 'rigger-full',
    color: 'green',
    colorDesc: 'glowing green',
    appearance: 'stocky build, heavy utility coat with glowing green tech panels and tool pouches, bulky goggles with green HUD lens, mechanical gauntlets, cargo pants and armored boots, small drone hovering near shoulder',
    appearanceBack: 'stocky build, heavy utility coat with glowing green tech panels, backpack with antenna and drone dock, mechanical gauntlets, cargo pants and armored boots',
    weapon: 'wrist-mounted pulse cannon',
    weaponAction: 'firing wrist-mounted pulse cannon, green energy blast',
    dashTrail: 'green thruster exhaust trail',
    deathDetail: 'green tech panels going dark, shoulder drone falling to the ground',
    special: 'drone commander',
  },
};

// ---------------------------------------------------------------------------
// Animation state definitions
// ---------------------------------------------------------------------------
// Directions: down (toward camera), up (away), left (side profile)
// Right is handled by flipping left in-engine
const DIRECTIONS = {
  down: {
    facing: 'facing toward the camera (south/down direction)',
    facingBack: null, // not used for down
  },
  up: {
    facing: 'facing away from the camera (north/up direction), back visible',
    facingBack: true,
  },
  left: {
    facing: 'facing left (west direction), side profile visible',
    facingBack: null,
  },
};

const ANIM_STATES = {
  idle: {
    frames: 3,
    directions: ['down', 'up', 'left'],
    emoji: '🧍',
    frameDescs: [
      'standing idle, arms relaxed at sides',
      'standing idle, slight breathing shift, subtle weight change',
      'standing idle, slight weight shift to other foot',
    ],
  },
  walk: {
    frames: 4,
    directions: ['down', 'up', 'left'],
    emoji: '🚶',
    frameDescs: [
      'walking, left foot forward mid-stride, arms swinging naturally',
      'walking, feet passing each other mid-stride, upright posture',
      'walking, right foot forward mid-stride, arms swinging naturally',
      'walking, feet together in contact position between steps',
    ],
  },
  attack: {
    frames: 3,
    directions: ['down', 'up', 'left'],
    emoji: '⚡',
    frameDescs: (cls) => [
      `raising ${cls.weapon} to attack, winding up`,
      `${cls.weaponAction}, mid-strike`,
      `follow-through after attack, recovering to ready stance`,
    ],
  },
  dash: {
    frames: 2,
    directions: ['down', 'up', 'left'],
    emoji: '💨',
    frameDescs: (cls) => [
      `body leaning forward aggressively into a burst of speed, ${cls.dashTrail} beginning`,
      `mid-dash lunging forward at high speed, ${cls.dashTrail} behind`,
    ],
  },
  hurt: {
    frames: 2,
    directions: ['down', 'up', 'left'],
    emoji: '💥',
    frameDescs: [
      'flinching from damage, body recoiling from impact, pain reaction',
      'staggering from hit, arms out for balance, recovering from blow',
    ],
  },
  death: {
    frames: 4,
    directions: [null], // non-directional
    emoji: '💀',
    frameDescs: (cls) => [
      'collapsing, knees buckling, beginning to fall',
      'falling sideways, halfway to the ground, arms going limp',
      `nearly on the ground, crumpled, ${cls.deathDetail}`,
      `lying on the ground motionless, sprawled out, all lights dark and off`,
    ],
  },
};

// ---------------------------------------------------------------------------
// Build assets
// ---------------------------------------------------------------------------
const DEFAULT_STYLE = '2D illustrated game character sprite, top-down 3/4 view (like Diablo 1 or Gauntlet), solid filled opaque artwork, dark cyberpunk aesthetic, neon accents on dark colors, transparent background, centered composition, clean edges, no text, NOT pixel art, fully rendered and detailed, consistent character proportions, single character only, game animation frame';

function buildAssets(classId, cls) {
  const assets = [];

  for (const [stateName, state] of Object.entries(ANIM_STATES)) {
    const frameDescFn = typeof state.frameDescs === 'function' ? state.frameDescs(cls) : state.frameDescs;

    for (const dir of state.directions) {
      for (let f = 0; f < state.frames; f++) {
        const frameNum = String(f + 1).padStart(2, '0');
        const dirSuffix = dir ? `_${dir}` : '';
        const id = `${classId}_${stateName}${dirSuffix}_${frameNum}`;
        const dirInfo = dir ? DIRECTIONS[dir] : null;

        // Pick appearance based on whether this is a back-facing view
        const appearance = (dirInfo && dirInfo.facingBack) ? cls.appearanceBack : cls.appearance;
        const facingText = dirInfo ? dirInfo.facing : 'viewed from above';

        const totalFrames = state.frames;
        const frameLabel = `Frame ${f + 1} of ${totalFrames}`;

        const description = [
          `A cyberpunk ${cls.special} character,`,
          `${appearance}.`,
          `${frameDescFn[f]},`,
          `${facingText}.`,
          `Top-down 3/4 perspective.`,
          `${frameLabel} ${stateName} animation.`,
        ].join(' ');

        const tags = [classId, stateName, cls.color];
        if (dir) tags.push(dir);

        assets.push({
          id,
          name: `${classId} ${stateName} ${dir || ''} ${f + 1}`.replace(/\s+/g, ' ').trim(),
          emoji: state.emoji,
          category: `${cls.folder}/${stateName}`,
          description,
          tags,
        });
      }
    }
  }

  return assets;
}

// ---------------------------------------------------------------------------
// Generate manifests
// ---------------------------------------------------------------------------
const allAssets = [];

for (const [classId, cls] of Object.entries(CLASSES)) {
  const assets = buildAssets(classId, cls);
  allAssets.push(...assets);

  // Per-class manifest
  const manifest = {
    defaultStyle: DEFAULT_STYLE,
    assets,
  };

  const outPath = path.join(__dirname, `${classId}-anim-manifest.json`);
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  // Count breakdown
  const byState = {};
  for (const a of assets) {
    const state = a.category.split('/')[1];
    byState[state] = (byState[state] || 0) + 1;
  }

  console.log(`\n${classId} — ${assets.length} frames → ${outPath}`);
  for (const [state, count] of Object.entries(byState)) {
    console.log(`  ${state}: ${count}`);
  }
}

// Combined manifest
const combinedManifest = {
  defaultStyle: DEFAULT_STYLE,
  assets: allAssets,
};
const combinedPath = path.join(__dirname, 'all-classes-anim-manifest.json');
fs.writeFileSync(combinedPath, JSON.stringify(combinedManifest, null, 2));

console.log(`\n=== TOTAL: ${allAssets.length} frames across ${Object.keys(CLASSES).length} classes ===`);
console.log(`Combined manifest → ${combinedPath}`);

// Print generation command hints
console.log('\n--- Generation commands ---');
for (const classId of Object.keys(CLASSES)) {
  console.log(`node generate.js --manifest ${classId}-anim-manifest.json --output ./output --size 1024x1024 --skip-existing`);
}
console.log(`\nOr generate ALL at once:`);
console.log(`node generate.js --manifest all-classes-anim-manifest.json --output ./output --size 1024x1024 --skip-existing`);
