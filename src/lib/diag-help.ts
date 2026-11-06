import { DIAG_COMMANDS, DIAG_LAYERS, findDiagLayer } from '@/api/net-diagnose';
import {
  CHECK_MESSAGE_DEFAULT_LIMIT,
  CHECK_MESSAGE_MAX_LIMIT,
  CHECK_PREFIX,
  CHECK_STATS_DEFAULT_PERIOD,
  CHECK_STATS_PERIOD_LABELS,
  CHECK_STATS_PERIODS,
  CHECK_SUBCOMMANDS,
  CHECK_SUBCOMMAND_LABELS,
  SEND_PREFIX,
} from './check-command';

/**
 * 批量诊断页的「help」说明文案真源。
 *
 * 【为什么抽成独立模块】说明文案必须与**实际能力**同源，不能手写一份静态清单：
 * 指令清单来自 `DIAG_COMMANDS`（11 条，从 DIAGNOSE_ITEMS 派生）、层级来自 `DIAG_LAYERS`、
 * 子命令来自 `CHECK_SUBCOMMANDS`。手写清单在新增/删除指令后必然漂移，
 * 出现「help 里写了但跑不了」或反之。这里只做「取真源 + 排版」。
 *
 * 【为什么 help 是隐藏命令而不是 UI 按钮】与 check 同属暗号体系：不占 UI、
 * 不写引导文案。但 help 本身是**发现入口**——知道 help 的人就能看到全部能力，
 * 所以它必须把「怎么用」写清楚，而不是只列名字。
 */

/** 一条指令的说明：指令名 + 中文名 + 所属层 + 用法示例 */
interface CommandHelp {
  key: string;
  title: string;
  layer: string;
  usage: string;
}

/**
 * 各指令的用法示例（参数形态）。
 *
 * ⚠️ 这里只写「参数长什么样」，不写指令名——指令名由 DIAG_COMMANDS 提供，
 * 避免两处各写一份指令名导致改名后漏改。
 */
const USAGE_BY_KEY: Record<string, string> = {
  local: '无需参数（本机信息，客户端本地采集）',
  ping: '域名或 IP，如 example.com',
  dns: '域名，如 example.com',
  dnscompare: '域名，如 example.com',
  multiprobe: '域名，如 example.com',
  ports: '域名或 IP，如 example.com',
  route: '域名或 IP，如 example.com',
  arp: '无需参数（局域网邻居表，客户端本地采集）',
  http: '域名或 IP，如 example.com',
  tls: '域名，如 example.com',
  throughput: '域名或 IP，如 example.com',
};

/** 组装指令说明清单（真源：DIAG_COMMANDS + DIAG_LAYERS） */
function buildCommandHelps(): CommandHelp[] {
  return DIAG_COMMANDS.map((c) => {
    const layer = findDiagLayer(c.group);
    return {
      key: c.key,
      title: c.title,
      layer: layer ? layer.label : '未分层',
      usage: USAGE_BY_KEY[c.key] ?? '域名或 IP',
    };
  });
}

/**
 * 各指令的**详解**：这条指令在测什么、结果怎么读、什么时候该用它。
 *
 * ⚠️ 只写「这条指令独有的信息」，指令名/中文名/所属层/参数形态全部从真源取，
 * 不在这里重复——否则改名后必然漏改。
 */
