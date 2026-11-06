/**
 * 应用更新日志——**版本号的唯一真源**。
 *
 * ⚠️ 版本口径（发版只改这一处）：
 * - 版本号一律是**纯数字的发布序号**（如 `64`），对外统一渲染成 `V64`（大写 V）。
 *   微信后台每次上传发布都会把版本号 +1，所以「关于」行显示的 V 号就是微信后台的发布版本号；
 * - `CHANGELOG[0].version` 即「当前发布版本」。profile 页「关于」行取构建期注入的全局常量
 *   `APP_RELEASE_VERSION`，`<ChangelogList>` 的「当前版本」徽标取本文件导出的
 *   `RELEASE_VERSION`——两者由同一处派生，永远相等，不存在第二份人工维护的副本；
 * - `config/index.ts` 在**构建期**读取本文件顶部条目，把 `package.json` 的 version 自动对齐
 *   过去（mini-ci 上传时 package.json 的 version 就是微信后台的版本号），并把同一个值注入为
 *   全局常量。人工只需维护 CHANGELOG，杜绝「上显 V1、下显 V64」这类漂移；
 * - 正式版里微信会回包真实版本号（`getAccountInfoSync().miniProgram.version`），此时以微信
 *   为准；开发版/体验版该字段为空串，回落到本文件的值。
 *
 * ⚠️ 历史坑（勿回退）：版本号曾用语义化 `1.4.0`，与微信后台的递增发布号（如 64）对不上，
 * 用户看到的「关于」版本和后台实际发布版本不一致。现统一为纯数字发布序号。
 * 另一个历史坑：package.json 的 version 长期停在脚手架占位 `1.0.0` 从不递增，导致「关于」永远
 * 显示同一版本。现在只需维护 CHANGELOG。
 */

import { logDbg } from './logger';

export interface ChangelogEntry {
  /** 发布序号，纯数字字符串，形如 '64'；渲染时统一补大写 V 前缀（V64） */
  version: string;
  /** 上线日期 YYYY-MM-DD（取自该版本最后一次提交的日期） */
  date: string;
  /** 一句话主题 */
  title: string;
  /** 主要改动点，面向使用者描述，不写内部实现术语 */
  items: string[];
}

/**
 * 更新日志列表项：在 ChangelogEntry 基础上允许「只有版本号与日期、没有改动说明」。
 *
 * ⚠️ 为什么需要它（缺陷⑮，用户报「更新日志有跳版本，比如 V73--V64-V63」）：
 *   微信后台每次上传发布都会把发布号 +1，但**不是每次发布都值得写一条更新日志**
 *   （可能只是修个错别字、调个文案）。于是 CHANGELOG 里只记录「有内容可写」的版本，
 *   发布号序列天然会出现空档（如 73 之后直接是 64）。
 *   旧实现把「关于」行的真实发布号（73）硬覆盖到 CHANGELOG 顶部条目（原本是 65）上，
 *   结果列表渲染成 73 → 64 → 63：既不是降幂连续、又让人以为中间版本被漏掉了。
 *   正解：**发布记录（RELEASES）与更新日志（CHANGELOG）分开**——发布记录负责
 *   「每个发布号 + 真实发布日期」的完整序列，更新日志只负责「有内容可写的版本」的说明文案；
 *   列表按发布号降幂合并两者，没有说明文案的版本只显示版本号与日期。
 */
export interface ChangelogListItem {
  version: string;
  date: string;
  /** 无说明文案的版本为 undefined（列表只显示版本号与日期） */
  title?: string;
  items?: string[];
}

/**
 * 发布记录——**发布号与真实发布日期的唯一真源**。
 *
 * ⚠️ 与 CHANGELOG 的分工（勿再合并成一份）：
 *   - 本数组记录**每一次真实发布**（发布号 + 发布日期），是「关于」行版本号与列表排序的依据；
 *   - CHANGELOG 只记录**有内容可写的版本**的改动说明，允许与发布号序列存在空档。
 *
 * ⚠️ 维护方式：每次在微信后台上传发布后，在**顶部**追加一条 `{ version, date }`。
 *   `version` 必须与微信后台的发布号完全一致（纯数字字符串），`date` 填真实发布当天。
 *   若这次发布有值得说明的改动，再在 CHANGELOG 顶部追加同版本号的说明条目。
 *
 * ⚠️ 为什么不能只靠 CHANGELOG 推断发布号：CHANGELOG 会跳号（见 ChangelogListItem 注释），
 *   用它当发布序列会让列表出现「73 → 64」这种断崖，用户会以为版本被漏掉了。
 */
