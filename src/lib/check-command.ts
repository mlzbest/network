import { logDbg } from './logger';

/**
 * 批量诊断页的隐藏查询命令：`check <用户名> <子命令>`。
 *
 * 【为什么做成隐藏命令】这是给开发者/运维自查用的通道，不是给普通用户的功能，
 * 所以不写进任何引导文案——只有知道格式的人才会用。
 * 与 ping 页的 `6666` / `ai` / `账号+密码` 暗号是同一套思路（见 pages/ping/index.tsx）。
 *
 * 【为什么抽成独立模块】命令的「识别」与「执行」要分开：
 * 识别是纯字符串处理（可单测、无副作用），执行要打网络。混在一起会让
 * batch-probe-panel 的 handleStart 变成一坨。这里只做识别 + 编排，网络全走 api 层。
 */

/** 命令前缀（不区分大小写、忽略首尾空白） */
export const CHECK_PREFIX = 'check';

/**
 * 发送命令前缀：`send <用户名> <消息内容>`，以当前登录用户身份直接给对方发一条消息。
 *
 * 【为什么与 check 并列而不是做成 check 的子命令】两者语义完全不同：
 * check 是**只读查询**（看一眼就走），send 是**写操作**（会真的产生一条消息、
 * 对方会收到）。混进 check 的子命令里，用户敲 `check hong send` 会以为只是查询，
 * 实际却发出去了——写操作必须有自己的动词，不能藏在查询命令下面。
 */
export const SEND_PREFIX = 'send';

/** 已支持的子命令 */
export const CHECK_SUBCOMMANDS = ['message', 'online', 'place', 'stats'] as const;
export type CheckSubcommand = (typeof CHECK_SUBCOMMANDS)[number];

/**
 * 子命令的中文名（供 help 文案与结果标题派生）。
 *
 * 【为什么必须与 CHECK_SUBCOMMANDS 同源】解析白名单、help 文案、结果标题三处都依赖
 * 子命令清单。若各自手写一份中文名，新增子命令时必然漏改其中一处，表现为
 * 「help 里没写」或「结果标题缺中文」。这里用 `Record<CheckSubcommand, string>`
 * 强制穷举：新增子命令时 TS 直接报错，逼着开发者补上中文名。
 *
 * ⚠️ **不要用它渲染下拉框**：check 是彩蛋通道、不对外公布，下拉框只显示英文子命令名。
 *    中文释义只出现在 help（用户主动敲 help 才看得到）与结果标题里。
 */
export const CHECK_SUBCOMMAND_LABELS: Record<CheckSubcommand, string> = {
  online: '在线状态',
  message: '最近消息',
  place: '最后位置',
  stats: '消息统计',
};

/**
 * `stats` 子命令的统计周期。
 *
 * 【为什么是固定档位，而不是让用户填任意天数】
 * 用户要的是「按天、周、月为单位看双方发了多少条」，这是**语义明确的档位**
 * （今天 / 本周 / 本月），不是「最近 N 天」这种连续量。固定档位让结果标题能直接
 * 写成「今天 / 本周 / 本月」，用户一眼知道统计范围；也让解析层只需认几个单词，
 * 不必处理 `7` / `30` 这类数字与 `message` 的条数参数混淆。
 *
 * 【为什么后来又加了 `last7`（最近 7 天）】
 * 前三个档位都是**日历对齐**的（今天 0 点 / 本周一 / 本月 1 号起），月初或周一
 * 当天看「本周 / 本月」几乎等于「今天」，用户想看「最近一周整体情况」时没有档位
 * 可用。`last7` 是**滚动窗口**（含今天在内的 7 个自然日），与日历档位互补。
 * ⚠️ 它仍然只认英文单词 `last7`，不认 `7` / `7d` / `week7`——`7` 会与 message
 *    的条数参数撞车，解析层无法区分「取 7 条」还是「统计 7 天」。
 */
export const CHECK_STATS_PERIODS = ['day', 'week', 'month', 'last7'] as const;
export type CheckStatsPeriod = (typeof CHECK_STATS_PERIODS)[number];

/**
 * 统计周期的中文名（供结果标题与 help 文案派生）。
 *
 * 与 `CHECK_SUBCOMMAND_LABELS` 同理用 `Record<...>` 强制穷举：
 * 新增周期时 TS 直接报错，逼着补中文名，避免标题里出现英文单词。
 */
