#!/usr/bin/env node
// release-guard v1.1.0
// Vendored from pickbitsai/release-guard. Copy this file alone into scripts/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.1.0';
const MAX_TEXT_SIZE = 5 * 1024 * 1024;
const USAGE = 'Usage: node release-guard.mjs scan [--git-archive <ref>] [--tracked [<ref>]] [--range <base>..<head>] [--dir <path>]... [--npm-pack] [--config <file>] [--denylist <file>] [--json] [--repo <path>]';
const SECRET_RULES = [
  ['SECRET_AWS', /AKIA[0-9A-Z]{16}/g],
  ['SECRET_STRIPE', /(?:sk|rk)_live_[0-9A-Za-z]{10,}/g],
  ['SECRET_ANTHROPIC', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['SECRET_OPENAI', /sk-[A-Za-z0-9]{32,}/g],
  ['SECRET_GITHUB', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  // Real Resend keys are random base62 (mixed case and digits); this skips identifiers like re_derive_state.
  ['SECRET_RESEND', /\bre_(?=[A-Za-z0-9_]*[0-9])(?=[A-Za-z0-9_]*[A-Z])(?=[A-Za-z0-9_]*[a-z])[A-Za-z0-9_]{20,}/g],
  ['SECRET_TELEGRAM', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['SECRET_SLACK', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['SECRET_PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];

export function relativePattern(value, field = 'path') {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) {
    throw new Error(`${field} must contain nonempty, single-line strings`);
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`${field} must be relative to the repository, without '..'`);
  }
  return normalized;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Config must be a JSON object');
  const config = { ...input };
  if (input.public !== undefined && typeof input.public !== 'boolean') throw new Error('Config public must be a boolean');
  for (const field of ['forbid', 'allow', 'allowTerms', 'buildDirs']) {
    const values = input[field] ?? [];
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v))) {
      throw new Error(`Config ${field} must be an array of nonempty, single-line strings`);
    }
    config[field] = field === 'allowTerms' ? values.map(v => v.trim()) : values.map(v => relativePattern(v, field));
  }
  config.buildCommand = input.buildCommand ?? null;
  if (config.buildCommand !== null && (typeof config.buildCommand !== 'string' || !config.buildCommand.trim())) {
    throw new Error('Config buildCommand must be a nonempty string or null');
  }
  if (input.notes !== undefined && typeof input.notes !== 'string') throw new Error('Config notes must be a string');
  for (const glob of [...config.forbid, ...config.allow]) globToRegExp(glob);
  return config;
}

export function readConfig(filename, optional = false) {
  if (optional && !fs.existsSync(filename)) return validateConfig({});
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('Cannot read config as JSON'); }
  return validateConfig(parsed);
}

// Common Git-style path globs: ** (including zero directories), *, ?, and character classes.
export function globToRegExp(glob) {
  glob = relativePattern(glob, 'glob');
  let expression = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        while (glob[i + 1] === '*') i++;
        if (glob[i + 1] === '/') { expression += '(?:.*/)?'; i++; }
        else expression += '.*';
      } else expression += '[^/]*';
    } else if (c === '?') expression += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) throw new Error('Unclosed character class in glob');
      let chars = glob.slice(i + 1, end);
      if (chars.startsWith('!')) chars = '^' + chars.slice(1);
      if (!chars || chars.includes('/')) throw new Error('Invalid character class in glob');
      expression += `[${chars}]`;
      i = end;
    } else expression += c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  try { return new RegExp(`^${expression}$`, 'i'); }
  catch { throw new Error('Invalid glob'); }
}

export function splitTerms(text) {
  return text.split(/\r?\n/).map(v => v.trim()).filter(v => v && !v.startsWith('#'));
}

export function classifyTerm(term) {
  const digits = term.replace(/\D/g, '');
  if (/^[+\d\s().-]+$/.test(term) && (digits.length === 10 || digits.length === 11)) return 'PHONE';
  if (term.includes('@')) return 'EMAIL';
  if (/^(?:[a-z0-9_-]+\.)+[a-z]{2,}$/i.test(term)) return 'DOMAIN';
  return 'NAME';
}

export function termKey(term) {
  return classifyTerm(term) === 'PHONE' ? `phone:${term.replace(/\D/g, '').slice(-10)}` : term.toLowerCase();
}

export function redacted(value) {
  // Short hand-written terms must not reveal the whole term in their preview.
  const preview = JSON.stringify(value.slice(0, Math.min(2, Math.max(0, value.length - 1)))).slice(1, -1);
  return `${preview}*** (length ${value.length})`;
}

