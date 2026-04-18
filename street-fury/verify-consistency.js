/**
 * Stage 5.6: Cross-frame identity consistency.
 *
 * For every generated pose, compare the pose's color distribution against
 * the character's reference.png. Uses a 16-bucket-per-channel RGB histogram
 * over opaque pixels (4096 bins total) and computes chi-squared distance.
 * Pose variation doesn't touch palette — a same-character punch-pose and
 * idle-pose share ~all colors. Different characters have materially
 * different histograms.
 *
 * Exit code: 0 if every pose is within the drift threshold, 2 otherwise.
 * `--fix` deletes frames that fail so a rerun of characters.js/enemies.js/
 * bosses.js regenerates them via image-edit against the reference.
 *
 * Usage:
 *   node tools/theme/verify-consistency.js <theme-id>
 *   node tools/theme/verify-consistency.js <theme-id> --fix
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');

// Chi-squared distance threshold. Calibrated against Gemini 2.5 Flash Image
// edit output (April 2026): same-character pose edits land at 0.5-0.8 with
// near-white pixels excluded; a genuinely different character exceeds 1.2.
// Dynamic poses (jump, knockdown) can reach 0.9. Portraits use loose = DRIFT_MAX * 2.0.
const DRIFT_MAX = 0.95;
const HIST_BINS = 16; // per channel → 4096 total

async function signature(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .resize(64, 64, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const hist = new Float32Array(HIST_BINS * HIST_BINS * HIST_BINS);
  let total = 0;
  const bucket = 256 / HIST_BINS;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    if (data[o + 3] < 100) continue;
    // Skip near-white pixels: references have white backgrounds that
    // clean-frames strips from poses. Without this, the reference histogram
    // has a huge white-bin spike the cleaned pose lacks → chi-squared explodes.
    if (data[o] > 240 && data[o + 1] > 240 && data[o + 2] > 240) continue;
    const r = Math.min(HIST_BINS - 1, Math.floor(data[o] / bucket));
    const g = Math.min(HIST_BINS - 1, Math.floor(data[o + 1] / bucket));
    const b = Math.min(HIST_BINS - 1, Math.floor(data[o + 2] / bucket));
    hist[r * HIST_BINS * HIST_BINS + g * HIST_BINS + b]++;
    total++;
  }
  if (total > 0) for (let i = 0; i < hist.length; i++) hist[i] /= total;
  return { hist, opaquePixels: total };
}

// Chi-squared distance on normalized histograms. 0 = identical, grows with difference.
function chiSq(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const s = a[i] + b[i];
    if (s <= 0) continue;
    const d = a[i] - b[i];
    sum += (d * d) / s;
  }
  return sum;
}

async function verifyAgainstRef(refPath, posePath) {
  if (!fs.existsSync(refPath)) return { skipped: true, reason: 'no reference' };
  if (!fs.existsSync(posePath)) return { ok: false, reason: 'pose missing' };
  const ref = await signature(refPath);
  const pose = await signature(posePath);
  if (ref.opaquePixels < 100 || pose.opaquePixels < 100) {
    return { ok: false, reason: `near-empty (ref=${ref.opaquePixels}, pose=${pose.opaquePixels})` };
  }
  const d = chiSq(ref.hist, pose.hist);
  return { ok: d <= DRIFT_MAX, distance: d };
}

function* iterEntityFrames(themeId, config) {
  for (const char of config.characters) {
    const root = path.join(themeDir(themeId), 'chars', char.id);
    const ref = path.join(root, 'reference.png');
    for (const sub of ['anim', 'walk']) {
      const dir = path.join(root, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.png')) continue;
        yield { label: `chars/${char.id}/${sub}/${f}`, ref, pose: path.join(dir, f) };
      }
    }
    // portrait has a different framing — close-up head & shoulders — so it
    // will naturally score higher. Include it but with a looser threshold.
    const portrait = path.join(root, 'portrait', 'portrait.png');
    if (fs.existsSync(portrait)) {
      yield { label: `chars/${char.id}/portrait`, ref, pose: portrait, loose: true };
    }
  }
  for (const [type, _] of Object.entries(config.enemies)) {
    const root = path.join(themeDir(themeId), 'enemies', type);
    const ref = path.join(root, 'reference.png');
    if (!fs.existsSync(root)) continue;
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith('.png') || f === 'reference.png') continue;
      yield { label: `enemies/${type}/${f}`, ref, pose: path.join(root, f) };
    }
  }
  for (const boss of config.bosses) {
    const root = path.join(themeDir(themeId), 'bosses', boss.id);
    const ref = path.join(root, 'reference.png');
    if (!fs.existsSync(root)) continue;
    for (const f of fs.readdirSync(root)) {
      if (!f.endsWith('.png') || f === 'reference.png') continue;
      yield { label: `bosses/${boss.id}/${f}`, ref, pose: path.join(root, f) };
    }
  }
}

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const fix = process.argv.includes('--fix');
  const config = loadThemeConfig(themeId);

  console.log(`[verify-consistency] theme=${themeId}  threshold=${DRIFT_MAX}${fix ? '  mode=--fix' : ''}`);

  let ok = 0, fail = 0, skipped = 0, deleted = 0;
  const failures = [];
  for (const entry of iterEntityFrames(themeId, config)) {
    const r = await verifyAgainstRef(entry.ref, entry.pose);
    if (r.skipped) { skipped++; continue; }
    // Portraits are head+shoulders crops of a full-body reference — framing
    // difference naturally inflates chi-squared. 2× is calibrated against
    // Gemini 2.5 Flash Image edit output (portraits land at 1.0-1.4).
    const threshold = entry.loose ? DRIFT_MAX * 2.0 : DRIFT_MAX;
    if (r.ok || (r.distance !== undefined && r.distance <= threshold)) { ok++; continue; }
    fail++;
    failures.push({ ...entry, ...r });
    if (fix && fs.existsSync(entry.pose)) { fs.unlinkSync(entry.pose); deleted++; }
  }

  console.log(`[verify-consistency] ok=${ok}  fail=${fail}  skipped-no-ref=${skipped}${fix ? `  deleted=${deleted}` : ''}`);
  if (failures.length) {
    for (const f of failures.slice(0, 30)) {
      const d = f.distance !== undefined ? `d=${f.distance.toFixed(3)}` : f.reason;
      console.log(`  ${f.label}: ${d}`);
    }
    if (failures.length > 30) console.log(`  ...and ${failures.length - 30} more`);
  }

  if (fail > 0) {
    if (!fix) console.log(`[verify-consistency] rerun with --fix to delete drifted frames so next generator pass regenerates them from the reference.`);
    process.exit(2);
  }
  console.log(`[verify-consistency] PASSED.`);
}

if (require.main === module) {
  main().catch(e => { console.error('[verify-consistency] FAILED:', e.message); process.exit(1); });
}

module.exports = { main, verifyAgainstRef, signature, chiSq, DRIFT_MAX };
