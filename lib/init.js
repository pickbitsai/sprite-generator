import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');

const BASIC_STARTER = {
  defaultStyle: 'Pixel art sprite, transparent background, 64x64, retro game style, no text',
  assets: [
    {
      id: 'health_potion',
      name: 'Health Potion',
      emoji: '🧪',
      category: 'item',
      description: 'A glowing red potion in a round glass flask with a cork stopper',
    },
    {
      id: 'iron_sword',
      name: 'Iron Sword',
      emoji: '🗡️',
      category: 'weapon',
      description: 'A simple iron longsword with a leather-wrapped grip',
    },
  ],
};

function listTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) return [];
  return fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(n => fs.existsSync(path.join(TEMPLATES_DIR, n, 'manifest.json')))
    .sort();
}

function templateSummary(name) {
  const readme = path.join(TEMPLATES_DIR, name, 'README.md');
  if (!fs.existsSync(readme)) return '';
  const first = fs.readFileSync(readme, 'utf-8').split('\n').find(l => l.startsWith('> ')) || '';
  return first.replace(/^>\s*/, '').trim();
}

export async function runInit(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--manifest') args.manifest = argv[++i];
    else if (a === '--force') args.force = true;
  }

  if (args.list) {
    const templates = listTemplates();
    if (templates.length === 0) {
      console.log('No templates available.');
      return;
    }
    console.log('Available templates:\n');
    for (const name of templates) {
      const summary = templateSummary(name);
      console.log(`  ${name.padEnd(18)} ${summary}`);
    }
    console.log('\nUsage: npx sprite-generator init --template <name>');
    return;
  }

  const outPath = path.resolve(args.manifest || './manifest.json');
  if (fs.existsSync(outPath) && !args.force) {
    console.error(`Manifest already exists at ${outPath}. Use --force to overwrite.`);
    process.exit(1);
  }

  if (args.template) {
    const src = path.join(TEMPLATES_DIR, args.template, 'manifest.json');
    if (!fs.existsSync(src)) {
      const available = listTemplates().join(', ') || '(none)';
      console.error(`Template "${args.template}" not found.\nAvailable: ${available}`);
      process.exit(1);
    }
    fs.copyFileSync(src, outPath);
    const assetCount = (JSON.parse(fs.readFileSync(src, 'utf-8')).assets || []).length;
    console.log(`Wrote ${outPath} — ${args.template} template (${assetCount} assets).`);

    const readme = path.join(TEMPLATES_DIR, args.template, 'README.md');
    if (fs.existsSync(readme)) {
      console.log(`\nNext steps — see templates/${args.template}/README.md for the full walkthrough.`);
    }
    return;
  }

  fs.writeFileSync(outPath, JSON.stringify(BASIC_STARTER, null, 2) + '\n');
  console.log(`Wrote ${outPath} — basic starter (2 assets).`);
  console.log('\nTo see genre templates: npx sprite-generator init --list');
}
