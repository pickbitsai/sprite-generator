/**
 * Stage 1: Concept generation.
 * Takes a theme prompt like "simpsons" or "spider-man" and uses Gemini to derive
 * a structured theme config: 4 characters, 3 levels, 5 enemy types, 3 bosses.
 *
 * Usage:  node tools/theme/concept.js <theme-id> [free-form prompt...]
 * Output: src/themes/<theme-id>/config.json
 */
const fs = require('fs');
const { loadApiKey, callGeminiText, saveThemeConfig, themeDir, parseThemeIdFromArgs } = require('./lib');

const CONCEPT_PROMPT = (themeId, userPrompt) => `
You are designing a themed variant of a Streets of Rage / Final Fight style 2D beat-em-up.
The theme is: "${userPrompt || themeId}"

Produce a JSON object that maps this theme onto the game's existing structure.
Use recognizable characters, settings, and enemies from the theme where fitting.

CONSTRAINTS:
- 4 playable characters with fixed ROLES (replace Rex, Blitz, Jade, Hugo): Brawler, Speedster, Martial-Artist, Grappler
- 3 levels, each with a distinct environment suited to horizontal side-scrolling
- 5 enemy type slots with fixed ROLES (same gameplay, themed visuals):
    basic:    generic thug,          medium hp/speed/dmg
    rusher:   fast aggressive runner, low hp, high speed
    blocker:  shielded defender,     high hp, slow, can block
    thrower:  ranged attacker,       low hp, throws projectiles
    heavy:    big slow bruiser,      very high hp, high damage
- 3 bosses (one per level): escalating difficulty

OUTPUT STRICT JSON with this exact shape (no markdown, no commentary):
{
  "title": "THEME TITLE (short, 8-14 chars, uppercase ok)",
  "subtitle": "~ TAGLINE ~",
  "titleColor": "#RRGGBB (pick a theme-appropriate vibrant color)",
  "titleShadow": "#RRGGBB (darker complement)",
  "subtitleColor": "#RRGGBB",
  "palette": { "primary": "#RRGGBB", "secondary": "#RRGGBB", "accent": "#RRGGBB" },
  "characters": [
    {
      "id": "lowercase_slug",
      "name": "Display Name",
      "role": "Brawler|Speedster|Martial-Artist|Grappler",
      "color": "#RRGGBB",
      "outlineColor": "#RRGGBB (darker)",
      "visualDesc": "one sentence vivid visual description for Imagen, side-view, full body, thematic clothing",
      "portraitDesc": "one sentence for a close-up portrait card"
    }
    // exactly 4 characters, one per role in order: Brawler, Speedster, Martial-Artist, Grappler
  ],
  "enemies": {
    "basic":   { "name": "Themed Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "..." },
    "rusher":  { "name": "Themed Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "..." },
    "blocker": { "name": "Themed Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "..." },
    "thrower": { "name": "Themed Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "..." },
    "heavy":   { "name": "Themed Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "..." }
  },
  "bosses": [
    { "id": "boss1_slug", "name": "Boss Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "...", "stats": { "hp": 200, "speed": 1.5, "width": 30, "height": 44 } },
    { "id": "boss2_slug", "name": "Boss Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "...", "stats": { "hp": 250, "speed": 1.2, "width": 28, "height": 42 } },
    { "id": "boss3_slug", "name": "Boss Name", "color": "#RRGGBB", "outlineColor": "#RRGGBB", "visualDesc": "...", "stats": { "hp": 300, "speed": 1.8, "width": 32, "height": 46 } }
  ],
  "levels": [
    {
      "name": "LEVEL 1 NAME",
      "subtitle": "District Name",
      "environment": "what this environment looks like for background generation",
      "bgDesc": "far background layer (sky, distant skyline, atmosphere) — pixel art horizontal strip",
      "midDesc": "mid-ground layer (buildings, larger structures) — pixel art horizontal strip with transparent top",
      "groundDesc": "foreground ground layer (street, floor, detail) — pixel art horizontal strip"
    }
    // exactly 3 levels
  ]
}
`.trim();

async function main() {
  const themeId = parseThemeIdFromArgs(process.argv);
  const userPrompt = process.argv.slice(3).join(' ') || themeId;
  const apiKey = loadApiKey();

  console.log(`[concept] theme=${themeId} prompt="${userPrompt}"`);
  console.log('[concept] requesting concept from Gemini...');

  const raw = await callGeminiText(apiKey, CONCEPT_PROMPT(themeId, userPrompt), { json: true });

  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    config = JSON.parse(cleaned);
  }

  config.id = themeId;
  config.prompt = userPrompt;
  config.generatedAt = new Date().toISOString();

  validateConfig(config);
  const outPath = saveThemeConfig(themeId, config);
  console.log(`[concept] saved ${outPath}`);
  console.log(`[concept] title: "${config.title}"`);
  console.log(`[concept] chars: ${config.characters.map(c => c.name).join(', ')}`);
  console.log(`[concept] levels: ${config.levels.map(l => l.name).join(', ')}`);
  console.log(`[concept] bosses: ${config.bosses.map(b => b.name).join(', ')}`);
}

function validateConfig(c) {
  const need = ['title', 'characters', 'enemies', 'bosses', 'levels'];
  for (const k of need) if (!c[k]) throw new Error(`Missing field: ${k}`);
  if (c.characters.length !== 4) throw new Error(`Need 4 characters, got ${c.characters.length}`);
  if (c.bosses.length !== 3) throw new Error(`Need 3 bosses, got ${c.bosses.length}`);
  if (c.levels.length !== 3) throw new Error(`Need 3 levels, got ${c.levels.length}`);
  for (const k of ['basic','rusher','blocker','thrower','heavy']) {
    if (!c.enemies[k]) throw new Error(`Missing enemy type: ${k}`);
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[concept] FAILED:', e.message); process.exit(1); });
}

module.exports = { main };