export const CHECK_STATS_PERIOD_LABELS: Record<CheckStatsPeriod, string> = {
  day: '今天',
  week: '本周',
  month: '本月',
  last7: '最近7天',
};

/**
 * `stats` 未指定周期时的默认档位。
 *
 * 【为什么默认是「最近7天」而不是「今天」】「今天」是日历对齐档位，凌晨或早上跑
 * `check stats` 时区间只有几个小时，几乎必然是「我 0 / TA 0 / 合计 0」——用户会
 * 直接判定「统计坏了」（实测报过「周期内的次数统计应该有点问题」，查库核对后数字
 * 其实全对，只是当天确实还没聊）。`last7` 是滚动 7 天窗口，任何时刻跑都有足够样本，
 * 能立刻看出「最近一周聊了多少、双方谁更活跃」。
 * ⚠️ 只是**默认值**变了：`day` / `week` / `month` 三个档位仍然可用，显式传
 *    `hong day` 依然只看今天。
 */
export const CHECK_STATS_DEFAULT_PERIOD: CheckStatsPeriod = 'last7';

/**
 * 解析统计周期参数。
 *
 * ⚠️ 只认 `CHECK_STATS_PERIODS` 里的英文单词（不区分大小写），不认 `today` / `7d` /
 * `周` 这类变体：命令通道宁可严格，也不能猜意图——猜错会让用户看到「本周」却以为是「今天」。
 */
export function parseStatsPeriod(raw: string): CheckStatsPeriod | null {
  const lower = raw.trim().toLowerCase();
  if (!(CHECK_STATS_PERIODS as readonly string[]).includes(lower)) return null;
  return lower as CheckStatsPeriod;
}

/** 解析结果：命中命令格式时返回用户名与子命令，否则返回 null */
export interface CheckCommand {
  username: string;
  sub: CheckSubcommand;
  /**
   * 可选条数：只有 `message` 子命令支持「用户名 数字」写法时才有值。
   *
   * 【为什么放在解析结果里而不是让执行层再解析一遍】条数是**输入语法的一部分**
   * （`xiao 10` 与 `xiao` 是两种写法），解析层已经切好段了，执行层再切一次
   * 等于把同一份语法规则维护两遍，改一处必漏另一处。
   * 未指定时为 undefined，执行层回落到 `CHECK_MESSAGE_DEFAULT_LIMIT`。
   */
  limit?: number;
  /**
   * 可选统计周期：只有 `stats` 子命令支持「用户名 day/week/month」写法时才有值。
   *
   * 【为什么与 limit 分开两个字段，而不是共用一个「参数」字段】
   * 两者语义完全不同：`limit` 是「取多少条」（message 专用），`period` 是
   * 「统计哪段时间」（stats 专用）。共用一个字段会让执行层必须靠 sub 反推
   * 这个数字/单词该当条数还是当周期，改一处必漏另一处。
   * 未指定时为 undefined，执行层回落到 `CHECK_STATS_DEFAULT_PERIOD`。
   */
  period?: CheckStatsPeriod;
}

/**
 * `message` 子命令的默认返回条数。
 *
 * 【为什么是 5】结果区高度有限，5 条刚好一屏看完；要更多时用户显式写数字
 * （`xiao 10`），不靠默认值猜。
 */
export const CHECK_MESSAGE_DEFAULT_LIMIT = 5;

/**
 * 条数上限。
 *
 * 【为什么必须封顶】条数直接决定一次查询拉多少行、结果区渲染多少行。
 * 不封顶时用户敲 `xiao 99999` 会拉回整段会话历史，既慢又把结果区撑爆。
 * 50 条已足够看清「最近聊了什么」，再多就该去聊天页翻。
 */
export const CHECK_MESSAGE_MAX_LIMIT = 50;

/**
 * 解析可选的条数参数：纯数字、1 ~ CHECK_MESSAGE_MAX_LIMIT。
 *
 * 【为什么只认纯数字】`xiao 10条` / `xiao 十条` 这类写法一律判非法，
 * 让调用方回落到「格式提示」而不是猜用户意图——命令通道宁可严格，
 * 也不能把 `xiao 10` 里的 `10` 误当成消息正文的一部分。
 */
export function parseCheckLimit(raw: string): number | null {
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > CHECK_MESSAGE_MAX_LIMIT) return null;
  return n;
}

