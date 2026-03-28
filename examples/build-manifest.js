#!/usr/bin/env node
/**
 * Extracts all emoji assets from gamedata.js and builds manifest.json
 *
 * Usage: node build-manifest.js [--gamedata ../../cult-empire/gamedata.js]
 */

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    gamedata: { type: 'string', default: '../../cult-empire/gamedata.js' },
    output:   { type: 'string', default: './manifest.json' },
  },
  strict: false,
});

const src = fs.readFileSync(path.resolve(args.gamedata), 'utf-8');

const assets = [];
const seen = new Set();

function add(id, name, emoji, category, description) {
  const key = id + '_' + category;
  if (seen.has(key)) return;
  seen.add(key);
  assets.push({ id, name, emoji, category, description: description || '' });
}

// Find the line number where each top-level var starts
const lines = src.split('\n');
const sections = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^var\s+([A-Z_]+)\s*=/);
  if (m) sections.push({ name: m[1], start: i });
}

// Map var names to categories
const varToCategory = {
  LOCATIONS: 'location',
  BUILDINGS: 'building',
  CREATURES: 'creature',
  SPAWNERS: 'spawner',
  MANAGERS: 'manager',
  RITUALS: 'ritual',
  MISSIONS: 'mission',
  UPGRADES: 'upgrade',
  ACHIEVEMENTS: 'achievement',
  CONVERSIONS: 'alchemy',
  DAILY_TASK_POOL: 'task',
  WEEKLY_TASK_POOL: 'task',
  SPECIAL_MISSIONS: 'mission',
  CHAMPIONS: 'champion',
  RELICS: 'relic',
  EVENTS: 'event',
  SKILLS: 'skill',
  DUNGEON_FLOORS: 'dungeon_enemy',
  GEAR: 'equipment',
  CHAPTERS: 'quest',
};

// Parse icon/name from each section
for (let si = 0; si < sections.length; si++) {
  const sec = sections[si];
  const category = varToCategory[sec.name];
  if (!category) continue;

  const endLine = si + 1 < sections.length ? sections[si + 1].start : lines.length;
  let ctx = { name: '', id: '', icon: '' };

  for (let i = sec.start; i < endLine; i++) {
    const line = lines[i];
    const nameMatch = line.match(/name:\s*['"]([^'"]+)['"]/);
    const iconMatch = line.match(/icon:\s*['"]([^'"]+)['"]/);
    const idMatch = line.match(/id:\s*['"]([^'"]+)['"]/);

    if (nameMatch) ctx.name = nameMatch[1];
    if (idMatch) ctx.id = idMatch[1];
    if (iconMatch) {
      ctx.icon = iconMatch[1];
      if (ctx.name && ctx.icon) {
        const id = ctx.id || ctx.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        add(id, ctx.name, ctx.icon, category, '');
        // Reset for next entry
        ctx = { name: '', id: '', icon: '' };
      }
    }
  }
}

// For DUNGEON_FLOORS, we need to also extract floor names as locations
// and handle boss vs enemy distinction
const dfIdx = sections.find(s => s.name === 'DUNGEON_FLOORS');
if (dfIdx) {
  const endLine = sections.find(s => s.start > dfIdx.start)?.start || lines.length;
  for (let i = dfIdx.start; i < endLine; i++) {
    const line = lines[i];
    const floorMatch = line.match(/floor:\s*(\d+),\s*name:\s*'([^']+)'/);
    if (floorMatch) {
      add('floor_' + floorMatch[1], floorMatch[2], '🏰', 'dungeon_floor', '');
    }
  }
}

