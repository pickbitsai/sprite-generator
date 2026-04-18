#!/usr/bin/env node
/**
 * Extracts all emoji assets from cat-snack-bar/data.js and builds cat-manifest.json
 *
 * Usage: node build-cat-manifest.js [--gamedata ../../cat-snack-bar/data.js]
 */

import fs from 'fs';
import path from 'path';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    gamedata: { type: 'string', default: '../../cat-snack-bar/data.js' },
    output:   { type: 'string', default: './cat-manifest.json' },
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

// Find the line number where each top-level const starts
const lines = src.split('\n');
const sections = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^const\s+([A-Z_]+)\s*=/);
  if (m) sections.push({ name: m[1], start: i });
}

// Map const names to categories
const varToCategory = {
  BRANCHES: 'branch',
  MENU_ITEMS: 'menu_item',
  WORKSTATIONS: 'workstation',
  COSTUME_PIECES: 'costume_piece',
  COSTUMES: 'costume',
  SUITCASES: 'suitcase',
  MERCHANDISE: 'merchandise',
  DECORATIONS: 'decoration',
  SPECIAL_CUSTOMERS: 'special_customer',
  CUSTOMER_TYPES: 'customer_type',
  ACHIEVEMENTS: 'achievement',
  DAILY_REWARDS: 'daily_reward',
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
      // Some entries (like CUSTOMER_TYPES) have id+icon but no name
      const name = ctx.name || (ctx.id ? ctx.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '');
      if (name && ctx.icon) {
        const id = ctx.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        add(id, name, ctx.icon, category, '');
        ctx = { name: '', id: '', icon: '' };
      }
    }
  }
}

// DAILY_REWARDS don't have ids/names, handle specially
const drIdx = sections.find(s => s.name === 'DAILY_REWARDS');
if (drIdx) {
  const endLine = sections.find(s => s.start > drIdx.start)?.start || lines.length;
  for (let i = drIdx.start; i < endLine; i++) {
    const line = lines[i];
    const dayMatch = line.match(/day:\s*(\d+)/);
    const iconMatch = line.match(/icon:\s*['"]([^'"]+)['"]/);
    if (dayMatch && iconMatch) {
      add('day-' + dayMatch[1], 'Day ' + dayMatch[1] + ' Reward', iconMatch[1], 'daily_reward', '');
    }
  }
}

// Manual UI assets
const manualAssets = [
  { id: 'res_money', name: 'Money', emoji: '💵', category: 'ui' },
  { id: 'res_gems', name: 'Gems', emoji: '💎', category: 'ui' },
  { id: 'res_tips', name: 'Tips', emoji: '💰', category: 'ui' },
  { id: 'tab_branches', name: 'Branches Tab', emoji: '🏪', category: 'ui' },
  { id: 'tab_workers', name: 'Workers Tab', emoji: '🐱', category: 'ui' },
  { id: 'tab_costumes', name: 'Costumes Tab', emoji: '👔', category: 'ui' },
  { id: 'tab_merchandise', name: 'Merchandise Tab', emoji: '🛍️', category: 'ui' },
  { id: 'tab_decorations', name: 'Decorations Tab', emoji: '🎨', category: 'ui' },
  { id: 'tab_achievements', name: 'Achievements Tab', emoji: '🏆', category: 'ui' },
  { id: 'tab_suitcases', name: 'Suitcases Tab', emoji: '🧳', category: 'ui' },
  { id: 'tab_settings', name: 'Settings Tab', emoji: '⚙️', category: 'ui' },
  { id: 'btn_hire', name: 'Hire Worker', emoji: '➕', category: 'ui' },
  { id: 'btn_upgrade', name: 'Upgrade', emoji: '⬆️', category: 'ui' },
  { id: 'btn_cook', name: 'Cook', emoji: '🍳', category: 'ui' },
  { id: 'ui_star', name: 'Star Rating', emoji: '⭐', category: 'ui' },
];
for (const a of manualAssets) {
  add(a.id, a.name, a.emoji, a.category, '');
}

// Add descriptions based on category
const descTemplates = {
  branch: (n) => `A cute cat cafe restaurant storefront, ${n}, cozy, inviting`,
  menu_item: (n) => `A delicious food item, ${n}, appetizing, plated beautifully`,
  workstation: (n) => `A kitchen appliance or workstation, ${n}, shiny, professional`,
  costume_piece: (n) => `A cute accessory for a cat, ${n}, adorable, detailed`,
  costume: (n) => `A cute outfit for a cat, ${n}, fashionable, charming`,
  suitcase: (n) => `A decorative suitcase or loot box, ${n}, mysterious, shiny`,
  merchandise: (n) => `A shop merchandise item, ${n}, cute, collectible`,
  decoration: (n) => `A restaurant decoration, ${n}, charming, detailed`,
  special_customer: (n) => `A special cat character, ${n}, expressive, unique personality`,
  customer_type: (n) => `An adorable cat customer, ${n}, cute, expressive`,
  achievement: (n) => `An achievement badge icon, ${n}, shiny, celebratory`,
  daily_reward: (n) => `A daily reward icon, ${n}, gift-like, sparkly`,
  ui: (n) => `A clean UI icon for ${n}`,
};

for (const a of assets) {
  if (!a.description) {
    const fn = descTemplates[a.category];
    a.description = fn ? fn(a.name) : `${a.name}, cute kawaii style`;
  }
}

// Sort by category then name
assets.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

const manifest = {
  defaultStyle: 'Cute kawaii illustrated sprite, transparent background, 256x256, adorable, colorful, warm lighting, cat cafe game asset, no text, centered composition',
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