/** send 命令支持的消息类型 */
export const SEND_MEDIA_KINDS = ['text', 'image', 'location', 'file', 'voice'] as const;
export type SendMediaKind = (typeof SEND_MEDIA_KINDS)[number];

/**
 * 媒体标记 → 消息类型的映射。
 *
 * 【为什么用 `[图片]` / `[位置]` 这种方括号标记】与项目里已有的消息占位文案同口径
 * （`[图片]`、`[位置]`、`[语音]` 是会话列表与引用摘要里用的同一套标记），用户已经熟悉；
 * 且方括号不会与正常消息正文冲突——真要发「[图片]」这四个字，加个空格或换个说法即可。
 *
 * ⚠️ 必须**全等**匹配（trim 后），不能用 includes：`send hong 我发你一张[图片]看看`
 *    是一句正常的话，不该被当成「发图片」指令。
 *
 * ⚠️ 标记只是**手打入口**（老用户习惯），主入口是批量诊断页的「发送类型」按钮——
 *    点按钮直接拉起相册/文件选择器/录音，不需要用户知道这些方括号语法。
 */
const SEND_MEDIA_MARKERS: Record<string, SendMediaKind> = {
  '[图片]': 'image',
  '[位置]': 'location',
  '[文件]': 'file',
  '[语音]': 'voice',
};

/** 媒体类型的中文名（供结果回显与 help 文案派生，避免两处各写一份） */
export const SEND_MEDIA_LABELS: Record<SendMediaKind, string> = {
  text: '文字',
  image: '图片',
  location: '位置',
  file: '文件',
  voice: '语音',
};

/** send 命令的解析结果：用户名 + 待发送的消息正文 + 消息类型 */
export interface SendCommand {
  username: string;
  /** 文字消息的正文；媒体消息时为空串（内容在发送时才产生） */
  message: string;
  /** 消息类型：缺省视为文字 */
  mediaKind: SendMediaKind;
}

/**
 * 解析发送命令 `send <用户名> <消息内容>`。
 *
 * 【为什么不能照抄 check 的「恰好 N 段」写法】消息正文天然含空格
 * （`send hong 你好 世界` 会被切成 4 段），按段数校验必然把正常消息判成非法。
 * 所以这里只对**前两段**做严格校验，第三段起全部拼回正文：
 *   ① 首段必须是 send（不区分大小写）
 *   ② 第二段必须符合用户名规则
 *   ③ 正文 = 剩余全部内容（用单个空格重新拼接，顺带把连续空白归一化）
 *   ④ 正文若**整体等于** `[图片]` / `[位置]`，则识别为媒体消息
 *
 * ⚠️ 前两段仍必须严格：批量诊断页的主职责是探测域名/IP，宽松匹配会把
 *    `sendmail.com` 这类正常输入误判成命令、导致诊断跑不起来。
 *    首段用**全等**而非 startsWith，正是为了挡住 `sendmail.com`。
 *
 * ⚠️ 正文长度上限 2000：与聊天页输入框同口径，避免超长文本落库后
 *    在消息列表里撑爆渲染。超限返回 null，由调用方给出明确提示。
 */
export function parseSendCommand(raw: string): SendCommand | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [head, username] = parts;
  if (head.toLowerCase() !== SEND_PREFIX) return null;
  if (!USERNAME_RE.test(username)) return null;
  const message = parts.slice(2).join(' ');
  if (message.length === 0 || message.length > 2000) return null;
  // 媒体标记必须整体全等：`我发你一张[图片]看看` 是正常句子，不是发图指令
  const mediaKind = SEND_MEDIA_MARKERS[message];
  if (mediaKind) return { username, message: '', mediaKind };
  return { username, message, mediaKind: 'text' };
}

/**
 * 用户名合法字符集：与登录/注册同口径（见 api/auth.ts 的 USERNAME_RE）。
 * 复用同一套规则而不是另立一套，避免「能注册但查不到」的割裂。
 *
 * ⚠️ 导出给批量诊断页的「发送类型」按钮用：按钮要从输入框首段取收件人用户名，
 *    必须用同一套规则校验，否则会出现「按钮放行、命令解析拒绝」的割裂。
 */
export const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{2,20}$/;