export const RELEASES: { version: string; date: string }[] = [
  { version: '75', date: '2026-10-16' },
  { version: '74', date: '2026-10-11' },
  { version: '73', date: '2026-10-10' },
  { version: '72', date: '2026-10-10' },
  { version: '71', date: '2026-10-10' },
  { version: '70', date: '2026-10-10' },
  { version: '69', date: '2026-10-09' },
  { version: '68', date: '2026-10-09' },
  { version: '67', date: '2026-10-08' },
  { version: '66', date: '2026-10-08' },
  { version: '65', date: '2026-10-08' },
  { version: '64', date: '2026-10-08' },
  { version: '63', date: '2026-10-03' },
  { version: '62', date: '2026-09-30' },
  { version: '61', date: '2026-09-27' },
  { version: '60', date: '2026-09-24' },
];

/**
 * 更新日志。条目内容按 git 提交记录的功能上线时间归并整理，日期为真实提交日期。
 * 顺序：新 → 旧。**第一条永远是当前发布版本。**
 * ⚠️ 每次发版都要在顶部追加一条新条目（version 取上一个 +1），否则「关于」的版本号
 *    与更新日志会停在旧版本、和微信后台对不上。
 */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '75',
    date: '2026-10-16',
    title: '批量诊断指令说明与结果排版',
    items: [
      '批量诊断页新增 help 说明：选中哪条指令就显示哪条的用法与结果解读',
      '新增 all 指令，一次列出全部可用指令的总览清单',
      '修复在线状态查询结果排版粘连、字段连成一片看不清的问题',
      'ping 页按钮组调整：移除「强制重测」，改为「批量诊断」入口并统一图标风格',
    ],
  },
  {
    version: '74',
    date: '2026-10-11',
    title: '更新日志补全与版本号对齐',
    items: [
      '更新日志补齐 V66~V73 的改动说明，列表从最新版本连续排到 V60',
      '「关于」的版本号与更新日志首条严格同源，不再出现两处对不上',
      '修复预览环境下读取版本号报错的问题',
    ],
  },
  {
    version: '73',
    date: '2026-10-10',
    title: '更新日志与发布记录分离',
    items: [
      '更新日志改为只列出有改动说明的版本，不再出现空档版本占位',
      '版本号与日期统一取自发布记录，排序固定为从新到旧',
      '修复「关于」版本号与更新日志首条对不上的问题',
    ],
  },
  {
    version: '72',
    date: '2026-10-10',
    title: '会话列表刷新与在线状态修复',
    items: [
      '修复发完消息返回会话列表看不到最新摘要、必须下拉刷新的问题',
      '修复好友发消息后仍显示不在线、最后活跃时间停在旧值的问题',
      '会话列表新增「刚刚上线」轻提示，对方上线时一眼可见',
      '顶栏显示对方本次已在线时长',
    ],
  },
  {
    version: '71',
    date: '2026-10-10',
    title: '消息状态与删除修复',
    items: [
      '消息状态细化为发送中 / 已送达 / 已读，用对勾图标表示',
      '发送中的转圈图标加上旋转动画',
      '修复双方都删除后消息复活、重进会话闪退的问题',
      '修复已读状态被误标为双勾的问题',
    ],
  },
  {
    version: '70',
    date: '2026-10-10',
    title: '消息引用回复',
    items: [
      '长按消息可以引用回复，气泡上方显示被引用的原文',
      '点击引用块可定位到原消息',
    ],
  },
  {
    version: '69',
    date: '2026-10-09',
    title: '运动步数对比',
    items: [
      '新增每日运动步数对比，可查看双方最近几天的步数',
      '步数日期改为从新到旧排列',
      '首次同步会自动绑定微信身份，无需额外操作',
    ],
  },
  {
    version: '68',
    date: '2026-10-09',
    title: '语音转文字与文件收发',
    items: [
      '语音消息支持转文字，识别不成功时会说明具体原因',
      '可以发送文件，会话列表直接显示文件名',
      '图片、语音在会话列表里显示中文摘要，不再出现英文标记',
      '多图发送提速，气泡内逐张显示进度并可中途取消',
    ],
  },
  {
    version: '67',
    date: '2026-10-08',
    title: '顶栏与连点区域调整',
    items: [
      '修复顶栏图标被微信胶囊按钮遮挡的问题',
      '在线圆点与连点返回区域改为贴合对方昵称长度自适应',
      '步数对比改为顶栏入口弹层，不再占用消息区',
    ],
  },
  {
    version: '66',
    date: '2026-10-08',
    title: '版本号与更新日志对齐发布号',
    items: [
      '「关于」的版本号改为显示微信后台的实际发布号，格式统一为 V + 数字',
      '更新日志的版本号与「关于」同源同格式，不再出现两处对不上的情况',
      '新增可展开的更新日志，列出最近几个版本的主要改动',
    ],
  },
  {
    version: '65',
    date: '2026-10-08',
    title: '版本号构建期自动派生',
    items: [
      '版本号改为构建期从更新日志顶部自动派生，不再手工维护副本',
      '修复预览环境变量缺失导致的构建失败',
    ],
  },
  {
    version: '64',
    date: '2026-10-08',
    title: '语音转文字与文件收发',
    items: [
      '语音消息支持转文字，识别不成功时会说明具体原因',
      '可以发送文件，会话列表直接显示文件名',
      '图片、语音在会话列表里显示中文摘要，不再出现英文标记',
      '多图发送提速，气泡内逐张显示进度并可中途取消',
    ],
  },
  {
    version: '63',
    date: '2026-10-03',
    title: '在线状态与登录安全',
    items: [
      '新增三态在场状态：在线 / 离开 / 不在线，不在线时显示最后活跃时间',
      '可查看对方登录明细，进入需校验暗号',
      '登录页接入隐私遮罩并自绘顶栏，修复一批登录卡住与误报问题',
      '长会话支持分页加载历史消息',
    ],
  },
  {
    version: '62',
    date: '2026-09-30',
    title: '批量诊断与会话删除调整',
    items: [
      '多个地址一次测：批量诊断独立成页，结果可下钻查看全量检测项',
      '批量探测结果支持一键复制，含时间戳与逐项结论',
      '删除会话改为只对自己隐藏，双方都删除才彻底清理记录',
      '未读提示改为头像内的红点，去掉标签栏数字角标',
    ],
  },
  {
    version: '61',
    date: '2026-09-27',
    title: '个人资料与诊断 AI 解读',
    items: [
      '支持设置昵称与头像，头像自动压缩后上传、本地缓存秒开',
      '诊断结论可一键交给 AI 解读，输出照着做的排查步骤',
      '支持修改登录邮箱，并通过邮件验证码找回登录密码',
      '图片上传前先压缩，减少等待与流量',
    ],
  },
  {
    version: '60',
    date: '2026-09-24',
    title: '首个可用版本',
    items: [
      '消息收发：文字 / 图片 / 语音消息，支持撤回与已读回执',
      '网络诊断：DNS、Ping 等多项检测，结果可与历史记录对比',
      '内置 AI 助手页，可上传附件辅助分析',
      '页面闲置 120 秒自动退回诊断页，避免信息留在前台',
    ],
  },
];

