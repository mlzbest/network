/**
 * 构建期版本号派生与 package.json 同步（CommonJS，供 config/index.ts 直接 require）。
 *
 * ⚠️ 必须保持 **纯 Node、零依赖**：本文件被 config/index.ts `import` 后，会由 Taro 的
 * esbuild 一起打进临时 cjs 配置产物再执行。一旦引入 `node:fs/promises` 之类的新内置模块，
 * esbuild 打包时容易留下 `__require` 兜底，运行时命中 "Dynamic require of 'node:fs/promises'
 * is not supported" 直接让整条构建失败（实测踩过）。只用 `require('fs')` / `require('path')`。
 *
 * 为什么用 .cjs + 正则而不是 import TS 文件：Taro 配置文件本身由 esbuild 打包成 cjs 执行，
 * `require('../src/lib/app-release.ts')` 会因扩展名未知抛错；为读一个字符串引入 ts-node
 * 注册器不值得。CHANGELOG 的 version 字段名在本项目内不与其他结构冲突，按首条匹配足够稳。
 *
 * 规则（发版只改 src/lib/app-release.ts 的 CHANGELOG 顶部条目）：
 * - 解析不到版本 → 返回 null，调用方回退 pkg.version（不让配置层因解析失败全线阻塞）；
 * - CHANGELOG 顶部版本 ≠ package.json.version → **自动改写 package.json** 并打日志。
 *   mini-ci 上传时用的就是 package.json 的 version，自动同步可保证「微信后台版本号 /
 *   关于行 / 更新日志」三处永远一致，不需要人工记三处。
 */
const fs = require('fs');
const path = require('path');

const RELEASE_TS = path.resolve(__dirname, '../src/lib/app-release.ts');
const PKG_JSON = path.resolve(__dirname, '../package.json');

/** 从 app-release.ts 里取 CHANGELOG 第一个 version 字面量 */
function readChangelogTopVersion() {
  let src;
  try {
    src = fs.readFileSync(RELEASE_TS, 'utf8');
  } catch (e) {
    console.warn(`[app-version] ⚠️ 读不到 ${RELEASE_TS}，跳过版本号校验:`, e && e.message);
    return null;
  }
  const start = src.indexOf('export const CHANGELOG');
  if (start < 0) {
    console.warn('[app-version] ⚠️ app-release.ts 未找到 CHANGELOG 定义，跳过版本号校验');
    return null;
  }
  const m = /version:\s*'([^']+)'/.exec(src.slice(start));
  if (!m) {
    console.warn('[app-version] ⚠️ CHANGELOG 首条缺少 version 字面量，跳过版本号校验');
    return null;
  }
  return m[1];
}

/** 从 app-release.ts 里取 RELEASES 第一个 version 字面量（发布记录顶部） */
function readReleasesTopVersion() {
  let src;
  try {
    src = fs.readFileSync(RELEASE_TS, 'utf8');
  } catch (e) {
    console.warn(`[app-version] ⚠️ 读不到 ${RELEASE_TS}，跳过发布记录校验:`, e && e.message);
    return null;
  }
  const start = src.indexOf('export const RELEASES');
  if (start < 0) {
    console.warn('[app-version] ⚠️ app-release.ts 未找到 RELEASES 定义，跳过发布记录校验');
    return null;
  }
  const m = /version:\s*'([^']+)'/.exec(src.slice(start));
  if (!m) {
    console.warn('[app-version] ⚠️ RELEASES 首条缺少 version 字面量，跳过发布记录校验');
    return null;
  }
  return m[1];
}

/**
 * 发版漏改门禁：`RELEASES` 与 `CHANGELOG` 的顶部版本号必须一致。
 *
 * ⚠️ 为什么必须拦（用户报「最新版本是 V74，但更新日志只到 V73」的真实根因）：
 *   更新日志列表**以 CHANGELOG 为内容骨架**（只有写了说明的版本才进列表），
 *   而 `RELEASES` 只负责排序与日期。发版时若只改了 `RELEASES` 忘了改 `CHANGELOG`，
 *   新版本就不会进列表、首条停在旧版本，用户看到「关于显示 V74、更新日志只到 V73」。
 *   微信**没有「读取历史发布记录」的接口**（`getAccountInfoSync()` 只回当前版本号），
 *   历史日期与说明文案只能手写，所以只能在构建期把「漏改」拦下来。
 *
 * 规则：两者都能解析且不相等 → 抛错终止构建，并给出可直接照做的修复指引。
 * 任一解析失败（文件缺失/结构变更）→ 只告警不拦，避免配置层因解析问题全线阻塞。
 */
function assertReleaseEntriesInSync() {
  const changelogTop = readChangelogTopVersion();
  const releasesTop = readReleasesTopVersion();
  if (!changelogTop || !releasesTop) return;
  if (changelogTop === releasesTop) {
    console.log(`[app-version] ✅ 发布记录与更新日志顶部版本一致: V${changelogTop}`);
    return;
  }
  throw new Error(
    `[app-version] ❌ 发版漏改：RELEASES 顶部是 V${releasesTop}，CHANGELOG 顶部是 V${changelogTop}。\n` +
      `  更新日志列表以 CHANGELOG 为内容骨架，漏改会让新版本 V${releasesTop} 不出现在列表里。\n` +
      `  请在 src/lib/app-release.ts 的 CHANGELOG **顶部**追加一条同版本号条目：\n` +
      `    {\n` +
      `      version: '${releasesTop}',\n` +
      `      date: '<该版本改动落地那天 YYYY-MM-DD>',\n` +
      `      title: '<一句话主题>',\n` +
      `      items: ['<面向使用者的改动点>'],\n` +
      `    },\n` +
      `  若这次发布确实没有值得说明的改动，请把 RELEASES 顶部那条也一并去掉，保持两处一致。`,
  );
}

/**
 * 把 package.json 的 version 对齐到 CHANGELOG 顶部版本。
 * @returns {{ version: string | null; synced: boolean }}
 */
function ensurePackageVersionSynced() {
  assertReleaseEntriesInSync();
  const version = readChangelogTopVersion();
  if (!version) return { version: null, synced: false };

  let raw;
  try {
    raw = fs.readFileSync(PKG_JSON, 'utf8');
  } catch (e) {
    console.warn('[app-version] ⚠️ 读不到 package.json，跳过同步:', e && e.message);
    return { version, synced: false };
  }

  let current;
  try {
    current = JSON.parse(raw).version;
  } catch (e) {
    console.warn('[app-version] ⚠️ 解析 package.json 失败，跳过同步:', e && e.message);
    return { version, synced: false };
  }

  if (current === version) return { version, synced: false };

  // 只替换 version 行，保留 package.json 原有格式与键顺序（避免整文件重写产生巨大 diff）
  const next = raw.replace(/("version"\s*:\s*")[^"]+(")/, '$1' + version + '$2');
  if (next === raw) {
    console.warn(
      `[app-version] ⚠️ package.json 版本(${current})与 CHANGELOG(${version})不一致，` +
        '但未匹配到可替换的 version 行，请手工修改',
    );
    return { version, synced: false };
  }
  fs.writeFileSync(PKG_JSON, next, 'utf8');
  console.log(`[app-version] 🔢 package.json version 已同步为 CHANGELOG 顶部版本: ${current} -> ${version}`);
  return { version, synced: true };
}

module.exports = { ensurePackageVersionSynced, readChangelogTopVersion, readReleasesTopVersion, assertReleaseEntriesInSync };
