/**
 * `sprite-generator pack` CLI entry.
 *
 * Runs the game-pack pipeline (generate → crop → fit-to-target → assemble →
 * verify) defined in pack-pipeline.js against a per-game spec.
 *
 * Usage:
 *   sprite-generator pack --spec game-pack.json --output public/sprites/16bit
 *   sprite-generator pack --skip-generate          # reprocess existing raws
 *   sprite-generator pack --asset player           # only one asset
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';
import OpenAI from 'openai';
import { runPackPipeline } from './pack-pipeline.js';

export async function runPackCli(argv) {
  const { values: args } = parseArgs({
    args: argv,
    options: {
      spec:           { type: 'string', default: './game-pack.json' },
      output:         { type: 'string', default: './output' },
      raw:            { type: 'string' },
      'skip-generate':{ type: 'boolean', default: false },
      asset:          { type: 'string' },
      model:          { type: 'string', default: 'gpt-image-1' },
      size:           { type: 'string', default: '1024x1024' },
      concurrency:    { type: 'string', default: '3' },
      'edit-provider':{ type: 'string', default: 'openai' },
      'edit-model':   { type: 'string' },
    },
    strict: false,
  });

  const specPath = path.resolve(args.spec);
  if (!fs.existsSync(specPath)) {
    console.error(`Pack spec not found: ${specPath}`);
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  const outputDir = path.resolve(args.output);
  const rawDir = args.raw ? path.resolve(args.raw) : path.join(outputDir, 'raw');

  let openaiClient = null;
  if (!args['skip-generate']) {
    if (!process.env.OPENAI_API_KEY) {
      console.error('Missing OPENAI_API_KEY environment variable. Use --skip-generate to reprocess existing raws.');
      process.exit(1);
    }
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  console.log('\nSprite Generator — pack pipeline');
  console.log(`  Spec:    ${specPath}`);
  console.log(`  Output:  ${outputDir}`);
  console.log(`  Raws:    ${rawDir}`);
  console.log(`  Mode:    ${args['skip-generate'] ? 'reprocess existing raws' : 'generate + process'}`);
  if (args.asset) console.log(`  Asset:   ${args.asset} (filtered)`);
  console.log(`  Workers: ${args.concurrency}\n`);

  const start = Date.now();
  const { results } = await runPackPipeline({
    spec,
    outputDir,
    rawDir,
    skipGenerate: args['skip-generate'],
    openaiClient,
    model: args.model,
    size: args.size,
    concurrency: parseInt(args.concurrency, 10) || 3,
    assetFilter: args.asset || null,
    editProvider: args['edit-provider'],
    ...(args['edit-model'] ? { editModel: args['edit-model'] } : {}),
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const ok = results.filter(r => r.status === 'ok').length;
  const failed = results.length - ok;
  console.log(`\nDone in ${elapsed}s — ${ok} processed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}