/**
 * 当前发布版本号（纯数字，不带 V 前缀）——由 CHANGELOG 顶部条目派生，**不单独维护副本**。
 * 构建期 `config/index.ts` 会把同一个值注入为全局常量 `APP_RELEASE_VERSION`（供 profile 页
 * 「关于」行使用），这里再导出同名常量供 `<ChangelogList>` 等运行时消费，两者永远相等。
 */
export const RELEASE_VERSION: string = CHANGELOG[0]?.version ?? '0';

/**
 * 版本号对外展示格式：统一补大写 `V` 前缀（`64` → `V64`）。
 * ⚠️ 唯一格式化出口——「关于」行与更新日志条目都必须走它，避免两处大小写/前缀不一致。
 * 已带 V/v 前缀的输入会被归一，防止出现 `VV64`。
 */
export function formatVersionLabel(version: string | undefined | null): string {
  const raw = (version ?? '').trim().replace(/^[Vv]/, '');
  return raw ? `V${raw}` : '';
}

/** 版本号归一化：剥掉 V/v 前缀与空白，供比较与排序使用 */
export function normalizeVersion(version: string | undefined | null): string {
  return (version ?? '').trim().replace(/^[Vv]/, '');
}

/**
 * 版本号降幂比较（新 → 旧）。
 *
 * ⚠️ 必须按**数值**比较，不能按字符串：发布号是纯数字但位数会变（'9' vs '73'），
 *   字符串比较会得出 `'73' < '9'` 的错误顺序。非数字版本号（历史遗留的语义化版本）
 *   统一排到数字版本之后，并按字符串降序兜底，保证顺序稳定。
 */
