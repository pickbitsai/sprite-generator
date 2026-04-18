/**
 * Generates the 4 walk-phase OpenPose skeleton PNGs that the ControlNet
 * uses to force leg/arm positions. Standard 18-keypoint OpenPose renderer
 * format — same colors / geometry the ControlNet was trained on.
 *
 * Output:
 *   tools/theme/comfyui/poses/walk_1.png   (left leg at max forward swing)
 *   tools/theme/comfyui/poses/walk_2.png   (left planted, right swinging back)
 *   tools/theme/comfyui/poses/walk_3.png   (right leg at max forward swing)
 *   tools/theme/comfyui/poses/walk_4.png   (right planted, left swinging back)
 *
 * Side-view, character facing right, 1024×1024 canvas, black background.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CANVAS = 1024;
const OUT_DIR = path.join(__dirname, 'comfyui', 'poses');

// 18-keypoint COCO/OpenPose ordering used by ControlNet OpenPose SDXL.
const KP = {
  nose: 0, neck: 1,
  rsho: 2, relb: 3, rwri: 4,
  lsho: 5, lelb: 6, lwri: 7,
  rhip: 8, rkne: 9, rank: 10,
  lhip: 11, lkne: 12, lank: 13,
  reye: 14, leye: 15,
  rear: 16, lear: 17,
};

// Limb connections + the colors the OpenPose renderer uses for each.
// ControlNet was trained on these specific colors so they need to match.
const LIMBS = [
  [KP.neck, KP.rsho, '#FF5500'],
  [KP.rsho, KP.relb, '#FFAA00'],
  [KP.relb, KP.rwri, '#FFFF00'],
  [KP.neck, KP.lsho, '#AAFF00'],
  [KP.lsho, KP.lelb, '#55FF00'],
  [KP.lelb, KP.lwri, '#00FF00'],
  [KP.neck, KP.rhip, '#00FF55'],
  [KP.rhip, KP.rkne, '#00FFAA'],
  [KP.rkne, KP.rank, '#00FFFF'],
  [KP.neck, KP.lhip, '#00AAFF'],
  [KP.lhip, KP.lkne, '#0055FF'],
  [KP.lkne, KP.lank, '#0000FF'],
  [KP.neck, KP.nose, '#5500FF'],
  [KP.nose, KP.reye, '#AA00FF'],
  [KP.nose, KP.leye, '#FF00FF'],
  [KP.reye, KP.rear, '#FF00AA'],
  [KP.leye, KP.lear, '#FF0055'],
];

// Per-keypoint joint colors (dots). Follows the same OpenPose scheme.
const JOINT_COLORS = [
  '#FF0055', '#FF0000', '#FF5500', '#FFAA00', '#FFFF00',
  '#AAFF00', '#55FF00', '#00FF00', '#00FF55', '#00FFAA',
  '#00FFFF', '#00AAFF', '#0055FF', '#0000FF', '#5500FF',
  '#AA00FF', '#FF00FF', '#FF00AA',
];

// Shared upper-body + head. Character centered horizontally, facing right.
// Head/shoulders/torso don't change across walk phases.
function basePoints() {
  return {
    [KP.nose]: [552, 250],
    [KP.neck]: [500, 350],
    [KP.rsho]: [500, 360],
    [KP.lsho]: [520, 360],
    [KP.rhip]: [500, 580],
    [KP.lhip]: [520, 580],
    [KP.reye]: [560, 240],
    [KP.leye]: [548, 238],
    [KP.rear]: [542, 260],
    [KP.lear]: [530, 256],
  };
}

// Classic 2-phase walk cycle. In pure side-view we can't reliably distinguish
// anatomical left vs right legs (they overlap), so we use the two
// silhouettes that ACTUALLY differ: one leg LIFTED mid-swing (knee raised,
// foot off ground, wide stride) and the other leg PLANTED (weight on front
// foot, trailing foot pushing off low to the ground, narrower stride). Arms
// are also flipped between the two poses to amplify the silhouette
// difference so ControlNet can't collapse them onto the same output.
const PHASES = {
  walk_1: { // LIFT — front leg high with knee bent, supporting leg straight, arms wide-swung
    [KP.rkne]: [500, 720], [KP.rank]: [500, 885],            // supporting leg vertical
    [KP.lkne]: [620, 680], [KP.lank]: [700, 790],            // lifted leg knee high, foot forward-up
    [KP.relb]: [420, 440], [KP.rwri]: [370, 530],            // back arm swung WAY behind
    [KP.lelb]: [620, 430], [KP.lwri]: [690, 490],            // front arm swung WAY forward
  },
  walk_2: { // PLANT — front leg straighter & planted, trailing leg lifting off behind, arms closer to body
    [KP.rkne]: [470, 690], [KP.rank]: [410, 800],            // trailing leg lifting up behind (angled up-back)
    [KP.lkne]: [570, 730], [KP.lank]: [615, 885],            // front leg planted forward, slightly bent
    [KP.relb]: [540, 470], [KP.rwri]: [580, 560],            // front arm mid-swing down
    [KP.lelb]: [470, 450], [KP.lwri]: [430, 520],            // back arm mid-swing down
  },
};

function svgFor(phaseKey) {
  const pts = { ...basePoints(), ...PHASES[phaseKey] };
  const lines = LIMBS
    .filter(([a, b]) => pts[a] && pts[b])
    .map(([a, b, col]) => {
      const [x1, y1] = pts[a];
      const [x2, y2] = pts[b];
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="12" stroke-linecap="round"/>`;
    });
  const dots = Object.entries(pts).map(([k, [x, y]]) => {
    const col = JOINT_COLORS[Number(k)] || '#FFFFFF';
    return `<circle cx="${x}" cy="${y}" r="7" fill="${col}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" shape-rendering="geometricPrecision">
<rect width="${CANVAS}" height="${CANVAS}" fill="#000000"/>
${lines.join('\n')}
${dots.join('\n')}
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const phase of Object.keys(PHASES)) {
    const svg = svgFor(phase);
    const out = path.join(OUT_DIR, `${phase}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log(`  wrote ${path.relative(path.join(__dirname, '..', '..'), out)}`);
  }
  console.log('[gen-pose-skeletons] done.');
}

if (require.main === module) {
  main().catch(e => { console.error('[gen-pose-skeletons] FAILED:', e.message); process.exit(1); });
}

module.exports = { main };