const DETAIL_BY_KEY: Record<string, string[]> = {
  local: [
    '在测什么：采集本机网络环境（设备型号、系统、网络类型、屏幕与像素比）。',
    '结果怎么读：看「网络类型」是否为 wifi；非 wifi 时后续延迟类指标会偏高。',
    '什么时候用：排查任何网络问题前先跑它，确认不是本机环境导致的假象。',
  ],
  ping: [
    '在测什么：从服务端向目标发起 ICMP 探测，测连通性与往返延迟。',
    '结果怎么读：丢包率 0% 且延迟稳定为正常；丢包或延迟抖动大说明链路不稳。',
    '什么时候用：怀疑「打不开/很慢」时第一步就跑它，先确认目标是否可达。',
  ],
  dns: [
    '在测什么：查询目标的 A / AAAA / CNAME 等解析记录。',
    '结果怎么读：有 A 记录说明解析正常；解析为空或超时说明 DNS 有问题。',
    '什么时候用：ping 不通但域名看着没问题时，用它区分「解析问题」还是「链路问题」。',
  ],
  dnscompare: [
    '在测什么：同时向多个公共 DNS 源查询同一域名，比对解析结果是否一致。',
    '结果怎么读：各源结果一致为正常；不一致说明存在 DNS 污染或 CDN 调度差异。',
    '什么时候用：怀疑「部分地区能访问、部分地区不能」时用它定位解析差异。',
  ],
  multiprobe: [
    '在测什么：从多个地理位置的探测节点同时访问目标，对比各地可达性。',
    '结果怎么读：各地都通为正常；个别地区不通说明是区域性网络问题。',
    '什么时候用：用户反馈「只有某地打不开」时用它确认是否区域性问题。',
  ],
  ports: [
    '在测什么：探测目标常用端口（80 / 443 等）的连通性矩阵。',
    '结果怎么读：443 通说明 HTTPS 可用；80 不通但 443 通属正常（很多站点只开 443）。',
    '什么时候用：域名能解析但页面打不开时，用它确认是不是端口被墙或被防火墙拦。',
  ],
  route: [
    '在测什么：近似追踪到目标的路由路径（经过哪些跳）。',
    '结果怎么读：看在哪一跳开始丢包或延迟陡增，那一跳就是瓶颈所在。',
    '什么时候用：延迟高但目标本身正常时，用它定位是哪一段链路慢。',
  ],
  arp: [
    '在测什么：读取本机局域网邻居表（同网段设备的 IP 与 MAC 映射）。',
    '结果怎么读：能看到网关的 MAC 为正常；表为空说明本机不在局域网或权限受限。',
    '什么时候用：怀疑局域网内有 IP 冲突或 ARP 欺骗时用它排查。',
  ],
  http: [
    '在测什么：从服务端发起完整 HTTP 请求，测端到端可用性与响应状态。',
    '结果怎么读：状态码 2xx/3xx 为正常；4xx 是请求问题、5xx 是服务端问题。',
    '什么时候用：ping 通、端口也通但页面仍打不开时，用它确认应用层是否正常。',
  ],
  tls: [
    '在测什么：检查目标的 TLS 证书（颁发者、有效期、是否即将过期）。',
    '结果怎么读：证书有效且剩余天数充足为正常；即将过期或已过期会直接导致打不开。',
    '什么时候用：浏览器提示「证书不受信任」或 HTTPS 握手失败时用它定位。',
  ],
  throughput: [
    '在测什么：从服务端下载一段数据，估算下行吞吐（带宽）。',
    '结果怎么读：数值接近你的实际带宽为正常；远低于带宽说明链路拥塞或限速。',
    '什么时候用：能打开但加载很慢时，用它区分「带宽不足」还是「服务端慢」。',
  ],
};

/**
 * 单条指令的 help：这条指令的专属详解。
 *
 * 【为什么按指令返回而不是给一份大清单】用户敲 help 时已经选好了指令，
 * 想看的就是「这条怎么用、结果怎么读」；给一份 11 条的大清单还要自己找，
 * 反而更慢。总览需求由 `all` 承担（见 buildAllHelp）。
 *
 * @param key 指令名（= 检测项 key）；未知 key 返回一句提示而不是空数组
 */