export function compareVersionDesc(a: string, b: string): number {
  const na = Number(normalizeVersion(a));
  const nb = Number(normalizeVersion(b));
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum) return nb - na;
  if (aNum) return -1;
  if (bNum) return 1;
  return normalizeVersion(b).localeCompare(normalizeVersion(a));
}

/**
 * 合并「发布记录」与「更新日志」，产出更新日志列表数据。
 *
 * 规则（缺陷⑮的修复核心 + 缺陷⑰「关于显示 V75、更新日志只到 V74」的修复）：
 * 1. 以 **RELEASES 为骨架**——每一次真实发布都进列表，保证「关于」行的版本号
 *    一定能在列表首条找到对应条目，不会再出现「关于比列表新」的错位；
 * 2. 有改动说明的版本（CHANGELOG 里写了 title/items）挂上说明文案；
 *    只发版、没写说明的版本只显示版本号与日期（渲染层给一句轻量说明）；
 * 3. 日期优先取 RELEASES 里的发布日期（发布记录是日期真源），
 *    RELEASES 未登记的版本回退用 CHANGELOG 自己的日期；
 * 4. 按发布号**降幂**排序（数值比较，见 compareVersionDesc）。
 *
 * ⚠️ 为什么骨架必须是 RELEASES 而不是 CHANGELOG（缺陷⑰的真实根因）：
 *   旧实现以 CHANGELOG 为骨架，只显示「写了说明」的版本。但发版时**很容易忘记**
 *   在 CHANGELOG 顶部追加条目（微信没有读取历史发布记录的接口，文案只能手写），
 *   一旦漏写，新发布号就不在列表里，用户看到「关于显示 V75、更新日志最新 V74」，
 *   反复反馈「版本更新还是没到最新版本」。以 RELEASES 为骨架后，只要发版时补一条
 *   发布记录（比写改动说明容易得多），列表首条就永远与「关于」一致。
 *
 * ⚠️ 日期口径（缺陷⑯，用户明确要求「后继版本日期以代码提交日期为准」）：
 *   微信后台的发布号与发布日期**只存在于微信服务器**，应用内拿不到
 *   （`getAccountInfoSync().miniProgram.version` 只回发布号、不回日期），
 *   所以「某次发布发生在哪一天」在本地无法核实。用户已确认：**后继版本的日期一律以
 *   代码提交日期为准**，界面上**不做「估算」之类的额外标注**——列表里所有日期口径统一，
 *   不再区分「真实发布日」与「代码提交日」。
 *
 * @param releases 发布记录，默认用本文件的 RELEASES
 * @param changelog 更新日志，默认用本文件的 CHANGELOG
 */
export function buildChangelogList(
  releases: { version: string; date: string }[] = RELEASES,
  changelog: ChangelogEntry[] = CHANGELOG,
): ChangelogListItem[] {
  // 发布号 → 改动说明（有说明的版本才在 map 里）
  const notes = new Map<string, ChangelogEntry>();
  for (const c of changelog) {
    const key = normalizeVersion(c.version);
    if (key) notes.set(key, c);
  }
  // 以发布记录为骨架：每个真实发布号都进列表
  const list: ChangelogListItem[] = [];
  const seen = new Set<string>();
  for (const r of releases) {
    const key = normalizeVersion(r.version);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const note = notes.get(key);
    list.push({ version: key, date: r.date, title: note?.title, items: note?.items });
  }
  // 兜底：CHANGELOG 里有、但 RELEASES 漏登记的版本也要显示（否则说明文案会凭空消失）
  for (const c of changelog) {
    const key = normalizeVersion(c.version);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push({ version: key, date: c.date, title: c.title, items: c.items });
  }
  list.sort((a, b) => compareVersionDesc(a.version, b.version));
  // 关键证据日志：列表顺序与条数是排查「跳版本 / 排序不对 / 关于与列表错位」的第一手依据。
  // 正常应看到发布号严格降幂，且首条版本号 == RELEASE_VERSION（=「关于」行的构建版本）。
  const withNotes = list.filter((i) => i.title).length;
  logDbg(
    `[app-release] 🧾 更新日志列表已合并: 共 ${list.length} 条（其中 ${withNotes} 条有改动说明），` +
      `首条 ${formatVersionLabel(list[0]?.version)}，当前版本 ${formatVersionLabel(RELEASE_VERSION)}，` +
      `顺序 ${list.map((i) => formatVersionLabel(i.version)).join(' → ')}`,
  );
  return list;
}

