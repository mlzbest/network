#!/usr/bin/env node
/**
 * Upload script with auto version bump
 * Usage:
 *   pnpm upload                 # bump patch and upload
 *   pnpm upload "fix login bug" # bump patch with changelog note
 *   pnpm upload minor "new feature" # bump minor with note
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const note = args[0] || 'Update';

// Step 1: Bump version
console.log(`\n🔨 Step 1: Bumping version...`);
execSync(`node ${path.join(__dirname, 'bump-version.js')} "${note}"`, {
  stdio: 'inherit',
});

// Step 2: Build
console.log(`\n🔨 Step 2: Building mini program...`);
execSync('pnpm build:weapp', { stdio: 'inherit' });

// Step 3: Upload
console.log(`\n🔨 Step 3: Uploading to WeChat...`);
execSync(`pnpm exec taro build --type weapp --upload --desc "Multi-platform Network Diagnostic & Chat Application"`, {
  stdio: 'inherit',
});

// Step 4: Verify GitHub version matches uploaded version
console.log(`\n🔍 Step 4: Verifying GitHub version consistency...`);
try {
  const pkgLocal = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const localVersion = pkgLocal.version;
  execSync('git fetch origin main', { encoding: 'utf8', stdio: 'pipe' });
  const remotePkg = execSync('git show origin/main:package.json', { encoding: 'utf8', stdio: 'pipe' });
  const remoteVersion = JSON.parse(remotePkg).version;
  if (localVersion === remoteVersion) {
    console.log(`   ✅ GitHub 版本一致: v${remoteVersion}`);
  } else {
    console.log(`   ⚠️  GitHub 版本不一致! 本地/上传: v${localVersion}, GitHub: v${remoteVersion}`);
  }
} catch (e) {
  console.log(`   ⚠️  版本检查失败: ${e.message}`);
}
