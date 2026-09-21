#!/usr/bin/env node
/**
 * Version bump script for network-app
 * Usage:
 *   pnpm version:bump          # bump patch (1.0.0 -> 1.0.1)
 *   pnpm version:bump minor    # bump minor (1.0.0 -> 1.1.0)
 *   pnpm version:bump major    # bump major (1.0.0 -> 2.0.0)
 *   pnpm version:bump <note>   # bump patch with custom changelog note
 */

const fs = require('fs');
const path = require('path');

const pkgPath = path.resolve(__dirname, '../package.json');
const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
const versionLogPath = path.resolve(__dirname, '../VERSION_HISTORY.json');

// Read package.json
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;

// Parse current version
const [major, minor, patch] = oldVersion.split('.').map(Number);

// Determine bump type
let bumpType = 'patch';
let note = null;

const args = process.argv.slice(2);
if (args.length > 0) {
  const firstArg = args[0];
  if (firstArg === 'minor' || firstArg === 'major') {
    bumpType = firstArg;
    note = args[1] || 'Update';
  } else if (firstArg === 'patch' || firstArg === 'bump') {
    note = args[1] || 'Update';
  } else {
    // Assume it's a note, bump patch
    note = firstArg;
  }
}

if (!note) note = 'Update';

// Calculate new version
let newMajor = major;
let newMinor = minor;
let newPatch = patch;

if (bumpType === 'patch') {
  newPatch++;
} else if (bumpType === 'minor') {
  newMinor++;
  newPatch = 0;
} else if (bumpType === 'major') {
  newMajor++;
  newMinor = 0;
  newPatch = 0;
}

const newVersion = `${newMajor}.${newMinor}.${newPatch}`;

// Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`✅ Version bumped: ${oldVersion} -> ${newVersion}`);

// Update CHANGELOG.md
const today = new Date().toISOString().split('T')[0];
let changelog = '';

try {
  changelog = fs.readFileSync(changelogPath, 'utf8');
} catch (e) {
  changelog = '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n';
}

const entry = `## [${newVersion}] - ${today}\n\n### Changed\n- ${note}\n\n`;

if (changelog.includes(`## [${newVersion}]`)) {
  console.log(`⚠️  Version ${newVersion} already exists in changelog, skipping.`);
} else {
  changelog = changelog.replace(/^# Changelog\s*\n/gm, `# Changelog\n\n${entry}`);
  if (!changelog.includes(`## [${newVersion}]`)) {
    changelog = entry + changelog;
  }
  fs.writeFileSync(changelogPath, changelog);
  console.log(`📝 Changelog updated: CHANGELOG.md`);
}

// Update VERSION_HISTORY.json
let history = [];
try {
  const raw = fs.readFileSync(versionLogPath, 'utf8');
  history = JSON.parse(raw);
} catch (e) {}

history.unshift({
  version: newVersion,
  date: today,
  note: note,
  bumpType: bumpType,
});

fs.writeFileSync(versionLogPath, JSON.stringify(history, null, 2) + '\n');
console.log(`📋 Version history updated: VERSION_HISTORY.json`);

// Print summary
console.log(`\n📊 Summary:`);
console.log(`   Old version: ${oldVersion}`);
console.log(`   New version: ${newVersion}`);
console.log(`   Changelog:   ${note}`);