/**
 * 用「关于」行显示的真实版本号补齐更新日志列表顶部。
 *
 * 【为什么必须补（用户连续 3 次反馈的真实根因）】
 *   更新日志列表以**随代码打包的静态 CHANGELOG** 为唯一骨架，而「关于」行的版本号在正式版里
 *   取自微信服务器回包（`getAccountInfoSync().miniProgram.version`）。两者是**两条独立的数据源**：
 *   微信后台每次上传发布都会把发布号 +1，但代码里的 CHANGELOG 只能靠人工在发版时追加条目。
 *   只要有一次发版忘记追加，用户就会看到「关于显示 V77、更新日志只到 V74」的错位——
 *   中间 V75/V76/V77 在代码里根本不存在，展示层再怎么排序也变不出来。
 *
 * 【为什么不能靠「自动同步」根治】
 *   微信**没有提供读取历史发布记录的接口**：`getAccountInfoSync()` 只回当前版本号，
 *   不回历史版本列表、发布日期或改动说明。所以「改动说明文案」永远只能人工编写，
 *   但「列表首条版本号与关于行一致」这件事**可以**在展示层做到——就是本函数。
 *
 * 【补什么】只在真实版本号**高于**列表首条时，于顶部插入一条**占位条目**：
 *   - version = 真实发布号（如 '77'）
 *   - date = 本机今天（东八区）
 *   - 无 title / items（不编造改动说明，只显示版本号与日期）
 *   占位条目由渲染层给一句轻量说明，避免用户以为界面坏了。
 *
 * 【幂等与安全】真实版本号与列表首条相等、或低于首条（开发版回落构建常量、或数据异常）时
 *   **原样返回**，不插入任何条目——保证开发版/体验版与历史数据完全不受影响。
 *
 * @param currentVersion 「关于」行显示的真实版本号（微信回包，可能带 V 前缀或为空）
 * @param list 已合并好的更新日志列表（默认用 buildChangelogList() 的产物）
 * @param today 占位条目的日期，默认取东八区今天（便于测试注入）
 */
export function withCurrentVersionPlaceholder(
  currentVersion: string | undefined | null,
  list: ChangelogListItem[] = buildChangelogList(),
  today: string = todayKeyShanghai(),
): ChangelogListItem[] {
  const cur = normalizeVersion(currentVersion);
  if (!cur) return list;
  const curNum = Number(cur);
  if (!Number.isFinite(curNum)) return list;
  // 列表为空时无从比较，直接补一条占位（否则用户会看到空列表）
  const topNum = list.length > 0 ? Number(normalizeVersion(list[0].version)) : NaN;
  if (Number.isFinite(topNum) && curNum <= topNum) return list;
  // 已存在同版本号条目（数据已补齐）时不重复插入
  if (list.some((i) => normalizeVersion(i.version) === cur)) return list;
  logDbg(
    `[app-release] 🩹 更新日志顶部补齐占位条目: ${formatVersionLabel(cur)}` +
      `（代码内最新为 ${list.length > 0 ? formatVersionLabel(list[0].version) : '无'}，` +
      `微信后台发布号已领先，说明发版时未追加改动说明）`,
  );
  return [{ version: cur, date: today }, ...list];
}

/** 东八区「今天」的 YYYY-MM-DD（与步数卡片同口径，避免设备时区异常导致日期错位） */
function todayKeyShanghai(): string {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.year && map.month && map.day) return `${map.year}-${map.month}-${map.day}`;
  } catch {
    /* 运行时不支持该 timeZone 时回落本地时区 */
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

