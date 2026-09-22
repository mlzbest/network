#!/usr/bin/env node
/**
 * 统一部署脚本 - 确保 git版本 = package.json版本 = 微信上传版本
 *
 * 用法:
 *   node scripts/deploy.js                 # 增量 patch + 构建 + commit + push + 上传
 *   node scripts/deploy.js "fix login bug" # 带说明的增量
 *   node scripts/deploy.js minor "new feature"  # 增量 minor
 *
 * 注意: 此脚本是唯一的部署入口，不要绕过它
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let note = 'Update';
let bumpType = 'patch';

if (args.length > 0) {
  const first = args[0];
  if (first === 'minor' || first === 'major') {
    bumpType = first;
    note = args[1] || 'Update';
  } else if (first === 'patch' || first === 'bump') {
    note = args[1] || 'Update';
  } else {
    note = first;
  }
}

const projectDir = path.resolve(__dirname, '..');
process.chdir(projectDir);

// ========== Step 0: 版本一致性预检 ==========
console.log('\n🔍 Step 0: 版本一致性预检...');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const currentVersion = pkg.version;
console.log(`   当前 package.json 版本: ${currentVersion}`);

// 检查最后一次 commit 是否已包含此版本
try {
  const lastCommit = execSync('git log --oneline -1', { encoding: 'utf8' }).trim();
  if (lastCommit.includes(currentVersion)) {
    console.log(`   ✅ 最新版本已匹配: ${currentVersion}`);
  } else {
    console.log(`   ⚠️  最新版本未包含 ${currentVersion}，将重新 bump`);
  }
} catch (e) {
  console.log(`   ⚠️  git log 失败: ${e.message}`);
}

// ========== Step 1: Bump Version ==========
console.log(`\n🔨 Step 1: Bumping version (type=${bumpType}, note="${note}")...`);
execSync(`node ${path.join(__dirname, 'bump-version.js')} ${bumpType} "${note}"`, {
  stdio: 'inherit',
});

const newPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const newVersion = newPkg.version;
console.log(`   → 新版本: ${currentVersion} -> ${newVersion}`);

// ========== Step 2: Build ==========
console.log(`\n🔨 Step 2: Building mini program...`);
execSync('pnpm build:weapp', { stdio: 'inherit' });

// ========== Step 3: Commit & Push ==========
console.log(`\n🔨 Step 3: Committing & Pushing...`);
execSync('git add -A', { stdio: 'inherit' });
try {
  execSync(`git commit -m "chore: v${newVersion} deploy - ${note}"`, { stdio: 'inherit' });
} catch (e) {
  console.log('   ℹ️  No changes to commit');
}
execSync('git push github-ssh main', { stdio: 'inherit' });

// ========== Step 4: Upload to WeChat ==========
console.log(`\n🔨 Step 4: Uploading to WeChat...`);
execSync(
  `pnpm exec taro build --type weapp --upload --desc "Multi-platform Network Diagnostic & Chat Application"`,
  { stdio: 'inherit' }
);

// ========== Done ==========
console.log(`\n✅ Deployed v${newVersion} successfully!`);
console.log(`   QR: dist/upload.png`);
console.log(`   → 请在微信后台设为体验版`);