export function buildCommandHelp(key: string): string[] {
  const cmd = DIAG_COMMANDS.find((c) => c.key === key);
  if (!cmd) {
    return [`未知指令「${key}」。`, '敲 all 查看全部可用指令。'];
  }
  const layer = findDiagLayer(cmd.group);
  const lines: string[] = [
    `【${cmd.key}】${cmd.title}`,
    `所属层级：${layer ? layer.title : '未分层'}`,
    `参数：${USAGE_BY_KEY[cmd.key] ?? '域名或 IP'}`,
    '',
  ];
  const detail = DETAIL_BY_KEY[cmd.key];
  if (detail) {
    lines.push(...detail);
  } else {
    lines.push('（该指令暂无详细说明）');
  }
  lines.push('');
  lines.push('【用法】命令框选中本指令，输入框填参数，点「开始测试」。');
  lines.push('【其它】all — 查看全部指令总览');
  return lines;
}

/**
 * 总览 help（`all`）：全部指令的**一行式**清单，供快速浏览。
 *
 * 【为什么与 buildGeneralHelp 并存】两者定位不同：
 * - `all` → 快速浏览「有哪些指令」，每条只占一行（指令名 + 中文名 + 参数形态），
 *   一屏能扫完，用来找「我该用哪条」。
 * - `help` → 当前选中指令的**详解**（在测什么、结果怎么读、什么时候用）。
 * 所以 `all` 不写详解、不写分层小标题，只做紧凑清单。
 */
export function buildAllHelp(): string[] {
  const lines: string[] = [
    `【全部指令】共 ${DIAG_COMMANDS.length} 条诊断指令 + 1 条隐藏命令，按网络分层由下往上：`,
    '',
  ];
  for (const layer of DIAG_LAYERS) {
    const inLayer = buildCommandHelps().filter((h) => h.layer === layer.label);
    if (inLayer.length === 0) continue;
    lines.push(`${layer.title}`);
    for (const h of inLayer) {
      lines.push(`  ${h.key} — ${h.title}（${h.usage}）`);
    }
  }
  lines.push('');
  lines.push('【隐藏命令】');
  lines.push(`  ${CHECK_PREFIX} — 查询用户信息（命令框选 ${CHECK_PREFIX}，输入框只填用户名）`);
  lines.push(`    子命令：${CHECK_SUBCOMMANDS.join(' / ')}`);
  lines.push('    子命令由下拉框选择，无需手打。');
  lines.push(`  ${SEND_PREFIX} — 给对方发送消息（选中后输入框填「用户名 消息内容」）`);
  lines.push('    ⚠️ 这是写操作：会真的以你的身份发出一条消息，对方能看到。');
  lines.push('    发送前会弹确认卡片；点「发送」按钮可直接发图片 / 位置 / 文件 / 语音。');
  lines.push('');
  lines.push('【其它】');
  lines.push('  help — 查看当前选中指令的详细说明');
  lines.push('  all — 显示这份总览清单');
  return lines;
}

/**
 * check 命令的 help：列出全部子命令格式与详解。
 *
 * 与通用 help 分开：通用 help 面向「诊断指令怎么用」，
 * 这份面向「check 能查什么、结果怎么读、有什么限制」。
 */
