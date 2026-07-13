#!/usr/bin/env node
/**
 * One-off: generate the 4 Meadowlands biome concept-art references for the
 * UE5-Survival L_Meadows build (acceptance targets). Uses OpenAI gpt-image-1
 * at 1536x1024 (landscape). Writes PNGs to UE5-Survival/_planning/refs/.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const OUT = 'C:/new/UE5-Survival/_planning/refs';
fs.mkdirSync(OUT, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SHOTS = [
  {
    id: '1-hero-home-clearing',
    prompt: "Unreal Engine 5 cinematic game environment, dark-fantasy highland meadow at golden hour. Open grassy clearing ringed by slender birch trees, a small still pond reflecting warm light, mossy granite boulders, wildflowers in tall windswept grass. Low ground fog; distant ruined castle silhouette on a misty mountain. Volumetric god-rays, warm amber key light, cool shadows, painterly realism, wide establishing shot.",
  },
  {
    id: '2-standing-stones-ruin',
    prompt: "Unreal Engine 5 dark-fantasy meadow, a circle of weathered standing stones and crumbling stone ruins half-swallowed by tall grass and birch saplings. Overcast silver light breaking into warm shafts, drifting mist, moss on granite, scattered wildflowers, a faint dirt path. Moody painterly realism, eye-level cinematic shot.",
  },
  {
    id: '3-pond-stream-basin',
    prompt: "Unreal Engine 5 highland meadow stream basin, clear shallow water winding through reeds and water plants, smooth wet granite stones, grassy banks with ferns and birch trees, a fallen mossy log bridging the water. Soft golden backlight, gentle ground fog, reflections, stylized realism, low three-quarter cinematic angle.",
  },
  {
    id: '4-open-meadow-deer',
    prompt: "Unreal Engine 5 dark-fantasy meadow at dawn, a herd of deer grazing in rolling windswept grass dotted with wildflowers, scattered granite boulders and a distant birch treeline, mist in the hollows, a ruined watchtower on the horizon. Warm low sun, long shadows, painterly realism, wide cinematic landscape.",
  },
];

async function gen(shot) {
  process.stdout.write(`Generating ${shot.id}... `);
  const r = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: shot.prompt,
    n: 1,
    size: '1536x1024',
  });
  let b64 = r.data[0].b64_json;
  if (!b64 && r.data[0].url) {
    const res = await fetch(r.data[0].url);
    b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  }
  const out = path.join(OUT, `${shot.id}.png`);
  fs.writeFileSync(out, Buffer.from(b64, 'base64'));
  console.log(`OK -> ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

for (const shot of SHOTS) {
  try {
    await gen(shot);
  } catch (e) {
    console.error(`FAIL ${shot.id}: ${e.status || ''} ${e.message}`);
  }
}
console.log('done');