export function runCommand(command, args, cwd) {
  // Windows cannot exec .cmd directly. The npm command and arguments here are fixed literals.
  const windowsNpm = process.platform === 'win32' && command === 'npm';
  const result = spawnSync(windowsNpm ? (process.env.ComSpec || 'cmd.exe') : command,
    windowsNpm ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args,
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} failed${result.status === null ? '' : ` (exit ${result.status})`}`);
  return result.stdout;
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  if (argv[0] !== 'scan') throw new Error(USAGE);
  const options = { repo: process.cwd(), dirs: [], archives: [], tracked: [], ranges: [], npm: false, json: false };
  const seen = new Set();
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json' || flag === '--npm-pack') {
      if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
      seen.add(flag); options[flag === '--json' ? 'json' : 'npm'] = true;
    } else if (flag === '--tracked') {
      if (seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
      seen.add(flag);
      options.tracked.push(argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'HEAD');
    } else if (['--repo', '--config', '--denylist', '--dir', '--git-archive', '--range'].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      if (flag !== '--dir' && seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
      seen.add(flag);
      if (flag === '--dir') options.dirs.push(value);
      else if (flag === '--git-archive') options.archives.push(value);
      else if (flag === '--range') options.ranges.push(value);
      else options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option ${flag}`);
  }
  options.repo = path.resolve(options.repo);
  if (!options.dirs.length && !options.archives.length && !options.tracked.length && !options.ranges.length && !options.npm) options.archives.push('HEAD');
  return options;
}

function forbiddenBuiltin(filename) {
  const parts = filename.toLowerCase().split('/');
  const basename = parts.at(-1);
  if (parts.includes('.edge-profile') || parts.includes('.release-guard')) return true;
  // Env templates (.env.example, .env.production.example, .env.sample, .env.template) ship by design.
  if (basename === '.env' || (basename.startsWith('.env.') && !/\.(example|sample|template)$/.test(basename))) return true;
  return /\.(pem|key|p12|pfx|sqlite|sqlite3|db|m4a|wav)$/.test(basename);
}

function safeArchivePath(name, root) {
  if (name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) {
    throw new Error('Unsafe path in archive or npm file list');
  }
  const result = path.resolve(root, name);
  if (result !== root && !result.startsWith(root + path.sep)) throw new Error('Unsafe target path');
  return result;
}

// Extract git's tar format ourselves: no tar executable or npm library required.
// Symlinks are represented by their tracked link text, never by their referents.
function materializeArchive(repo, ref, root) {
  const tar = path.join(root, 'archive.tar');
  const tree = path.join(root, 'tree');
  fs.mkdirSync(tree);
  runCommand('git', ['archive', '--format=tar', `--output=${tar}`, '--', ref], repo);
  const fd = fs.openSync(tar, 'r');
  const entries = [];
  let offset = 0, pax = {}, globalPax = {}, longName, longLink;
  const getString = (buffer, start, length) => buffer.subarray(start, start + length).toString('utf8').split('\0')[0];
  function readAt(size, position) {
    const data = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = fs.readSync(fd, data, read, size - read, position + read);
      if (!count) throw new Error('Truncated git archive');
      read += count;
    }
    return data;
  }
  function paxFields(data) {
    const fields = {};
    for (let start = 0; start < data.length;) {
      const space = data.indexOf(32, start);
      const size = Number(data.subarray(start, space).toString());
      if (space < 0 || !Number.isSafeInteger(size) || size <= space - start + 1 || start + size > data.length) throw new Error('Invalid archive metadata');
      const record = data.subarray(space + 1, start + size - 1).toString('utf8');
      const equals = record.indexOf('=');
      fields[record.slice(0, equals)] = record.slice(equals + 1);
      start += size;
    }
    return fields;
  }
  try {
    while (true) {
      const header = readAt(512, offset);
      if (header.every(b => b === 0)) break;
      const size = parseInt(getString(header, 124, 12).trim(), 8) || 0;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid archive size');
      const type = String.fromCharCode(header[156]);
      const dataOffset = offset + 512;
      offset = dataOffset + Math.ceil(size / 512) * 512;
      if (['x', 'g', 'L', 'K'].includes(type)) {
        if (size > MAX_TEXT_SIZE) throw new Error('Oversized archive metadata');
        const data = readAt(size, dataOffset);
        if (type === 'x') pax = paxFields(data);
        else if (type === 'g') globalPax = { ...globalPax, ...paxFields(data) };
        else if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
        else longLink = data.toString('utf8').replace(/\0.*$/s, '');
        continue;
      }
      const prefix = getString(header, 345, 155);
      const fields = { ...globalPax, ...pax };
      const name = fields.path ?? longName ?? ((prefix ? prefix + '/' : '') + getString(header, 0, 100));
      const link = fields.linkpath ?? longLink ?? getString(header, 157, 100);
      pax = {}; longName = undefined; longLink = undefined;
      const destination = safeArchivePath(name, tree);
      if (type === '5') { fs.mkdirSync(destination, { recursive: true }); continue; }
      if (type === '2') { entries.push({ name, link }); continue; }
      if (type !== '0' && type !== '\0') throw new Error('Unsupported entry type in git archive');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const out = fs.openSync(destination, 'wx');
      try {
        for (let copied = 0; copied < size;) {
          const bytes = readAt(Math.min(64 * 1024, size - copied), dataOffset + copied);
          fs.writeFileSync(out, bytes); copied += bytes.length;
        }
      } finally { fs.closeSync(out); }
      entries.push({ name, file: destination });
    }
  } finally { fs.closeSync(fd); }
  return entries;
}