/**
 * 判断输入是否为隐藏命令。
 *
 * 严格按「三段式」解析：`check` + 用户名 + 子命令，用空白分隔。
 * ⚠️ 必须严格：批量诊断页的主职责是探测域名/IP，任何宽松匹配都可能把
 * 正常输入（比如一个叫 `check.com` 的域名）误判成命令、导致诊断跑不起来。
 * 因此要求 ① 恰好三段 ② 首段是 check ③ 用户名符合注册规则 ④ 子命令在白名单内。
 * 四条全中才算命令，否则一律交回原有诊断流程。
 */
export function parseCheckCommand(raw: string): CheckCommand | null {
  const parts = raw.trim().split(/\s+/);
  // 三段（`check 用户名 子命令`）或四段（`check 用户名 message 10` / `check 用户名 stats week`）
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [head, username, sub, argRaw] = parts;
  if (head.toLowerCase() !== CHECK_PREFIX) return null;
  if (!USERNAME_RE.test(username)) return null;
  const lower = sub.toLowerCase();
  if (!(CHECK_SUBCOMMANDS as readonly string[]).includes(lower)) return null;
  const cmd: CheckCommand = { username, sub: lower as CheckSubcommand };
  if (argRaw !== undefined) {
    // 第四段只对 message（条数）与 stats（周期）有意义：
    // `check hong online 10` 是无效写法，不能静默忽略这个参数
    if (lower === 'message') {
      const limit = parseCheckLimit(argRaw);
      if (limit === null) return null;
      cmd.limit = limit;
    } else if (lower === 'stats') {
      const period = parseStatsPeriod(argRaw);
      if (period === null) return null;
      cmd.period = period;
    } else {
      return null;
    }
  }
  return cmd;
}

/**
 * 解析「命令框已选中 send」时的命令参数：`<用户名> <消息内容>`（**不带 send 前缀**）。
 *
 * 【为什么需要它】send 已经由命令框（下拉）承担了「选做什么」这一步，
 * 用户既然已经明确选中了 send，再要求他在输入框里重复敲一遍 `send` 就是冗余——
 * 选中 send 后输入框里只剩「用户名 消息内容」两段，与 check 的
 * `parseCheckArgs` 完全对称。
 *
 * 【与 parseSendCommand 的分工】
 * - 命令框选中 send → 走本函数（两段式，无前缀）
 * - 输入框里整条敲 `send 用户名 消息` → 走 parseSendCommand（三段式，带前缀）
 * 两种写法都认，历史习惯不被打断。
 *
 * 【为什么不能宽松】命令框选中 send 时，输入框里填的也可能是域名
 * （用户切了指令却忘了改输入），宽松匹配会把 `taobao.com` 这类单段输入
 * 误判成命令。故要求 ① 至少两段 ② 首段符合用户名规则 ③ 正文非空且不超长。
 * 注意这里**不能**要求「恰好两段」——消息正文天然含空格
 * （`hong 你好 世界` 是 3 段），第三段起必须拼回正文。
 */
export function parseSendArgs(raw: string): SendCommand | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [username] = parts;
  if (!USERNAME_RE.test(username)) return null;
  const message = parts.slice(1).join(' ');
  if (message.length === 0 || message.length > 2000) return null;
  // 媒体标记必须整体全等：`我发你一张[图片]看看` 是正常句子，不是发图指令
  const mediaKind = SEND_MEDIA_MARKERS[message];
  if (mediaKind) return { username, message: '', mediaKind };
  return { username, message, mediaKind: 'text' };
}

/**
 * 判断输入是否为「命令框已选中 check」时的命令参数：`<用户名> <子命令>`。
 *
 * 【为什么与 parseCheckCommand 并存】`check` 现在由命令框（下拉）承担，
 * 输入框里只剩「用户名 子命令」两段。但历史习惯是整条 `check hong message`
 * 一起敲，所以两种写法都要认：
 * - 输入框里敲完整三段 → 走 parseCheckCommand（前缀自带）
 * - 命令框选中 check、输入框只敲两段 → 走本函数
 *
 * ⚠️ 同样必须严格两段式：命令框选中 check 时，输入框里填的也可能是域名
 * （用户切了指令却忘了改输入），宽松匹配会把 `taobao.com` 这类单段输入
 * 误判成命令。故要求 ① 恰好两段 ② 用户名符合注册规则 ③ 子命令在白名单内。
 */