export function buildCheckHelp(): string[] {
  const lines: string[] = [
    `【${CHECK_PREFIX} 命令】查询指定用户的账号与消息记录。`,
    '',
    '【格式】三种写法都支持：',
    `  ① 命令框选 ${CHECK_PREFIX} → 子命令下拉框选一项 → 输入框只填用户名（推荐）`,
    `  ② 命令框选 ${CHECK_PREFIX}，输入框填「用户名 子命令」`,
    `  ③ 输入框里整条敲「${CHECK_PREFIX} 用户名 子命令」`,
    '  用户名：2-20 位，支持中英文、数字、下划线，区分大小写。',
    '',
    `【子命令】共 ${CHECK_SUBCOMMANDS.length} 个（下拉框自动列出，新增子命令会自动出现）：`,
    '',
    `  ${CHECK_PREFIX} 用户名 online — ${CHECK_SUBCOMMAND_LABELS.online}`,
    '    返回：最近上线 / 最近活跃 / 最近退出 / 最后活跃',
    '    状态：在线（绿）/ 不在当前（琥珀）/ 离线（灰）/ 已隐藏在线状态',
    '    说明：状态走与详情页一致的解析口径——「不在当前」超过 30 分钟',
    '          会收敛为「离线」；「离线」被心跳保活推翻会回到「在线」。',
    '    限制：无（profiles 表所有人可读）',
    '',
    `  ${CHECK_PREFIX} 用户名 message — ${CHECK_SUBCOMMAND_LABELS.message}`,
    '    返回：时间 + 发送方（我 / TA）+ 内容摘要（图片/语音/文件等给占位）',
    `    条数：默认 ${CHECK_MESSAGE_DEFAULT_LIMIT} 条；在用户名后加数字可指定，`,
    `          如「xiao 10」= xiao 的最近 10 条（1 ~ ${CHECK_MESSAGE_MAX_LIMIT} 条）。`,
    '    限制：⚠️ 受权限约束，只能看到「你与 TA 之间」的消息，',
    '          TA 与其他人的记录无法读取（会被静默过滤成空）。',
    '',
    `  ${CHECK_PREFIX} 用户名 place — ${CHECK_SUBCOMMAND_LABELS.place}`,
    '    返回：地点名 / 详细地址 / 经纬度 / 记录时间',
    '    说明：取 TA 发出的**最后一条位置消息**（不是实时定位，是历史记录）。',
    '    限制：⚠️ 同样只能看到「你与 TA 之间」的位置，',
    '          TA 发给其他人的位置无法读取。',
    '',
    `  ${CHECK_PREFIX} 用户名 stats — ${CHECK_SUBCOMMAND_LABELS.stats}`,
    '    返回：统计区间 / 统计周期，然后按三个维度分块，每块都是「我 vs TA」对比：',
    '          ① 消息往来：各自条数 + 占比 + 合计 + 谁发得更多',
    '          ② 上线次数：各自次数 + 最近上线时刻 + 谁上线更多',
    '          ③ 上线位置：各自坐标 + 定位次数 + 不同位置数 + 首次/最后时刻',
    `    周期：${CHECK_STATS_PERIODS.map((p) => `${p}（${CHECK_STATS_PERIOD_LABELS[p]}）`).join(' / ')}，`,
    `          在用户名后加周期词可指定，如「xiao week」= 本周（默认 ${CHECK_STATS_DEFAULT_PERIOD} = ${CHECK_STATS_PERIOD_LABELS[CHECK_STATS_DEFAULT_PERIOD]}）。`,
    '          默认用滚动 7 天而不是「今天」：凌晨/早上跑「今天」几乎必然是 0 条，容易误判成统计坏了。',
    '    口径：按东八区切日 / 周 / 月，周从周一起算；区间终点是「此刻」，',
    '          所以「今天」统计的是今天 0 点到现在。',
    '          last7 = 含今天在内的 7 个自然日（滚动窗口，不是日历周）。',
    '    位置：取该周期内**最后一次**自动定位（来自定位历史表），所以切周期能看到变化；',
    '          周期内无记录时回落到「最后一次自动定位」并明确标注（该坐标可能早于周期起点）。',
    '          定位历史从本次更新后才开始积累，之前的定位没有留存，所以早期周期次数会是 0。',
    '          位置由双方进入详情页时自动上报，仅微信真机可用（H5 预览端不产生记录）。',
    '    地点：结果区「地点对比」可在地图上对比双方该周期内去过的地点（按约 100 米合并），',
    '          双方用不同颜色区分、重合地点单独标出，并给出「我 / TA」各自的地点清单；',
    '          仅微信真机可渲染地图，H5 预览端降级为地点清单。',
    '    限制：⚠️ 消息只统计「你与 TA 之间」，TA 与其他人的消息无法读取；',
    '          已撤回的消息仍计入（它确实被发出过）。',
    '          上线次数与位置不受此限制（login_events / 定位历史所有人可读）。',
    '    复制：结果区右下角「复制结果」可一键复制整块文本。',
    '',
    '【其它】',
    `  ${CHECK_PREFIX} help — 显示这份说明`,
    '  help — 显示全部指令说明',
  ];
  return lines;
}