function directoryEntries(root) {
  if (!fs.statSync(root).isDirectory()) throw new Error('Directory target must be a directory');
  const entries = [];
  function walk(current, prefix) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + item.name;
      const file = path.join(current, item.name);
      if (item.isSymbolicLink()) entries.push({ name, link: fs.readlinkSync(file) });
      else if (item.isDirectory()) walk(file, name + '/');
      else if (item.isFile()) entries.push({ name, file });
      else throw new Error('Unsupported file type in directory target');
    }
  }
  walk(root, '');
  return entries;
}

function npmEntries(repo) {
  const output = runCommand('npm', ['pack', '--dry-run', '--json'], repo);
  let packages;
  try { packages = JSON.parse(output); }
  catch {
    // Lifecycle scripts may log to stdout before npm's final JSON array.
    // Discard those logs (which may be private); accept only a complete JSON suffix.
    for (const match of [...output.matchAll(/^[ \t]*\[/gm)].reverse()) {
      try { packages = JSON.parse(output.slice(match.index)); break; } catch { /* Try the preceding array start. */ }
    }
    if (!packages) throw new Error('npm pack did not return valid JSON');
  }
  if (!Array.isArray(packages) || !packages.length) throw new Error('npm pack returned no packages');
  return packages.flatMap(pkg => {
    if (!Array.isArray(pkg.files)) throw new Error('npm pack returned no file list');
    return pkg.files.map(item => {
      if (typeof item.path !== 'string') throw new Error('Invalid npm file list');
      const file = safeArchivePath(item.path, repo);
      // npm packs the link itself, if present, rather than traversing outside the repo.
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return { name: item.path, link: fs.readlinkSync(file) };
      if (!stat.isFile()) throw new Error('npm file list contains a non-file');
      return { name: item.path, file };
    });
  });
}

function gitBytes(repo, args) {
  const result = spawnSync('git', args, { cwd: repo, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('git failed reading scan target');
  return result.stdout;
}

function resolveRef(repo, ref, type) {
  return runCommand('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{${type}}`], repo).trim();
}

function blobBytes(repo, oid) {
  const size = Number(runCommand('git', ['cat-file', '-s', oid], repo).trim());
  return size > MAX_TEXT_SIZE ? null : gitBytes(repo, ['cat-file', 'blob', oid]);
}

function* trackedEntries(repo, ref) {
  const tree = resolveRef(repo, ref, 'tree');
  for (const record of gitBytes(repo, ['ls-tree', '-r', '-z', '--full-tree', tree]).toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    yield { name: record.slice(tab + 1), data: type === 'blob' ? blobBytes(repo, oid) : null };
  }
}

function rangeCommits(repo, range) {
  const parts = range.split('..');
  if (parts.length !== 2 || parts.some(ref => !ref || ref.startsWith('.'))) throw new Error('Range must be <base>..<head>');
  const [base, head] = parts;
  const tip = resolveRef(repo, head, 'commit');
  let excluded = null;
  if (!/^0+$/.test(base)) {
    // Only a full object id may be absent (the pre-force-push tip CI reports); a bad ref name stays an error.
    try { excluded = [resolveRef(repo, base, 'commit')]; } catch (error) { if (!/^[0-9a-f]{40}$/i.test(base)) throw error; }
  }
  // New branch, or a base this clone lacks: scan what no other remote branch already has. In CI the
  // pushed ref already points at the tip, so it must never exclude itself; no refs left means full history.
  excluded ??= runCommand('git', ['for-each-ref', '--format=%(objectname)', 'refs/remotes/'], repo)
    .trim().split(/\s+/).filter(oid => oid && oid !== tip);
  const not = excluded.length ? ['--not', ...excluded] : [];
  return runCommand('git', ['rev-list', '--reverse', '--topo-order', tip, ...not], repo).trim().split(/\s+/).filter(Boolean);
}

// NUL-delimited raw diffs retain unusual filenames; merge diffs use only the first parent.
function* rangeEntries(repo, commit) {
  const [, parent] = runCommand('git', ['rev-list', '--parents', '-n', '1', commit], repo).trim().split(' ');
  const args = ['diff-tree', '--no-commit-id', '--raw', '--no-abbrev', '-z', '-r', '-M', '--no-ext-diff', '--no-textconv'];
  args.push(...(parent ? [parent, commit] : ['--root', commit]));
  const records = gitBytes(repo, args).toString('utf8').split('\0');
  const short = runCommand('git', ['rev-parse', '--short', commit], repo).trim();
  for (let i = 0; i < records.length && records[i];) {
    const [oldMode, mode, oldOid, newOid, status] = records[i++].split(' ');
    let name = records[i++];
    if (/^[RC]/.test(status)) name = records[i++];
    if (status === 'D') continue;
    const entry = { name, commit: short, checkPath: /^[ARC]/.test(status), data: null };
    // Gitlinks have no file contents. Symlinks are ordinary blobs containing link text.
    if (mode === '160000') { yield entry; continue; }
    const content = textContent({ data: blobBytes(repo, newOid) });
    if (content === null) { yield entry; continue; }
    const added = [], lineNumbers = [];
    if (/^0+$/.test(oldOid) || oldMode === ':160000') {
      const lines = content.split('\n');
      if (lines.at(-1) === '') lines.pop();
      lines.forEach((line, index) => { added.push(line); lineNumbers.push(index + 1); });
    } else {
      const patch = gitBytes(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=0',
        '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', oldOid, newOid]).toString('utf8');
      let line;
      for (const record of patch.split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(record);
        if (hunk) line = Number(hunk[1]);
        else if (line !== undefined && record.startsWith('+')) { added.push(record.slice(1)); lineNumbers.push(line++); }
        else if (line !== undefined && record.startsWith(' ')) line++;
      }
    }
    entry.data = Buffer.from(added.join('\n'));
    entry.lineNumbers = lineNumbers;
    yield entry;
  }
}

function textContent(entry) {
  if (entry.file && fs.statSync(entry.file).size > MAX_TEXT_SIZE) return null;
  const bytes = entry.data !== undefined ? entry.data : entry.link !== undefined ? Buffer.from(entry.link) : fs.readFileSync(entry.file);
  if (bytes === null) return null;
  if (bytes.length > MAX_TEXT_SIZE || bytes.includes(0)) return null;
  // Reject invalid UTF-8 and binary control bytes; normal whitespace remains text.
  if (bytes.some(b => b < 32 && ![9, 10, 12, 13].includes(b))) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

export function scan(options) {
  const config = readConfig(options.config ? path.resolve(options.repo, options.config) : path.join(options.repo, '.release-guard.json'), !options.config);
  const forbid = config.forbid.map(globToRegExp);
  const allow = config.allow.map(globToRegExp);
  const excluded = new Set(config.allowTerms.map(termKey));
  const rawTerms = [];
  if (options.denylist) {
    try { rawTerms.push(...splitTerms(fs.readFileSync(path.resolve(options.repo, options.denylist), 'utf8'))); }
    catch { throw new Error('Cannot read denylist file'); }
  }
  if (process.env.RELEASE_GUARD_DENYLIST) rawTerms.push(...splitTerms(process.env.RELEASE_GUARD_DENYLIST));
  const terms = [...new Map(rawTerms.map(term => [termKey(term), term])).values()].filter(term => !excluded.has(termKey(term)));
  const compiledTerms = terms.map(term => {
    const kind = classifyTerm(term);
    const escaped = term.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    return { term, kind, regex: kind === 'PHONE' ? null : new RegExp(kind === 'NAME' ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, 'giu') };
  });
  const report = { version: VERSION, targets: [], warnings: [], violations: [], summary: { files: 0, textFiles: 0, violations: 0, targets: 0 } };
  if (!rawTerms.length) report.warnings.push('WARNING: denylist check skipped; no denylist terms supplied (use --denylist or RELEASE_GUARD_DENYLIST).');
  function check(entries, target, register = true) {
    if (register) report.targets.push(target);
    for (const entry of entries) {
      report.summary.files++;
      const fields = { target, path: entry.name, ...(entry.commit ? { commit: entry.commit } : {}) };
      if (entry.checkPath !== false) {
        if (forbiddenBuiltin(entry.name)) report.violations.push({ ...fields, rule: 'FORBIDDEN_BUILTIN', detail: 'built-in forbidden path' });
        if (forbid.some(pattern => pattern.test(entry.name))) report.violations.push({ ...fields, rule: 'FORBIDDEN_CONFIG', detail: 'configured instance-data path' });
      }
      if (allow.some(pattern => pattern.test(entry.name))) continue;
      const content = textContent(entry);
      if (content === null) continue;
      report.summary.textFiles++;
      const lineStarts = [0];
      for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
      function add(rule, match, index) {
        let lo = 0, hi = lineStarts.length;
        while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid; }
        report.violations.push({ ...fields, line: entry.lineNumbers ? entry.lineNumbers[lo] : lo + 1, rule, detail: redacted(match) });
      }
      for (const [rule, regex] of SECRET_RULES) {
        for (const match of content.matchAll(regex)) {
          if (rule === 'SECRET_AWS' && match[0] === 'AKIAIOSFODNN7EXAMPLE') continue;
          // Documentation placeholders (sk-ant-xxxx..., sk_live_xx..., re_your_key...) are not secrets.
          if (/x{4,}|X{4,}|\*{4,}|0{8,}|your|example|placeholder|dummy|redacted/i.test(match[0])) continue;
          add(rule, match[0], match.index);
        }
      }
      let phones;
      for (const { term, kind, regex } of compiledTerms) {
        if (kind === 'PHONE') {
          phones ??= [...content.matchAll(/\d(?:[\d \t().-]*\d)?/g)].filter(m => [10, 11].includes(m[0].replace(/\D/g, '').length));
          for (const match of phones) if (match[0].replace(/\D/g, '').slice(-10) === term.replace(/\D/g, '').slice(-10)) add('CLIENT_PHONE', term, match.index);
        } else for (const match of content.matchAll(regex)) add(`CLIENT_${kind}`, match[0], match.index);
      }
    }
  }
  for (const ref of options.archives) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-archive-'));
    try { check(materializeArchive(options.repo, ref, temp), `git-archive:${ref}`); }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  for (const ref of options.tracked ?? []) check(trackedEntries(options.repo, ref), `tracked:${ref}`);
  for (const range of options.ranges ?? []) {
    const target = `range:${range}`;
    const commits = rangeCommits(options.repo, range);
    report.targets.push(target);
    for (const commit of commits) check(rangeEntries(options.repo, commit), target, false);
  }
  for (const dir of options.dirs) check(directoryEntries(path.resolve(options.repo, dir)), `dir:${dir}`);
  if (options.npm) check(npmEntries(options.repo), 'npm-pack');
  report.summary.violations = report.violations.length;
  report.summary.targets = report.targets.length;
  return report;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) { console.log(USAGE); return 0; }
    const report = scan(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const warning of report.warnings) console.error(warning);
      for (const issue of report.violations) {
        const displayPath = /[\x00-\x1f\x7f]/.test(issue.path) ? JSON.stringify(issue.path) : issue.path;
        console.log(`${displayPath}${issue.line ? ':' + issue.line : ''}  ${issue.rule}  ${issue.detail}${issue.commit ? '  ' + issue.commit : ''}`);
      }
      console.log(`Scanned ${report.summary.files} files (${report.summary.textFiles} text) across ${report.summary.targets} targets: ${report.summary.violations} violations.`);
    }
    return report.violations.length ? 1 : 0;
  } catch (error) {
    // OS errors can contain file contents or subprocess output; expose only controlled messages.
    const message = error.code ? `Operation failed (${error.code})` : error.message;
    if (argv.includes('--json')) console.log(JSON.stringify({ version: VERSION, error: message }));
    else console.error(`release-guard: ${message}`);
    return 2;
  }
}

// Resolve both paths when launched through a junction or symlink, so main() still runs.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