export function parseCheckArgs(raw: string): CheckCommand | null {
  const parts = raw.trim().split(/\s+/);
  // 两段（`用户名 子命令`）或三段（`用户名 message 10` / `用户名 stats week`）
  if (parts.length !== 2 && parts.length !== 3) return null;
  const [username, sub, argRaw] = parts;
  if (!USERNAME_RE.test(username)) return null;
  const lower = sub.toLowerCase();
  if (!(CHECK_SUBCOMMANDS as readonly string[]).includes(lower)) return null;
  const cmd: CheckCommand = { username, sub: lower as CheckSubcommand };
  if (argRaw !== undefined) {
    // 第三段只对 message（条数）与 stats（周期）有意义
    if (lower === 'message') {
      const limit = parseCheckLimit(argRaw);
      if (limit === null) return null;
      cmd.limit = limit;
    } else if (lower === 'stats') {
      const period = parseStatsPeriod(argRaw);
      if (period === null) return null;
      cmd.period = period;
    } else {
      return null;
    }
  }
  return cmd;
}

/**
 * 解析「命令框选中 check、且子命令已由下拉框选定」时的输入：**只填用户名**。
 *
 * 【为什么需要它】子命令原本要手打在输入框里（`用户名 子命令`），用户必须记住
 * `online` / `message` / `place` 三个英文单词。加了子命令下拉框后，子命令由下拉框
 * 承担，输入框只剩「用户名」一件事——这才是用户要的「我只需要选择命令，然后手动
 * 输入用户名即可」。
 *
 * 【为什么仍然兼容两段式】历史习惯是 `用户名 子命令` 一起敲，且用户可能先敲了
 * 两段再想起来用下拉框。所以调用方先试本函数（单段），失败再回退 `parseCheckArgs`
 * （两段）。两条路径最终都产出同一个 `CheckCommand`。
 *
 * ⚠️ 单段必须严格：命令框选中 check 时，输入框里填的也可能是域名
 * （用户切了指令却忘了改输入），宽松匹配会把 `taobao.com` 误判成用户名。
 * 故要求 ① 恰好一段 ② 符合用户名规则。`taobao.com` 含点号，会被 USERNAME_RE 挡掉。
 *
 * @param raw 输入框原文
 * @param sub 下拉框已选定的子命令
 */
export function parseCheckUsername(raw: string, sub: CheckSubcommand): CheckCommand | null {
  const parts = raw.trim().split(/\s+/);
  // 一段（`用户名`）或两段（`用户名 10` 仅 message / `用户名 week` 仅 stats）
  if (parts.length !== 1 && parts.length !== 2) return null;
  const [username, argRaw] = parts;
  if (!USERNAME_RE.test(username)) return null;
  const cmd: CheckCommand = { username, sub };
  if (argRaw !== undefined) {
    // 第二段只对 message（条数）与 stats（周期）有意义：
    // `hong 10` 在 online/place 下是无效写法
    if (sub === 'message') {
      const limit = parseCheckLimit(argRaw);
      if (limit === null) return null;
      cmd.limit = limit;
    } else if (sub === 'stats') {
      const period = parseStatsPeriod(argRaw);
      if (period === null) return null;
      cmd.period = period;
    } else {
      return null;
    }
  }
  return cmd;
}

/**
 * 结果正文里的一行。
 *
 * 【为什么从 `string[]` 升级成带样式的行对象】
 * `stats` 的结果要按「统计维度」分块（消息 / 上线次数 / 上线位置），每块有块标题、
 * 有「我 vs TA」的对比行、有结论行。若仍用纯字符串，渲染层只能靠「这行有没有冒号」
 * 猜它是什么——块标题和说明行长得一样，对比行和普通字段长得一样，视觉上完全平铺，
 * 用户读不出层次（用户反馈「可读性要强、逻辑性要强」）。
 * 显式带上 `kind` 后，渲染层按语义给样式，不再靠文本形态猜。
 *
 * ⚠️ 复制时仍按纯文本输出（`kind` 只影响渲染，不影响复制内容）。
 */
export type CheckLineKind =
  /** 块标题（如「消息往来」），加粗、上方留白 */
  | 'section'
  /** 普通字段行（`标签：值`），标签列 + 值列 */
  | 'field'
  /** 对比行（`我：12 条` / `TA：8 条`），值列加粗，用于「双方对比」 */
  | 'compare'
  /** 结论行（如「你发得更多」），主色强调 */
  | 'verdict'
  /** 说明 / 限制行，弱化色 */
  | 'note';

export interface CheckLine {
  kind: CheckLineKind;
  text: string;
}

