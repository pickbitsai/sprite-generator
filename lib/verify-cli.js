/**
 * `sprite-generator verify <frame1> <frame2> ...` CLI entry.
 *
 * Thin CLI wrapper around verify-identity.js's verifyFrameIdentity — checks
 * that a set of animation frames all depict the same character (NCC ≥ 0.70)
 * and haven't drifted spatially. Useful as a standalone gate on frames from
 * any source, not just this package's own pipelines.
 */
import { verifyFrameIdentity } from './verify-identity.js';

export async function runVerifyCli(argv) {
  const paths = argv.filter(a => !a.startsWith('--'));
  if (paths.length < 2) {
    console.error('Usage: sprite-generator verify <frame1.png> <frame2.png> [...more frames]');
    process.exit(1);
  }

  const result = await verifyFrameIdentity(paths);
  console.log(`Checked ${paths.length} frames — min NCC ${result.minNCC.toFixed(2)}`);
  if (result.pass) {
    console.log('✓ pass — no identity drift detected');
  } else {
    console.log('✗ fail:');
    for (const f of result.failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}