/**
 * send 命令的 help：说明格式、写操作性质与限制。
 *
 * 【为什么必须单独有一份，而不是塞进 check 的说明里】
 * send 是**写操作**——会真的以当前用户身份发出一条消息、对方能看到。
 * 把它混在 check（只读查询）的说明里，用户会以为它也是「看一眼就走」，
 * 从而在没想清楚的情况下把消息发出去。写操作必须有自己的说明入口，
 * 且必须把「这是真的会发出去」写在最显眼的位置。
 */
export function buildSendHelp(): string[] {
  const lines: string[] = [
    `【${SEND_PREFIX} 命令】以你的身份，直接给指定用户发送一条消息。`,
    '',
    '⚠️ 这是写操作：消息会真的写入你与 TA 之间，对方在详情页能看到。',
    '   发送前会弹出确认卡片，确认后才真正发出；发送后只能手动撤回。',
    '',
    '【格式】',
    '  在命令框选中 send 后，输入框里填：用户名 消息内容',
    `  （也可以整条敲：${SEND_PREFIX} 用户名 消息内容）`,
    '  用户名：2-20 位，支持中英文、数字、下划线，区分大小写。',
    '  消息内容：不能为空，最多 2000 字，**可以包含空格**。',
    '',
    '【发送图片 / 位置 / 文件 / 语音】两种方式：',
    '  ① 点「发送」按钮（推荐）：先在输入框填收件人用户名，再点对应按钮，',
    '     会直接拉起相册 / 文件选择器 / 录音界面，不需要记任何语法。',
    '  ② 手打标记：把消息内容整体写成下面的标记即可：',
    '     用户名 [图片] — 拉起相册选一张图，压缩上传后发出',
    '     用户名 [位置] — 取当前定位，作为位置消息发出',
    '     用户名 [文件] — 从记录或本地选一个文件，上传后发出',
    '     用户名 [语音] — 拉起录音界面，录完上传后发出',
    '  ⚠️ 标记必须**整体等于**方括号内容，不能夹在句子里：',
    '     `hong 我发你一张[图片]看看` 会被当成普通文字消息发出。',
    '  ⚠️ 位置与录音仅在微信小程序中可用，预览环境会提示不可用。',
    '',
    '【示例】',
    '  hong 你好，在吗',
    '  xiao 明天下午三点老地方见',
    '  hong [图片]',
    '  hong [位置]',
    '  hong [文件]',
    '  hong [语音]',
    '',
    '【行为说明】',
    '  · 发送前会弹确认卡片，显示收件人、类型与内容，可随时取消。',
    '  · 取消不会产生任何消息，也不会建立记录。',
    '  · 若你与 TA 还没有记录，确认后会自动建立一条（不会重复建）。',
    '  · 若你曾删除过与 TA 的记录，会自动恢复并发送。',
    '  · 不能给自己发送。',
    '  · 发送结果会回显收件人、消息类型、内容与发送时间，便于核对。',
    '',
    '【其它】',
    `  ${SEND_PREFIX} help — 显示这份说明`,
    '  help — 显示全部指令说明',
  ];
  return lines;
}

/**
 * 判断输入框内容是否为 help / all 请求。
 *
 * 只认单段严格匹配（避免把域名误判成命令）：
 * - `help` → 当前选中指令的详解
 * - `all`  → 全部指令的总览清单
 *
 * ⚠️ 不再认 `check help` 这类带前缀写法：`check` 已由命令框承担，
 * 选中 check 时敲 help 自然就是 check 的说明，无需再带前缀。
 *
 * @returns 'help' | 'all' | null
 */
export function parseHelpRequest(raw: string): 'help' | 'all' | null {
  const parts = raw.trim().toLowerCase().split(/\s+/);
  if (parts.length !== 1) return null;
  if (parts[0] === 'help') return 'help';
  if (parts[0] === 'all') return 'all';
  return null;
}