/**
 * 轨迹上的一个定位点（`check stats` 的定位历史原始点）。
 *
 * 【为什么不直接复用 `api/profiles.ts` 的 `LocationHistoryRow`】lib 层不能反向依赖
 * api 层（api 已经 import lib 的 check-command，反向引用会成环）。两者字段一致，
 * 由调用方在边界处做一次 map 即可。
 */
export interface CheckTrackPoint {
  lat: number;
  lng: number;
  recordedAt: string;
}

/** 轨迹数据：双方各自的定位点（按时间升序）+ 对方显示名 + 查询区间 */
export interface CheckTrack {
  mine: CheckTrackPoint[];
  peer: CheckTrackPoint[];
  /**
   * 兜底坐标：周期内没有历史点时，用 `profiles.last_lat/last_lng` 顶上。
   *
   * 【为什么需要】定位历史表是后加的，升级前的定位只写进了 `profiles.last_*`。
   * 没有兜底的话，升级后「查看轨迹」入口永远不出现（用户实测报过「没有看到位置轨迹地图」）。
   * 轨迹页拿到它时渲染「暂无轨迹，仅显示最后位置」，而不是一片空白。
   */
  fallbackMine?: CheckTrackPoint | null;
  fallbackPeer?: CheckTrackPoint | null;
  peerName: string;
  /** 对方 userId（轨迹页要按它重新查库） */
  peerId: string;
  /** 统计区间（轨迹页用同一对区间重查，保证与结果区数据源一致） */
  startIso: string;
  endIso: string;
}

/** 命令执行结果：成功给文本行，失败给一句人话原因（不抛错，页面直接渲染） */
export interface CheckResult {
  ok: boolean;
  /** 结果标题（如「hong 最近 5 条消息」） */
  title: string;
  /**
   * 结果正文行，逐行渲染。
   *
   * 兼容两种形态：纯字符串（老代码直接 push 文本）与 `CheckLine`（带语义样式）。
   * 渲染层统一走 `normalizeCheckLines` 归一化，调用方不必关心自己写的是哪种。
   */
  lines: Array<string | CheckLine>;
  /**
   * 可选坐标：只有 `check place` / `check stats` 查到位置时才有值。
   *
   * 【为什么坐标要单独成字段，而不是让渲染层去 lines 里正则抠】
   * 结果区要基于坐标提供「地图查看」「复制坐标」两个操作，而 `lines` 是**给人看的
   * 展示文本**（含「坐标：」前缀、六位小数、可能被后续文案调整）。让渲染层反解展示
   * 文本去拿数值，等于把「展示格式」变成隐式接口——改一次文案就静默失效。
   * 这里显式带上原始数值，展示与操作各取所需。
   *
   * ⚠️ 可选字段：其它子命令（online / message / help）没有坐标语义，不传即可。
   */
  coords?: { lat: number; lng: number };
  /**
   * 可选轨迹：只有 `check stats` 查到定位历史时才有值。
   *
   * 【为什么轨迹要单独成字段，而不是让轨迹页自己去查】轨迹页确实会重新查一次
   * （URL 传不了几百个点），但结果区需要靠这个字段判断「有没有轨迹可看」来决定
   * 是否渲染「查看轨迹」按钮——没有它就只能靠 lines 文本猜，改文案即失效。
   */
  track?: CheckTrack;
}

/**
 * 把 `lines` 归一化成 `CheckLine[]`。
 *
 * 【为什么归一化放在 lib 而不是渲染层】复制（`handleCopyCheckResult`）与渲染都要
 * 遍历同一份行数据；两处各自判断「这行是字符串还是对象」必然漂移，一处改了另一处
 * 就崩。归一化一次，两边都只处理 `CheckLine`。
 * 纯字符串按「有没有冒号」推断：有冒号当 field，没有当 note——这是老代码的既有语义。
 */
export function normalizeCheckLines(lines: Array<string | CheckLine>): CheckLine[] {
  return lines.map((line) => {
    if (typeof line !== 'string') return line;
    const sep = line.indexOf('：');
    return { kind: sep > 0 && sep <= 6 ? 'field' : 'note', text: line };
  });
}