// Resource icons (rendered inline in HTML/JS)
const manualAssets = [
  { id: 'res_faith', name: 'Faith', emoji: '🙏', category: 'resource' },
  { id: 'res_souls', name: 'Souls', emoji: '👻', category: 'resource' },
  { id: 'res_energy', name: 'Dark Energy', emoji: '⚡', category: 'resource' },
  { id: 'res_gold', name: 'Gold', emoji: '💰', category: 'resource' },
  { id: 'res_blood', name: 'Blood', emoji: '🩸', category: 'resource' },
  { id: 'res_trinkets', name: 'Trinkets', emoji: '🏅', category: 'resource' },
  { id: 'res_gems', name: 'Gems', emoji: '💎', category: 'resource' },
  { id: 'res_stars', name: 'Stars', emoji: '⭐', category: 'resource' },
  { id: 'mat_ember_dust', name: 'Ember Dust', emoji: '🔥', category: 'crafting_material' },
  { id: 'mat_shadow_wisp', name: 'Shadow Wisp', emoji: '🌫️', category: 'crafting_material' },
  { id: 'mat_spider_guts', name: 'Spider Guts', emoji: '🕷️', category: 'crafting_material' },
  { id: 'mat_slime_gel', name: 'Slime Gel', emoji: '🟢', category: 'crafting_material' },
  { id: 'tab_build', name: 'Build Tab', emoji: '🏗️', category: 'ui' },
  { id: 'tab_creatures', name: 'Creatures Tab', emoji: '🐉', category: 'ui' },
  { id: 'tab_rituals', name: 'Rituals Tab', emoji: '🔮', category: 'ui' },
  { id: 'tab_quests', name: 'Quests Tab', emoji: '📜', category: 'ui' },
  { id: 'tab_upgrades', name: 'Upgrades Tab', emoji: '⬆️', category: 'ui' },
  { id: 'tab_skills', name: 'Skills Tab', emoji: '🌟', category: 'ui' },
  { id: 'tab_alchemy', name: 'Alchemy Tab', emoji: '🧪', category: 'ui' },
  { id: 'tab_tasks', name: 'Tasks Tab', emoji: '📋', category: 'ui' },
  { id: 'tab_dungeon', name: 'Dungeon Tab', emoji: '⚔️', category: 'ui' },
  { id: 'tab_relics', name: 'Relics Tab', emoji: '🏆', category: 'ui' },
  { id: 'tab_stats', name: 'Stats Tab', emoji: '📊', category: 'ui' },
  { id: 'tab_settings', name: 'Settings Tab', emoji: '⚙️', category: 'ui' },
  { id: 'btn_sacrifice', name: 'Sacrifice', emoji: '💀', category: 'ui' },
  { id: 'btn_daily_reward', name: 'Daily Rewards', emoji: '🎁', category: 'ui' },
  { id: 'btn_audio', name: 'Audio Toggle', emoji: '🔊', category: 'ui' },
  { id: 'ui_followers', name: 'Followers', emoji: '👥', category: 'ui' },
];
for (const a of manualAssets) {
  add(a.id, a.name, a.emoji, a.category, '');
}

// Add descriptions based on category
const descTemplates = {
  building: (n) => `A dark fantasy building structure, ${n}, gothic architecture`,
  creature: (n) => `A dark fantasy creature, ${n}, menacing, supernatural`,
  spawner: (n) => `A magical spawning altar for ${n}, dark energy, glowing runes`,
  dungeon_enemy: (n) => `A dark fantasy dungeon monster, ${n}, threatening, battle-ready`,
  dungeon_floor: (n) => `A dark dungeon environment, ${n}, atmospheric`,
  resource: (n) => `A glowing magical resource icon, ${n}`,
  crafting_material: (n) => `A crafting ingredient, ${n}, mystical`,
  relic: (n) => `A powerful magical artifact, ${n}, ancient, glowing`,
  equipment: (n) => `A dark fantasy weapon or armor piece, ${n}`,
  skill: (n) => `A magical ability icon, ${n}, mystical energy`,
  manager: (n) => `A dark cult character, ${n}, hooded, mystical`,
  ui: (n) => `A clean UI icon for ${n}`,
  location: (n) => `A dark fantasy location, ${n}, atmospheric`,
  champion: (n) => `A holy warrior opponent, ${n}, armored, radiant`,
  ritual: (n) => `A magical ritual icon, ${n}, glowing runes`,
  alchemy: (n) => `An alchemical conversion icon, ${n}`,
  event: (n) => `A special event icon, ${n}`,
  achievement: (n) => `An achievement badge, ${n}`,
  upgrade: (n) => `An upgrade icon, ${n}, power enhancement`,
  mission: (n) => `A mission/quest icon, ${n}`,
  quest: (n) => `A quest chapter icon, ${n}`,
  task: (n) => `A task icon, ${n}`,
};

for (const a of assets) {
  if (!a.description) {
    const fn = descTemplates[a.category];
    a.description = fn ? fn(a.name) : `${a.name}, dark fantasy style`;
  }
}

// Sort by category then name
assets.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

const manifest = {
  defaultStyle: 'Dark fantasy illustrated sprite, transparent background, 256x256, detailed, gothic, moody lighting, game asset, no text, centered composition',
  assets,
};

// Summary
const categories = {};
for (const a of assets) {
  categories[a.category] = (categories[a.category] || 0) + 1;
}

fs.writeFileSync(path.resolve(args.output), JSON.stringify(manifest, null, 2));
console.log(`Manifest written to ${args.output}`);
console.log(`Total assets: ${assets.length}`);
console.log('By category:');
for (const [cat, count] of Object.entries(categories).sort()) {
  console.log(`  ${cat}: ${count}`);
}