/** 东八区时间戳格式化：`MM-DD HH:mm`（与项目其它时间展示同口径，避免设备时区错位） */
export function formatCheckTime(iso: string | null | undefined): string {
  if (!iso) return '无记录';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '无记录';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(t));
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    if (map.month && map.day && map.hour && map.minute) {
      return `${map.month}-${map.day} ${map.hour}:${map.minute}`;
    }
  } catch {
    /* 运行时不支持该 timeZone 时回落本地时区 */
  }
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间描述（与 diag-history 的 relTimeLabel 同口径，用于「多久前」） */
export function relTimeFromIso(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 消息内容摘要：非文本类型给占位文案，文本过长截断（命令输出要能一眼扫完） */
export function summarizeMessageContent(contentType: string, content: string): string {
  const MAX = 40;
  const raw = (content || '').replace(/\s+/g, ' ').trim();
  if (contentType === 'image') return '[图片]';
  if (contentType === 'voice') return '[语音]';
  if (contentType === 'file') return `[文件] ${raw}`;
  if (contentType === 'location') return '[位置]';
  if (contentType === 'emoji') return raw || '[表情]';
  if (raw.length === 0) return '(空)';
  return raw.length > MAX ? `${raw.slice(0, MAX)}…` : raw;
}

/** 命令执行过程的统一日志出口（便于在真机日志里核对命令是否被识别） */
export function logCheckCommand(cmd: CheckCommand, phase: string): void {
  const extra = cmd.limit ? ` limit=${cmd.limit}` : cmd.period ? ` period=${cmd.period}` : '';
  logDbg(`[check] 🔎 ${phase}: check ${cmd.username} ${cmd.sub}${extra}`);
}

/**
 * 统计周期的起止时间（ISO 串，左闭右开）。
 *
 * 【为什么必须按东八区切日/周/月，而不是用设备本地时区】
 * 小程序运行在用户手机上，设备时区可能是 UTC 或任意时区。若用 `new Date()` 的
 * 本地方法取「今天 0 点」，同一时刻在不同设备上会算出不同的统计区间，
 * 用户看到的「今天」与对方看到的「今天」不是同一段——统计结果无法对齐。
 * 项目里所有时间展示（formatCheckTime / 微信步数切日）都统一走 Asia/Shanghai，
 * 这里必须同口径。
 *
 * 【为什么用「固定 +8 小时」而不是 Intl 时区换算】
 * 中国全境单一时区、无夏令时，`UTC+8` 是常量。用固定偏移做算术比 Intl 更简单、
 * 且不依赖运行时的时区数据库（部分低版本基础库的 Intl 支持不完整）。
 *
 * 【周从周一算起】与国内习惯一致（周一为一周之始），不是周日。
 *
 * 【`last7` 是滚动窗口，不是日历对齐】起点 = 今天 0 点往前推 6 天，即「含今天在内的
 * 7 个自然日」。它与 `week` 的区别在周一当天最明显：`week` 只有今天一天，`last7`
 * 覆盖过去一周。⚠️ 起点仍按东八区 0 点切，不按「此刻往前 168 小时」——后者会让
 * 区间起点落在某个奇怪的时刻（如 14:37），用户无法理解「最近 7 天」从哪算起。
 *
 * @returns { startIso, endIso } 左闭右开区间；endIso 为「当前时刻」而非区间末尾，
 *          这样「今天」统计的是「今天 0 点到现在」，不会把未来算进去。
 */
export function statsPeriodRange(period: CheckStatsPeriod, now: Date = new Date()): {
  startIso: string;
  endIso: string;
} {
  const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  // 把「当前时刻」平移到东八区墙上时间，用 UTC 方法做日历运算，再平移回去
  const shifted = new Date(now.getTime() + CST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  // 东八区当天 0 点对应的 UTC 时刻
  const dayStartMs = Date.UTC(y, m, d) - CST_OFFSET_MS;
  let startMs = dayStartMs;
  if (period === 'week') {
    // getUTCDay: 0=周日 … 6=周六；换算成「距本周一几天」
    const dow = shifted.getUTCDay();
    const daysFromMonday = (dow + 6) % 7;
    startMs = dayStartMs - daysFromMonday * DAY_MS;
  } else if (period === 'month') {
    startMs = Date.UTC(y, m, 1) - CST_OFFSET_MS;
  } else if (period === 'last7') {
    // 含今天在内的 7 个自然日 → 起点是今天 0 点往前推 6 天
    startMs = dayStartMs - 6 * DAY_MS;
  }
  return { startIso: new Date(startMs).toISOString(), endIso: now.toISOString() };
}
