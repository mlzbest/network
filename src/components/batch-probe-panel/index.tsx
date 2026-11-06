import { View, Text, Input, Picker, ScrollView, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import type { DiagnoseResult, ItemStatus, ServerItemKey } from '@/api/net-diagnose';
import {
  DIAG_COMMANDS,
  DIAG_LAYERS,
  normalizeTarget,
  runSingleItem,
} from '@/api/net-diagnose';
import LayerProbePanel from '@/components/layer-probe-panel';
import {
  fetchProfilesByIds,
  fetchProfileByUsername,
  countPeerLoginsBetween,
  listLocationHistoryBetween,
  pickLastLocation,
  summarizeLocationHistory,
} from '@/api/profiles';
import { getLastLocationMessageBySender, countMessagesBetween, listRecentMessagesBySender, sendMessage } from '@/api/messages';
import { getOrCreateConversation, updateLastMessage } from '@/api/conversations';
import { useAuthStore } from '@/store/auth-store';
import { useProfilesStore } from '@/store/profiles-store';
import {
  decodeLocation,
  encodeLocation,
  getCurrentLocation,
  locationSubtitle,
  locationTitle,
  openLocationOnMap,
} from '@/lib/location-message';
import { compressImageFilesBatch, selectMediaFiles, selectMessageFile, uploadToSupabase } from '@/lib/upload';
import { formatFileSize, uploadChatFile } from '@/lib/file-message';
import { supabaseUrl } from '@/supabase/client';
import {
  formatPresenceLabel,
  formatPresenceSince,
  presenceDotColor,
  resolvePresence,
  type ResolvedPresence,
} from '@/lib/presence';
import {
  CHECK_MESSAGE_DEFAULT_LIMIT,
  CHECK_MESSAGE_MAX_LIMIT,
  CHECK_PREFIX,
  CHECK_STATS_DEFAULT_PERIOD,
  CHECK_STATS_PERIOD_LABELS,
  CHECK_STATS_PERIODS,
  CHECK_SUBCOMMANDS,
  SEND_MEDIA_KINDS,
  SEND_MEDIA_LABELS,
  SEND_PREFIX,
  USERNAME_RE,
  formatCheckTime,
  logCheckCommand,
  normalizeCheckLines,
  parseCheckArgs,
  parseCheckCommand,
  parseCheckUsername,
  parseSendArgs,
  parseSendCommand,
  relTimeFromIso,
  statsPeriodRange,
  summarizeMessageContent,
  type CheckLine,
  type CheckResult,
  type CheckStatsPeriod,
  type CheckSubcommand,
  type SendMediaKind,
} from '@/lib/check-command';
import { buildAllHelp, buildCheckHelp, buildCommandHelp, buildSendHelp, parseHelpRequest } from '@/lib/diag-help';
import { logDbg } from '@/lib/logger';

interface Props {
  /** 初始填入输入框的内容（如主输入框已有的单个地址） */
  initialText?: string;
  /** 点击某一行「全量诊断」：把该目标交回页面执行完整分层诊断 */
  onDeepDiagnose: (target: string) => void;
  /** 是否渲染面板自带的卡片外壳与「批量诊断」标题。
   * 独立页面（pages/batch-diag）由页面自己提供导航与标题，传 false 只保留内容区。 */
  withCardShell?: boolean;
}

/**
 * 命令框的可选项：11 条诊断指令 + 末尾的隐藏命令 `check`。
 *
 * 【为什么 check 也放进命令框】它原本是「整条敲在输入框里」的暗号，
 * 但输入框的主职责是填域名/IP，混着敲容易和域名混淆。放进命令框后：
 * 命令框负责「选做什么」，输入框只负责「填参数」——选 check 时输入框填
 * 「用户名 子命令」，选 ping 时填「域名/IP」。语义更干净，也更好记。
 * ⚠️ 它仍然不写进任何引导文案，只有知道的人才会去下拉里找。
 */
const COMMAND_LABELS = [...DIAG_COMMANDS.map((c) => c.key), CHECK_PREFIX, SEND_PREFIX];

/** check 在命令框里的下标（= 诊断指令条数，因为它是倒数第二个） */
const CHECK_INDEX = DIAG_COMMANDS.length;

/** send 在命令框里的下标（最后一项） */
const SEND_INDEX = DIAG_COMMANDS.length + 1;

/**
 * check 子命令下拉框的可选项文案。
 *
 * 【为什么从 CHECK_SUBCOMMANDS 派生而不是手写数组】用户明确要求「后继如果增加子命令
 * 也自动添加进去」。手写数组在新增子命令时必然漏改，表现为「下拉里选不到新子命令」。
 * 这里直接 map 真源元组，新增子命令只需改 `check-command.ts` 一处，
 * 下拉框、解析白名单、help 文案三处自动同步。
 *
 * ⚠️ 只显示英文子命令名，**不带中文释义**：check 是彩蛋通道，不对外公布，
 *    下拉框里出现「在线状态 / 最近消息 / 最后位置」等于把功能用途直接写在界面上。
 *    中文释义仍保留在 `CHECK_SUBCOMMAND_LABELS`，只供 help 文案与结果标题使用。
 * ⚠️ 顺序即 CHECK_SUBCOMMANDS 的声明顺序（message / online / place），
 *    不在这里重排——重排会让「下拉第 N 项」与「白名单第 N 项」错位。
 */
const CHECK_SUB_LABELS = [...CHECK_SUBCOMMANDS];

/**
 * send 命令发文件时的扩展名白名单。
 *
 * 【为什么与聊天页 handleSelectFile 保持同一份】两处若不一致，会出现
 * 「聊天页能选的文件、命令通道选不了」这种割裂。这里刻意复制同一份清单
 * 而不是从聊天页 import——聊天页是页面组件，从组件里导出常量会让
 * 组件与工具模块产生反向依赖。
 */
const SEND_FILE_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'png', 'jpg', 'jpeg'];

/**
 * 媒体类型 → 方括号标记的反查表（供「发送类型」按钮填输入框用）。
 *
 * 【为什么在这里再写一份，而不是从 check-command.ts 导出】`SEND_MEDIA_MARKERS`
 * 是「标记 → 类型」的正查表，模块内私有；这里需要的是反查（类型 → 标记）。
 * 与其把私有表导出、让两个方向共用一份可变对象，不如在这里显式列出——
 * 类型只有 4 个，且 `SEND_MEDIA_KINDS` 是 as const 元组，漏写会被 TS 报错兜住。
 */
const SEND_MEDIA_MARKER_BY_KIND: Partial<Record<SendMediaKind, string>> = {
  image: '[图片]',
  location: '[位置]',
  file: '[文件]',
  voice: '[语音]',
};

/** 当前是否选中了隐藏命令 check */
function isCheckSelected(index: number): boolean {
  return index === CHECK_INDEX;
}

/** 当前是否选中了隐藏命令 send */
function isSendSelected(index: number): boolean {
  return index === SEND_INDEX;
}

/**
 * send 命令的待确认状态：确认卡片渲染所需的最小信息集。
 *
 * 【为什么把「已准备好的发送载荷」也放进来】确认卡片弹出时，图片已经选好并上传完、
 * 位置已经取到坐标——这些准备工作不该在用户点确认后重做一遍（重做意味着重新选图、
 * 重新定位，用户会看到「确认了却又弹一次相册」）。所以准备阶段的结果直接挂在
 * 这个 state 上，确认时直接取用。
 */
interface SendConfirmState {
  /** 收件人展示名（昵称优先，回退用户名） */
  who: string;
  /** 收件人 user id */
  peerId: string;
  /** 消息类型 */
  mediaKind: SendMediaKind;
  /** 文字消息的正文；媒体消息为空串 */
  message: string;
  /** 图片消息：已上传的公开 URL */
  mediaUrl?: string;
  /** 文件消息：原始文件名（落库进 content，展示与下载都以它为准） */
  fileName?: string;
  /** 文件消息：人类可读体积（仅用于卡片展示，不参与发送） */
  fileSize?: string;
  /** 语音消息：时长串（如 `[12s]`，落库进 content，会话列表摘要靠它显示时长） */
  voiceDuration?: string;
  /** 语音消息：时长秒数（仅用于卡片展示） */
  voiceSeconds?: number;
  /** 位置消息：已编码好的 content 串 */
  locationContent?: string;
  /** 位置消息：坐标（仅用于卡片上展示，不参与发送） */
  locationCoords?: { lat: number; lng: number };
  /** 弹出卡片时的代次令牌值：确认/取消时校验，避免旧卡片影响新一轮流程 */
  run: number;
}

function statusColor(s: ItemStatus | 'waiting'): string {
  if (s === 'fail') return '#dc2626';
  if (s === 'warn') return '#d97706';
  if (s === 'pass') return '#16a34a';
  return '#64748b';
}

const STATUS_TEXT: Record<ItemStatus | 'waiting', string> = {
  pass: '正常',
  warn: '告警',
  fail: '异常',
  na: '不适用',
  pending: '检测中',
  unsupported: '不支持',
  waiting: '排队中',
};

/**
 * 批量诊断面板：选一条指令（ping / dns / ports…）+ 填一个域名/IP，单步跑这一项。
 * 同一份实现被两处复用：ping 页折叠区（withCardShell 默认 true）与独立批量诊断页。
 *
 * 【为什么不再有批量输入框】原设计是「一次填多个地址、轮流跑 DNS+Ping」，
 * 但实际排查时更需要的是「针对一个目标，单独跑某一步看结果」——批量那套
 * 既看不到单项明细，也无法定位是哪一层出的问题。故改为「指令 + 目标」单步模式。
 */
export default function BatchProbePanel({ initialText = '', onDeepDiagnose, withCardShell = true }: Props) {
  // 指令下拉选中的下标（对应 DIAG_COMMANDS）
  const [cmdIndex, setCmdIndex] = useState(0);
  /**
   * check 子命令下拉框选中的下标（对应 CHECK_SUBCOMMANDS）。
   *
   * 【为什么用下标而不是子命令字符串】Taro 的 Picker `mode="selector"` 只回
   * `e.detail.value`（下标），用下标存可以省掉一次「下标 → 字符串」的反查；
   * 且 `CHECK_SUBCOMMANDS` 是 as const 元组，下标越界会被 TS 兜住。
   *
   * 【为什么默认 0（= message）】与 CHECK_SUBCOMMANDS 声明顺序一致，
   * 用户切到 check 时下拉框显示的就是第一项，不会出现「空选中」。
   */
  const [checkSubIndex, setCheckSubIndex] = useState(0);
  // 目标输入框内容（原始输入，提交时才归一化）
  const [target, setTarget] = useState(initialText);
  // 已跑出的结果与在跑状态
  const [result, setResult] = useState<DiagnoseResult | undefined>(undefined);
  const [pending, setPending] = useState(false);
  // 剪贴板 API 被拒时的降级通道：页面内可选中文本弹层（与 ping 页结论复制同款兜底）
  const [copyFallbackText, setCopyFallbackText] = useState('');
  // 隐藏命令（check <用户名> <子命令>）的结果：非空时在结果区顶部渲染一块命令输出。
  // 与单步结果分开存：命令不是「诊断指令」，混在一起会让状态色/标题全部失真。
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);
  const [checkRunning, setCheckRunning] = useState(false);
  // online 子命令解析出的在场状态：非 null 时在命令结果区底部渲染一个带色圆点 + 中文状态。
  // 与 checkResult.lines 分开存：lines 是纯文本（可长按复制），状态需要单独上色，
  // 混进 lines 就只能是一行无色文字，达不到「和聊天页圆点配色一致」的要求。
  const [checkState, setCheckState] = useState<ResolvedPresence>(null);
  // send 命令的发送前确认卡片：非 null 时渲染浮层，等用户点「确认发送」或「取消」。
  //
  // 【为什么必须有一道确认】send 是**写操作**——消息会真的落库、对方能看到、
  // 发出去后只能在聊天页手动撤回。命令框里敲完回车就直接发出去，误发代价太高。
  // 确认卡片把「发给谁 + 发什么类型 + 内容预览」摆出来，让用户有机会反悔。
  //
  // 【为什么用自定义浮层而不是 Taro.showModal】showModal 的 content 是纯文本、
  // 无法换行排版，按钮文案也受限。确认卡片要展示「收件人 / 类型 / 内容」三段
  // 结构化信息，自定义浮层更清楚（样式照抄本文件已有的复制降级弹层）。
  const [sendConfirm, setSendConfirm] = useState<SendConfirmState | null>(null);
  // sendConfirm 的 ref 镜像：runSendCommand 的 finally 里要判断「是否已弹出确认卡片」，
  // 但 finally 执行时闭包里的 sendConfirm 还是旧值（setState 是异步的），
  // 读 state 会永远拿到 null、导致 checkRunning 被错误置 false。ref 是同步的，能拿到真值。
  const sendConfirmRef = useRef<SendConfirmState | null>(null);
  // 代次令牌：与 ping 页 handleStop 同思路，Taro.request 不可取消、只丢弃回包
  const runIdRef = useRef(0);

  // ===== 录音（send 命令发语音用）=====
  // 【为什么录音状态放在组件里而不是抽成独立组件】录音与 send 的三段式流程强耦合：
  // 录完要接着走「上传 → 弹确认卡片」，中间要校验代次令牌。抽成独立组件后，
  // 这些上下文得靠一堆 props 传进去，反而更难维护。
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recorderRef = useRef<Taro.RecorderManager | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 本次录音的真实容器格式：onStop 会用微信实际回包的文件名校正它
  // （部分安卓机型会忽略 start 请求的 m4a、实际回 mp3）
  const recordFormatRef = useRef<'wav' | 'm4a' | 'mp3'>('wav');
  // 本机已判定不可用的格式档位：onError 降档后写这里，下次直接从更低档起步
  const formatTierRef = useRef(0);
  // 录音完成后的续跑上下文：onStop 回调靠它接着走「上传 → 弹确认卡片」
  const voiceCtxRef = useRef<{ run: number; username: string; who: string; peerId: string } | null>(null);

  /**
   * 录音器初始化：注册 onStop / onError 回调。
   *
   * 【为什么依赖数组必须为空】`Taro.getRecorderManager()` 返回的是**全局单例**，
   * 每次调用 `onStop` / `onError` 都是**追加**回调而不是覆盖。若依赖数组非空、
   * 每次渲染都注册一遍，用户录一次音会触发 N 次上传（N = 渲染次数）。
   * 所以这里只在挂载时注册一次，回调内部通过 ref 读取最新状态。
   *
   * 【为什么回调里读 ref 而不是闭包变量】回调只注册一次，闭包捕获的是首次渲染的
   * state（永远是初始值）。所有需要「最新值」的数据都必须走 ref。
   */
  useEffect(() => {
    if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) return;
    const mgr = Taro.getRecorderManager();
    recorderRef.current = mgr;

    mgr.onStop((res: any) => {
      setIsRecording(false);
      setRecordingSeconds(0);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);

      // ⚠️ 极短录音或录音被系统打断时，onStop 回包 tempFilePath 可能是空串。
      // 不校验就丢给上传函数 → readFile fail → 用户只看到一句「发送失败」。
      const rawPath = typeof res?.tempFilePath === 'string' ? res.tempFilePath : '';
      logDbg(`[batch] 🎙️ 录音结束: path=${rawPath || '(空)'} duration=${res?.duration ?? '?'}ms`);
      if (!rawPath) {
        logDbg('[batch] 🎙️ onStop 未返回音频路径，终止发送');
        voiceCtxRef.current = null;
        Taro.showToast({ title: '没录到声音，请重新录制', icon: 'none' });
        return;
      }
      void finishVoiceRecord(rawPath, res?.duration ?? 0);
    });

    mgr.onError((err: any) => {
      const errMsg = String(err?.errMsg || err?.message || err || '');
      logDbg(`[batch] 🎙️ 录音错误: ${errMsg}`);
      setIsRecording(false);
      setRecordingSeconds(0);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      voiceCtxRef.current = null;

      // 机型兼容：部分基础库不支持当前请求的编码（start 不抛异常、只在录音阶段报
      // invalid format）。按 wav → m4a → mp3 逐级降档，用户重新点「语音」即可。
      const TIERS: Array<'wav' | 'm4a' | 'mp3'> = ['wav', 'm4a', 'mp3'];
      const curIdx = TIERS.indexOf(recordFormatRef.current);
      if (/format|codec|m4a|wav/i.test(errMsg) && curIdx >= 0 && curIdx < TIERS.length - 1) {
        formatTierRef.current = curIdx + 1;
        logDbg(`[batch] 🎙️ 本机不支持 ${recordFormatRef.current}，后续改用 ${TIERS[curIdx + 1]}`);
        Taro.showToast({ title: '本机型不支持该音频格式，已切换，请重新录制', icon: 'none', duration: 2500 });
        return;
      }
      Taro.showToast({ title: '录音失败，请检查麦克风权限', icon: 'none' });
    });

    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  const handleStop = () => {
    runIdRef.current += 1;
    setPending(false);
    setCheckRunning(false);
    Taro.showToast({ title: '已停止', icon: 'none' });
  };

  /**
   * 单步测试：只跑选中的那一条指令。
   *
   * 与隐藏命令结果互斥（清空 checkResult），避免两套结果混在一屏。
   */
  const runCommand = async (key: ServerItemKey, host: string, force = false) => {
    const myRun = ++runIdRef.current;
    setCheckResult(null);
    setResult(undefined);
    setPending(true);
    logDbg(`[batch] 🧪 单步测试 ${key} → ${host}${force ? '（强制重测）' : ''}`);

    try {
      const r = await runSingleItem(host, key, force);
      if (runIdRef.current !== myRun) return; // 已被新一轮取代或已中止
      setResult(r);
    } finally {
      if (runIdRef.current === myRun) setPending(false);
    }
  };

  /**
   * 单步测试入口：校验域名/IP 后跑选中指令。
   * 输入框允许粘贴完整 URL，这里统一走 normalizeTarget 归一化。
   */
  const handleRun = async () => {
    const cmd = DIAG_COMMANDS[cmdIndex];
    if (!cmd) return;
    const host = normalizeTarget(target);
    if (!host) {
      Taro.showToast({ title: '请输入有效的域名或 IP', icon: 'none' });
      return;
    }
    await runCommand(cmd.key, host);
  };

  /** 重试：强制绕过 60s 缓存重跑当前指令 */
  const handleRetry = async () => {
    const cmd = DIAG_COMMANDS[cmdIndex];
    if (!cmd) return;
    const host = normalizeTarget(target);
    if (!host) return;
    await runCommand(cmd.key, host, true);
  };

  /**
   * 执行隐藏命令 `check <用户名> <子命令>`。
   *
   * 设计要点：
   * - 结果一律写进 checkResult（含「用户不存在」这类失败），**不弹 toast**——
   *   命令通道的语义是「把结果打在结果区」，弹窗会打断且看不到细节。
   * - 与单步测试互斥：跑命令前清空 result，避免两套结果混在一起。
   * - 代次令牌复用 runIdRef：命令执行期间用户若点了「开始测试」，回包必须丢弃。
   */
  const runCheckCommand = async (
    username: string,
    sub: CheckSubcommand,
    limit?: number,
    period?: CheckStatsPeriod,
  ) => {
    const myRun = ++runIdRef.current;
    setResult(undefined);
    setCheckResult(null);
    setCheckState(null);
    setCheckRunning(true);
    const me = useAuthStore.getState().user?.id ?? '';
    // 条数只对 message 有意义；其它子命令即使传了也忽略，避免标题里出现无意义的「最近 N 条」
    const msgLimit = limit ?? CHECK_MESSAGE_DEFAULT_LIMIT;
    // 周期只对 stats 有意义；未指定时回落到默认档位（`last7` 最近7天，见 check-command 的说明）
    const statsPeriod = period ?? CHECK_STATS_DEFAULT_PERIOD;
    logCheckCommand({ username, sub, limit, period }, '开始执行');

    try {
      const profile = await fetchProfileByUsername(username);
      if (runIdRef.current !== myRun) return;
      if (!profile) {
        setCheckResult({
          ok: false,
          title: `check ${username} ${sub}`,
          lines: [`未找到用户「${username}」。`, '用户名区分大小写，请确认拼写与注册时一致。'],
        });
        return;
      }

      if (sub === 'online') {
        // 「最近一次上线」取 last_login_at：它在每次真实登录/恢复会话时都会刷新，
        // 是「上线」语义最贴切的字段。last_active_at 是 45 秒心跳（只说明进程还活着），
        // last_logout_at 只在主动退出时写（切后台/杀进程不写，会长期停在旧值）。
        const loginAt = profile.last_login_at;
        // ⚠️ 当前状态必须走 resolvePresence 解析，不能直出 presence_state 原值：
        // 库里存的是 online/away/offline 三个英文枚举，且**原始值不等于真实状态**——
        // away 超过 30 分钟要收敛成「离线」、offline 被心跳保活推翻要回到「在线」、
        // 对方开了隐藏要短路成「已隐藏在线状态」。这些判定全在 resolvePresence 里，
        // 直出原值会让命令结果与聊天页/会话列表页显示不一致（用户报过）。
        // 解析口径与聊天页完全一致：传 presence_state / presence_at / last_active_at / hide_presence。
        const resolved = resolvePresence(
          profile.presence_state,
          profile.presence_at,
          profile.last_active_at,
          profile.hide_presence,
        );
        const stateLabel = formatPresenceLabel(resolved);
        // 「最后活跃」走 formatPresenceSince（与聊天页/会话列表页同一口径）：
        // 它跨四个痕迹取最新值，比单看 last_active_at 更准（心跳可能没刷上）。
        // 顺序与聊天页保持一致：[presence_at, last_logout_at, last_active_at, last_login_at]。
        const sinceText = formatPresenceSince(resolved, [
          profile.presence_at,
          profile.last_logout_at,
          profile.last_active_at,
          loginAt,
        ]);
        // ⚠️ 这里**不再**输出「当前状态：xxx」这一行：状态已经以「色点 + 彩色文字」
        // 显示在标题右侧，再在正文里重复一遍纯文字版，既冗余又会让用户以为
        // 标题旁和正文里是两个不同的状态。正文只留时间明细。
        const lines: string[] = [
          `最近上线：${formatCheckTime(loginAt)}${relTimeFromIso(loginAt) ? `（${relTimeFromIso(loginAt)}）` : ''}`,
          `最近活跃：${formatCheckTime(profile.last_active_at)}`,
          `最近退出：${formatCheckTime(profile.last_logout_at)}`,
        ];
        // 非在线两档补一行「最后活跃」绝对时刻（在线/隐藏态该函数返回空串，不占行）
        if (sinceText) lines.push(sinceText);
        // 用户主动隐藏在线状态时如实标注，避免把「隐藏」误读成「离线」
        if (profile.hide_presence) lines.push('（该用户已开启「隐藏在线状态」）');
        logDbg(
          `[batch] 📋 check online 结果: state=${resolved ?? 'null'} label=${stateLabel || '未知'} since=${sinceText || '无'} lines=${lines.length}`,
        );
        setCheckState(resolved);
        setCheckResult({ ok: true, title: `${profile.nickname || profile.username || username} 的上线记录`, lines });
        return;
      }

      // sub === 'place'
      if (sub === 'place') {
        const who = profile.nickname || profile.username || username;
        // ① 首选：TA **最后一次自动定位**的坐标（profiles.last_lat/last_lng/last_location_at）。
        //    这是用户要的语义——「每次进聊天详情页自动获取的位置」，不是 TA 主动发出去的位置。
        //    写入点在 chat 页 autoFetchCurrentLocation（进页面时 getCurrentLocation 成功后上报）。
        //    ⚠️ 它只在**微信真机**上才会被写入：H5 预览端 getCurrentLocation 直接返回 null。
        const lat = profile.last_lat;
        const lng = profile.last_lng;
        const at = profile.last_location_at;
        if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
          const lines: string[] = [
            `坐标：${lat.toFixed(6)}, ${lng.toFixed(6)}`,
            `记录时间：${formatCheckTime(at)}${relTimeFromIso(at) ? `（${relTimeFromIso(at)}）` : ''}`,
            '',
            '（TA 最后一次进入详情页时自动定位到的位置，非实时）',
          ];
          logDbg(`[batch] 📍 check place 结果(自动定位): (${lat}, ${lng}) at=${at ?? 'null'}`);
          setCheckResult({ ok: true, title: `${who} 的最后位置`, lines, coords: { lat, lng } });
          return;
        }

        // ② 降级：云端没有自动定位记录（TA 从未在真机进过聊天页 / 未授权定位），
        //    退回「TA 发过的最后一条位置消息」。能力边界由 messages 的 SELECT RLS 决定：
        //    只能看到当前用户参与的会话，TA 发给第三方的位置查不到（静默过滤成空数组，不报错）。
        const hit = await getLastLocationMessageBySender(profile.id, me);
        if (runIdRef.current !== myRun) return;
        if (!hit) {
          setCheckResult({
            ok: true,
            title: `${who} 的最后位置`,
            lines: [
              '没有查到位置记录。',
              '可能原因：TA 从未在微信真机上进入过详情页（自动定位未上报），',
              '也没有给你发过位置消息。',
              '注意：位置消息受权限限制，只能看到「你与 TA 之间」的；',
              'TA 发给其他人的位置无法读取。',
            ],
          });
          return;
        }
        // content 是位置消息的 JSON（{lat,lng,name,address}），必须走 decodeLocation 解析，
        // 绝不能把原始 JSON 直接渲染出来。解析失败（脏数据）时如实说明，不编造坐标。
        const loc = decodeLocation(hit.content);
        if (!loc) {
          setCheckResult({
            ok: false,
            title: `${who} 的最后位置`,
            lines: [
              `记录时间：${formatCheckTime(hit.createdAt)}`,
              '位置数据已损坏，无法解析出坐标。',
            ],
          });
          return;
        }
        const lines: string[] = [
          `地点：${locationTitle(loc)}`,
          `地址：${locationSubtitle(loc)}`,
          `坐标：${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}`,
          `记录时间：${formatCheckTime(hit.createdAt)}${relTimeFromIso(hit.createdAt) ? `（${relTimeFromIso(hit.createdAt)}）` : ''}`,
          '',
          '（云端无自动定位记录，此处为 TA 发过的最后一条位置消息）',
        ];
        logDbg(
          `[batch] 📍 check place 结果(位置消息降级): ${loc.name || '(无名)'} (${loc.lat}, ${loc.lng}) at=${hit.createdAt}`,
        );
        setCheckResult({
          ok: true,
          title: `${who} 的最后位置`,
          lines,
          coords: { lat: loc.lat, lng: loc.lng },
        });
        return;
      }

      // sub === 'stats'
      if (sub === 'stats') {
        const who = profile.nickname || profile.username || username;
        const periodLabel = CHECK_STATS_PERIOD_LABELS[statsPeriod];
        // 区间按东八区切日/周/月/最近7天（见 statsPeriodRange 的说明），终点是「此刻」
        const { startIso, endIso } = statsPeriodRange(statsPeriod);
        // 消息条数、双方上线次数、双方定位历史互不依赖，全部并行发。
        // ⚠️ 每一路都单独 catch 降级成 null：任何一路失败只让对应块显示「查询失败」，
        //    不能让整块结果失败——用户敲一次命令，能拿到几块是几块。
        const [stats, myLogins, peerLogins, myLocRows, peerLocRows] = await Promise.all([
          countMessagesBetween(profile.id, me, startIso, endIso),
          countPeerLoginsBetween(me, startIso, endIso).catch((err) => {
            logDbg('[batch] 我的上线统计失败(降级):', err?.message || err);
            return null;
          }),
          countPeerLoginsBetween(profile.id, startIso, endIso).catch((err) => {
            logDbg('[batch] TA 的上线统计失败(降级):', err?.message || err);
            return null;
          }),
          listLocationHistoryBetween(me, startIso, endIso).catch((err) => {
            logDbg('[batch] 我的定位历史失败(降级):', err?.message || err);
            return null;
          }),
          listLocationHistoryBetween(profile.id, startIso, endIso).catch((err) => {
            logDbg('[batch] TA 的定位历史失败(降级):', err?.message || err);
            return null;
          }),
        ]);
        if (runIdRef.current !== myRun) return;

        /**
         * 结果结构：**先给统计区间，再按三个维度分块，每块都是「我 vs TA」的对比**。
         *
         * 【为什么必须分块 + 每块都做对比，而不是平铺一串字段】
         * 用户要的是「可读性强、逻辑性强」。平铺时「我发出 12 条 / TA 发出 8 条 /
         * 上线 3 次 / 位置 xx」混在一起，读者得自己把「我」和「TA」的数字配对、
         * 自己判断谁多谁少。分块后每块只回答一个问题（聊了多少 / 谁更常上线 /
         * 各自在哪），块内固定「我 → TA → 结论」三行，读者视线不用来回跳。
         *
         * 【为什么结论行必须由数据算出，而不是固定文案】
         * 「你发得更多」这类判断是这块的**唯一结论**，写死会让数字与结论矛盾。
         * 每块都按同一套规则产出：相等 → 持平；一方为 0 → 只有另一方有记录；
         * 否则 → 谁多。三块口径一致，读者能横向比较。
         */
        const pct = (n: number) => (stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);
        const lines: CheckLine[] = [
          { kind: 'field', text: `统计区间：${formatCheckTime(startIso)} ~ ${formatCheckTime(endIso)}` },
          { kind: 'field', text: `统计周期：${periodLabel}` },
        ];

        // ① 消息往来
        lines.push({ kind: 'section', text: '消息往来' });
        lines.push({ kind: 'compare', text: `我：${stats.mine} 条（${pct(stats.mine)}%）` });
        lines.push({ kind: 'compare', text: `TA：${stats.peer} 条（${pct(stats.peer)}%）` });
        lines.push({ kind: 'field', text: `合计：${stats.total} 条` });
        if (stats.total === 0) {
          lines.push({ kind: 'verdict', text: `${periodLabel}你们还没有互发消息` });
        } else if (stats.mine === stats.peer) {
          lines.push({ kind: 'verdict', text: '双方条数持平' });
        } else {
          const diff = Math.abs(stats.mine - stats.peer);
          lines.push({
            kind: 'verdict',
            text: `${stats.mine > stats.peer ? '你' : 'TA'}发得更多，多 ${diff} 条`,
          });
        }

        // ② 上线次数（login_events 所有人可读，不受会话限制；「我」与「TA」同口径）
        lines.push({ kind: 'section', text: '上线次数' });
        if (myLogins) {
          lines.push({ kind: 'compare', text: `我：${myLogins.count} 次` });
          lines.push({
            kind: 'field',
            text: `最近上线：${myLogins.lastLoggedAt ? formatCheckTime(myLogins.lastLoggedAt) : '该周期内无记录'}`,
          });
        } else {
          lines.push({ kind: 'compare', text: '我：查询失败' });
        }
        if (peerLogins) {
          lines.push({ kind: 'compare', text: `TA：${peerLogins.count} 次` });
          lines.push({
            kind: 'field',
            text: `最近上线：${peerLogins.lastLoggedAt ? formatCheckTime(peerLogins.lastLoggedAt) : '该周期内无记录'}`,
          });
        } else {
          lines.push({ kind: 'compare', text: 'TA：查询失败' });
        }
        if (!myLogins || !peerLogins) {
          lines.push({ kind: 'verdict', text: '上线次数对比不可用（部分数据查询失败）' });
        } else if (myLogins.count === 0 && peerLogins.count === 0) {
          lines.push({ kind: 'verdict', text: `${periodLabel}双方都没有上线记录` });
        } else if (myLogins.count === peerLogins.count) {
          lines.push({ kind: 'verdict', text: '双方上线次数持平' });
        } else {
          const diff = Math.abs(myLogins.count - peerLogins.count);
          lines.push({
            kind: 'verdict',
            text: `${myLogins.count > peerLogins.count ? '你' : 'TA'}上线更多，多 ${diff} 次`,
          });
        }

        // ③ 上线位置（定位历史表，按周期取「该周期内最后一次」）
        // ⚠️ 与 `check place` 的区别：place 读 profiles.last_*（永远是最新一份，不随周期变），
        //    这里读 user_location_history（按区间过滤），所以切周期能看到位置变化。
        // ⚠️ 周期内无记录时降级到 profiles.last_*，并明确标注「该周期内无定位记录」——
        //    否则用户明明知道对方有位置，却看到「无记录」，会以为功能坏了。
        lines.push({ kind: 'section', text: '上线位置' });
        const myLoc = myLocRows ? summarizeLocationHistory(myLocRows) : null;
        const peerLoc = peerLocRows ? summarizeLocationHistory(peerLocRows) : null;
        // ⚠️ 「我」的回落坐标必须现查一次 profiles，不能读 `useProfilesStore.byId[me]`：
        //    那个 store 只缓存**对方**的资料（会话列表/聊天页按 peerId 拉取），
        //    自己的资料行通常不在里面 → 永远拿到 null → 位置块显示「我：无记录」，
        //    而同一时刻 profiles.last_lat 其实是有值的（用户实测报过「自己这方没记录」）。
        //    查询失败降级成 null（位置是附属信息，不该让整块结果失败）。
        const myProfile = await fetchProfilesByIds([me])
          .then((rows) => rows[0] ?? null)
          .catch((err) => {
            logDbg('[batch] 我的资料查询失败(位置回落降级):', err?.message || err);
            return null;
          });
        if (runIdRef.current !== myRun) return;
        const myFallback = pickLastLocation(myProfile);
        const peerFallback = pickLastLocation(profile);
        logDbg(
          `[batch] 📍 位置回落源: 我=${myFallback ? `${myFallback.lat.toFixed(6)},${myFallback.lng.toFixed(6)}` : '无'} TA=${peerFallback ? `${peerFallback.lat.toFixed(6)},${peerFallback.lng.toFixed(6)}` : '无'}`,
        );

        /**
         * 渲染一侧的位置三行（坐标 / 定位次数 / 首次与最后）。
         *
         * ⚠️ 坐标必须标清「哪一份」：周期内有历史记录时是「该周期最后一次」，
         * 回落时是「最后一次自动定位」（可能早于周期起点）。不标的话用户会拿
         * 一个周期外的旧坐标当成本周期位置，直接得出「统计不准」的结论。
         */
        const pushLocationSide = (label: string, summary: typeof myLoc, fallback: typeof myFallback) => {
          if (summary === null) {
            lines.push({ kind: 'compare', text: `${label}：查询失败` });
            return;
          }
          if (summary.count > 0 && summary.last) {
            lines.push({
              kind: 'compare',
              text: `${label}：${summary.last.lat.toFixed(6)}, ${summary.last.lng.toFixed(6)}（${periodLabel}最后一次）`,
            });
            lines.push({
              kind: 'field',
              text: `定位次数：${summary.count} 次（${summary.distinctCount} 个不同位置）`,
            });
            lines.push({
              kind: 'field',
              text: `首次：${formatCheckTime(summary.first?.recordedAt)}　最后：${formatCheckTime(summary.last.recordedAt)}`,
            });
            return;
          }
          if (fallback) {
            lines.push({
              kind: 'compare',
              text: `${label}：${fallback.lat.toFixed(6)}, ${fallback.lng.toFixed(6)}（最后一次自动定位）`,
            });
            lines.push({ kind: 'field', text: `定位次数：${periodLabel}无记录` });
            lines.push({ kind: 'field', text: `定位时间：${formatCheckTime(fallback.at)}` });
            return;
          }
          lines.push({ kind: 'compare', text: `${label}：无记录` });
        };

        pushLocationSide('我', myLoc, myFallback);
        pushLocationSide('TA', peerLoc, peerFallback);

        // 位置结论：只在双方都有本周期记录时比较「换没换地方」，否则只陈述可确定的事实
        if (myLoc && peerLoc && myLoc.count > 0 && peerLoc.count > 0) {
          const myMoved = myLoc.distinctCount > 1;
          const peerMoved = peerLoc.distinctCount > 1;
          if (!myMoved && !peerMoved) {
            lines.push({ kind: 'verdict', text: '双方都在同一片区域活动' });
          } else if (myMoved && peerMoved) {
            lines.push({
              kind: 'verdict',
              text: `双方都换过地方（你 ${myLoc.distinctCount} 处，TA ${peerLoc.distinctCount} 处）`,
            });
          } else {
            const mover = myMoved ? '你' : 'TA';
            const n = myMoved ? myLoc.distinctCount : peerLoc.distinctCount;
            lines.push({ kind: 'verdict', text: `${mover}换过 ${n} 处位置，另一方一直在同一片区域` });
          }
        } else if (myLoc === null || peerLoc === null) {
          lines.push({ kind: 'verdict', text: '位置对比不可用（部分数据查询失败）' });
        } else {
          lines.push({ kind: 'verdict', text: `${periodLabel}至少一方没有定位记录` });
        }

        // 定位历史是本次新增的表，上线前没有任何数据；不说明的话用户会把
        // 「周期内 0 次」当成「统计坏了」。只在确实没有历史记录时提示，避免刷屏。
        const noHistory = (myLoc?.count ?? 0) === 0 && (peerLoc?.count ?? 0) === 0;
        if (noHistory) {
          logDbg(
            `[batch] 📍 定位历史为空(我=${myLoc?.count ?? '失败'} TA=${peerLoc?.count ?? '失败'})，位置块走 profiles.last_* 回落`,
          );
          lines.push({
            kind: 'note',
            text: '定位历史从本次更新后开始积累，之前的定位没有留存，所以周期内次数为 0',
          });
        }

        lines.push({ kind: 'note', text: '消息仅统计你与 TA 之间；上线次数与位置不受此限制' });
        lines.push({ kind: 'note', text: '位置由双方进入详情页时自动上报，仅微信真机可用' });
        // 地点对比入口条件：至少一方有定位点，**或者**有 profiles.last_* 回落坐标
        // （此时页面显示「仅最后位置」）。
        //
        // ⚠️ 早期只判「历史点 ≥ 2」，而定位历史表是后加的、存量数据全在 profiles.last_* 里，
        //    于是升级后用户永远看不到入口按钮（实测报过「没有看到位置轨迹地图」）。
        //    有回落坐标就放行，让用户至少能在地图上看到「最后位置」，而不是入口直接消失。
        const trackPointCount = (myLocRows?.length ?? 0) + (peerLocRows?.length ?? 0);
        const hasFallbackCoord = Boolean(myFallback || peerFallback);
        const canOpenTrack = trackPointCount >= 1 || hasFallbackCoord;
        if (canOpenTrack) {
          lines.push({
            kind: 'note',
            text: '点「地点对比」可在地图上对比双方这段时间去过的地点',
          });
        }
        logDbg(
          `[batch] 📊 check stats 结果: period=${statsPeriod} 我=${stats.mine} TA=${stats.peer} 合计=${stats.total} 上线=${myLogins?.count ?? '失败'}/${peerLogins?.count ?? '失败'} 定位=${myLoc?.count ?? '失败'}/${peerLoc?.count ?? '失败'} 定位点=${trackPointCount} 地点入口=${canOpenTrack ? '显示' : '隐藏'}(回落坐标=${hasFallbackCoord ? '有' : '无'})`,
        );
        setCheckResult({
          ok: true,
          title: `${who} ${periodLabel}统计`,
          lines,
          // 地图按钮语义不变：看「对方在哪」，所以坐标取 TA 的（周期内最后一次，无则回落最新）
          coords: peerLoc?.last
            ? { lat: peerLoc.last.lat, lng: peerLoc.last.lng }
            : peerFallback
              ? { lat: peerFallback.lat, lng: peerFallback.lng }
              : undefined,
          // 地点：原始点直接带出来（结果区据此决定是否显示「地点对比」按钮）；
          // 地点页会用同一对 startIso/endIso 重新查库，不依赖这里传的点。
          // ⚠️ fallbackMine / fallbackPeer 是「历史点不足时的兜底坐标」：定位历史表是后加的，
          //    存量数据只在 profiles.last_* 里。不带兜底的话，升级后地点入口永远不出现
          //    （用户实测报过「没有看到位置轨迹地图」）。
          track: {
            mine: (myLocRows ?? []).map((r) => ({ lat: r.lat, lng: r.lng, recordedAt: r.recordedAt })),
            peer: (peerLocRows ?? []).map((r) => ({ lat: r.lat, lng: r.lng, recordedAt: r.recordedAt })),
            fallbackMine: myFallback
              ? { lat: myFallback.lat, lng: myFallback.lng, recordedAt: myFallback.at ?? '' }
              : null,
            fallbackPeer: peerFallback
              ? { lat: peerFallback.lat, lng: peerFallback.lng, recordedAt: peerFallback.at ?? '' }
              : null,
            peerName: who,
            peerId: profile.id,
            startIso,
            endIso,
          },
        });
        return;
      }

      // sub === 'message'
      const msgs = await listRecentMessagesBySender(profile.id, me, msgLimit);
      if (runIdRef.current !== myRun) return;
      if (msgs.length === 0) {
        setCheckResult({
          ok: true,
          title: `${profile.nickname || profile.username || username} 最近 ${msgLimit} 条消息`,
          lines: [
            '没有查到消息。',
            '注意：受权限限制，这里只能看到「你与 TA 之间」的消息；',
            'TA 与其他人的记录无法读取。',
          ],
        });
        return;
      }
      const lines = msgs.map((m, i) => {
        const who = m.sender_id === me ? '我' : 'TA';
        return `${i + 1}. [${formatCheckTime(m.created_at)}] ${who}：${summarizeMessageContent(m.content_type, m.content)}`;
      });
      lines.push('', '（仅含你与 TA 之间，按时间倒序）');
      setCheckResult({ ok: true, title: `${profile.nickname || profile.username || username} 最近 ${msgs.length} 条消息`, lines });
    } catch (e: any) {
      if (runIdRef.current !== myRun) return;
      logDbg('[batch] 命令执行异常:', e?.message || e);
      setCheckResult({
        ok: false,
        title: `check ${username} ${sub}`,
        lines: [`执行失败：${e?.message || '未知错误'}`],
      });
    } finally {
      if (runIdRef.current === myRun) setCheckRunning(false);
    }
  };

  /**
   * 执行发送命令 `send <用户名> <消息内容>`：以当前登录用户身份直接给对方发一条消息。
   *
   * 【为什么这是写操作，必须比 check 更谨慎】
   * check 只读，出错最多是「没查到」；send 会**真的产生一条消息并推送给对方**，
   * 发出去就收不回来。因此这里比 check 多三道闸门：
   *   ① 发送前先确认「当前登录态已就绪」——冷启动过渡态没有 access token，
   *      此时发消息会被 RLS 挡掉，用户会看到一条莫名其妙的失败。
   *   ② 不允许给自己发（自己和自己没有会话语义，getOrCreateConversation 会
   *      建出一条 user1_id === user2_id 的畸形会话）。
   *   ③ **发送前弹确认卡片**，把「发给谁 + 什么类型 + 内容」摆出来让用户反悔。
   *
   * 【为什么结果里要回显消息正文】写操作必须让用户确认「到底发出去了什么」。
   * 只回一句「发送成功」，用户无法判断是不是把内容截断了、空格丢了。
   *
   * 【为什么走 getOrCreateConversation 而不是直接 insert messages】
   * messages 表只认 conversation_id，没有会话就没有落点。getOrCreateConversation
   * 还顺带处理了「复用旧会话 + 清除双方删除标记」——否则给一个曾经删过会话的人
   * 发消息会新建出第二条并行会话，双方列表里出现两个同名会话。
   *
   * 【三段式：准备 → 确认 → 执行】
   * 准备阶段（查资料、选图上传、取定位）不产生任何消息；确认阶段等用户点按钮；
   * 执行阶段才建会话 + 发消息。这样用户取消时数据库里不会留下空会话。
   *
   * 结果一律写进 checkResult（含失败），**不弹 toast**——与 check 同口径，
   * 命令通道的语义是「把结果打在结果区」。
   */
  const runSendCommand = async (username: string, message: string, mediaKind: SendMediaKind) => {
    const myRun = ++runIdRef.current;
    setResult(undefined);
    setCheckResult(null);
    setCheckState(null);
    setSendConfirm(null);
    setCheckRunning(true);
    logDbg(`[batch] ✉️ 识别为发送命令: send ${username} 类型=${mediaKind}`);

    try {
      // 闸门①：真实登录态未就绪时直接拒绝，不发请求。
      // 过渡态（bootstrapped）的 user 是本地缓存拼的、没有 token，发出去必被 RLS 挡。
      const me = useAuthStore.getState().user?.id ?? '';
      if (!me) {
        setCheckResult({
          ok: false,
          title: `send ${username}`,
          lines: ['当前未登录，无法发送消息。', '请先登录后再试。'],
        });
        return;
      }

      const profile = await fetchProfileByUsername(username);
      if (runIdRef.current !== myRun) return;
      if (!profile) {
        setCheckResult({
          ok: false,
          title: `send ${username}`,
          lines: [`未找到用户「${username}」。`, '用户名区分大小写，请确认拼写与注册时一致。'],
        });
        return;
      }

      // 闸门②：不允许给自己发。自己和自己没有会话语义，
      // 放行会建出一条 user1_id === user2_id 的畸形会话行。
      if (profile.id === me) {
        setCheckResult({
          ok: false,
          title: `send ${username}`,
          lines: ['不能给自己发送消息。', '请把用户名换成对方的账号。'],
        });
        return;
      }

      const who = profile.nickname || profile.username || username;

      // ===== 准备阶段：按类型把「要发的东西」准备好，但一条消息都不发 =====
      let mediaUrl: string | undefined;
      let fileName: string | undefined;
      let fileSize: string | undefined;
      let locationContent: string | undefined;
      let locationCoords: { lat: number; lng: number } | undefined;

      if (mediaKind === 'image') {
        // 选图 → 压缩 → 上传。三步都可能失败，分别给出可区分的提示。
        // ⚠️ 用户取消选图返回空数组，这是**预期内结果**，静默返回不报错。
        const picked = await selectMediaFiles({ count: 1, mediaType: ['image'] });
        if (runIdRef.current !== myRun) return;
        if (picked.length === 0) {
          logDbg('[batch] ✉️ 用户取消选图，静默返回');
          setCheckResult({
            ok: true,
            title: `send ${username}`,
            lines: ['已取消选择图片，未发送任何消息。'],
          });
          return;
        }

        // 压缩：走批量版而非单张版——小程序端批量版一次导航压完整批，
        // 单张版每张图各拉起一轮 canvas 宿主页，多图时会被微信连续导航限制拒绝。
        let toUpload = picked[0];
        try {
          const compressed = await compressImageFilesBatch(picked, { maxSide: 1280, quality: 0.82 });
          if (runIdRef.current !== myRun) return;
          if (compressed[0]) toUpload = compressed[0];
        } catch (e: any) {
          // 压缩失败不阻断：compressImageFilesBatch 内部已按「回退原图」处理，
          // 这里只记日志，继续用原图上传。
          logDbg('[batch] ✉️ 图片压缩异常，回退原图上传:', e?.message || e);
        }

        const up = await uploadToSupabase(toUpload, { bucket: 'chat-media' });
        if (runIdRef.current !== myRun) return;
        if (!up.success || !up.data?.path) {
          logDbg('[batch] ✉️ 图片上传失败:', up.error);
          setCheckResult({
            ok: false,
            title: `send ${username}`,
            lines: [`图片上传失败：${up.error || '未知错误'}`, '请检查网络后重试。'],
          });
          return;
        }
        mediaUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${up.data.path}`;
        logDbg('[batch] ✉️ 图片已上传:', mediaUrl.slice(0, 80));
      } else if (mediaKind === 'file') {
        // 选文件 → 上传。链路与聊天页发文件完全一致（selectMessageFile + uploadChatFile），
        // 保证对方看到的渲染结果相同。
        // ⚠️ 用户取消返回 null（不是空数组），这是**预期内结果**，静默返回不报错。
        // ⚠️ 扩展名白名单与聊天页 handleSelectFile 保持同一份，避免「聊天页能选、命令发不了」。
        const picked = await selectMessageFile({ count: 1, type: 'file', extension: SEND_FILE_EXTS });
        if (runIdRef.current !== myRun) return;
        if (!picked) {
          logDbg('[batch] ✉️ 用户取消选文件，静默返回');
          setCheckResult({
            ok: true,
            title: `send ${username}`,
            lines: ['已取消选择文件，未发送任何消息。'],
          });
          return;
        }

        // 文件名以选择器返回的 name 为准（uploadChatFile 内部按它取扩展名生成存储路径）。
        // name 缺失时兜底一个带扩展名的名字，否则下游 fileExtOf 取不到扩展名、
        // 存储路径会没有后缀，对方点开时 openDocument 无法识别格式。
        const pickedName = (picked as { name?: string }).name || `文件-${Date.now()}`;
        try {
          const up = await uploadChatFile(picked, pickedName);
          if (runIdRef.current !== myRun) return;
          mediaUrl = up.url;
          fileName = pickedName;
          fileSize = formatFileSize(up.size);
          logDbg(`[batch] ✉️ 文件已上传: ${pickedName} ${fileSize} ${up.url.slice(0, 80)}`);
        } catch (e: any) {
          if (runIdRef.current !== myRun) return;
          logDbg('[batch] ✉️ 文件上传失败:', e?.message || e);
          setCheckResult({
            ok: false,
            title: `send ${username}`,
            lines: [`文件上传失败：${e?.message || '未知错误'}`, '请检查网络后重试。'],
          });
          return;
        }
      } else if (mediaKind === 'voice') {
        // 录音：拉起录音浮层，等用户录完再继续。
        // ⚠️ 这里**不能 await**：录音是「用户交互驱动」的，onStop 回调在用户点停止时才触发。
        //    用 Promise 包住等回调会让 runSendCommand 挂起，而用户可能永远不点停止。
        //    正确做法：启动录音后直接 return，由 onStop 回调接着走「上传 → 弹确认卡片」。
        // ⚠️ 代次令牌必须传下去：录音期间用户可能点「停止」或发起新一轮命令，
        //    回调里要校验 runIdRef.current === myRun 才能继续。
        startVoiceRecord(myRun, username, who, profile.id);
        return;
      } else if (mediaKind === 'location') {
        // 取当前定位。⚠️ H5 预览端 getCurrentLocation 直接返回 null，
        // 必须给出明确提示，不能静默失败让用户以为功能坏了。
        const loc = await getCurrentLocation();
        if (runIdRef.current !== myRun) return;
        if (!loc) {
          logDbg('[batch] ✉️ 取定位失败（H5 环境或未授权）');
          setCheckResult({
            ok: false,
            title: `send ${username}`,
            lines: [
              '拿不到当前位置，无法发送位置消息。',
              '可能原因：',
              '  · 当前在预览环境（位置能力仅在微信小程序中可用）',
              '  · 未授权位置权限，或系统定位已关闭',
            ],
          });
          return;
        }
        locationContent = encodeLocation(loc);
        locationCoords = { lat: loc.lat, lng: loc.lng };
        logDbg(`[batch] ✉️ 已取到定位: (${loc.lat}, ${loc.lng})`);
      }

      if (runIdRef.current !== myRun) return;

      // ===== 确认阶段：把准备好的内容摆出来，等用户点按钮 =====
      // 卡片只存「已准备好的载荷」，用户点确认后直接取用，不重做选图/定位
      // （重做会让用户看到「确认了却又弹一次相册」）。
      setSendConfirm({
        who,
        peerId: profile.id,
        mediaKind,
        message,
        mediaUrl,
        fileName,
        fileSize,
        locationContent,
        locationCoords,
        run: myRun,
      });
      sendConfirmRef.current = {
        who,
        peerId: profile.id,
        mediaKind,
        message,
        mediaUrl,
        fileName,
        fileSize,
        locationContent,
        locationCoords,
        run: myRun,
      };
      setCheckRunning(false);
      logDbg(`[batch] ✉️ 已弹出确认卡片 → ${who} 类型=${mediaKind}`);
    } catch (e: any) {
      if (runIdRef.current !== myRun) return;
      logDbg('[batch] ✉️ send 准备阶段失败:', e?.message || e);
      setCheckResult({
        ok: false,
        title: `send ${username}`,
        lines: [`发送失败：${e?.message || '未知错误'}`],
      });
    } finally {
      // ⚠️ 只在「没有弹出确认卡片」时收尾：弹了卡片说明流程还没结束，
      //    此时把 checkRunning 置 false 会让「停止」按钮提前变回「开始测试」，
      //    用户以为流程结束了，实际还在等确认。
      if (runIdRef.current === myRun && !sendConfirmRef.current) setCheckRunning(false);
    }
  };

  /**
   * 确认卡片点「确认发送」：真正建会话 + 发消息。
   *
   * 【为什么建会话放在这一步而不是准备阶段】用户取消时不该在数据库里留下空会话。
   * 会话是「发送」这个动作的产物，不是「准备发送」的产物。
   */
  const confirmSend = async () => {
    const draft = sendConfirm;
    if (!draft) return;
    // 代次校验：卡片弹出后用户可能点了「停止」或发起了新一轮命令，
    // 此时这张卡片已经作废，点确认必须丢弃而不是照发。
    if (runIdRef.current !== draft.run) {
      logDbg('[batch] ✉️ 确认卡片已过期（代次不匹配），丢弃本次发送');
      setSendConfirm(null);
      sendConfirmRef.current = null;
      return;
    }

    setSendConfirm(null);
    setCheckRunning(true);
    const myRun = draft.run;
    sendConfirmRef.current = null;
    const me = useAuthStore.getState().user?.id ?? '';
    if (!me) {
      setCheckResult({
        ok: false,
        title: `send ${draft.who}`,
        lines: ['当前未登录，无法发送消息。'],
      });
      setCheckRunning(false);
      return;
    }

    try {
      // 先拿/建会话，再发消息。两步都可能失败，分别给出可区分的提示，
      // 否则用户看到「发送失败」无法判断是会话问题还是消息问题。
      let conversationId = '';
      try {
        const conv = await getOrCreateConversation(me, draft.peerId);
        conversationId = conv.id;
      } catch (e: any) {
        if (runIdRef.current !== myRun) return;
        logDbg('[batch] ✉️ 获取/创建会话失败:', e?.message || e);
        setCheckResult({
          ok: false,
          title: `send ${draft.who}`,
          lines: [`与 ${draft.who} 的会话建立失败：${e?.message || '未知错误'}`],
        });
        return;
      }
      if (runIdRef.current !== myRun) return;

      // 按类型传不同的 content / contentType / mediaUrl：
      //   · 文字：content = 正文，无 mediaUrl
      //   · 图片：content = '[图片]' 占位，mediaUrl = 公开 URL
      //   · 文件：content = **原始文件名**，mediaUrl = 公开 URL
      //   · 位置：content = encodeLocation 的 JSON，无 mediaUrl
      // 这四套口径与聊天页完全一致，保证对方看到的渲染结果相同。
      // ⚠️ 文件消息的 content 必须是文件名而不是 '[文件]'：聊天页渲染文件气泡时
      //    直接展示 content 当文件名，会话列表摘要也靠它显示「[文件] 报告.pdf」。
      if (draft.mediaKind === 'image') {
        await sendMessage(conversationId, me, '[图片]', 'image', draft.mediaUrl);
      } else if (draft.mediaKind === 'file') {
        await sendMessage(conversationId, me, draft.fileName ?? '文件', 'file', draft.mediaUrl);
      } else if (draft.mediaKind === 'voice') {
        // 语音消息的 content 是**时长串**（如 `[12s]`），不是占位符：
        // 聊天页渲染语音气泡时直接展示它，会话列表摘要也靠它显示「[语音] 0:12」。
        await sendMessage(conversationId, me, draft.voiceDuration ?? '[1s]', 'voice', draft.mediaUrl);
      } else if (draft.mediaKind === 'location') {
        await sendMessage(conversationId, me, draft.locationContent ?? '', 'location');
      } else {
        await sendMessage(conversationId, me, draft.message, 'text');
      }
      if (runIdRef.current !== myRun) return;

      // 【必须补写会话摘要，否则会话列表看不到这条消息】
      // 聊天页发消息走的是 messages-store，它在 sendMessage 之后会调
      // `conversationsApi.updateLastMessage()` 写 `conversations.last_message_at` +
      // `last_message`；而本页直接调 `api/messages.ts` 的 sendMessage，**只 INSERT
      // messages 表**，完全不碰 conversations 行。后果有两个：
      //   ① 会话列表按 `last_message_at` 倒序排（`listConversations` 的 order），
      //      新建会话该字段为 NULL → 这条会话被排到列表最底部，用户以为「没发出去」；
      //   ② 列表摘要仍显示上一条内容，看不到刚发的这条。
      // 所以这里必须补上这一步，口径与 messages-store 完全一致：
      //   · 文字 → 正文本身
      //   · 图片/语音/位置 → 中文占位（位置绝不能把 JSON 串写进摘要）
      //   · 文件 → `[文件] 文件名`
      // ⚠️ 不 await：摘要写入失败不该让「已发送成功」的结果变成失败（消息确实已落库）。
      //    但 updateLastMessage 内部会**立即**写 last_message_at（不等合并窗口），
      //    所以列表排序能马上正确；摘要文本最迟 1.2s 后落库。
      const summary =
        draft.mediaKind === 'text'
          ? draft.message
          : draft.mediaKind === 'file'
            ? `[文件] ${draft.fileName ?? '文件'}`
            : draft.mediaKind === 'image'
              ? '[图片]'
              : draft.mediaKind === 'voice'
                ? '[语音]'
                : '[位置]';
      logDbg(`[batch] 🏷️ 补写会话摘要: type=${draft.mediaKind} → "${summary}"`);
      updateLastMessage(conversationId, summary).catch((e) => {
        logDbg('[batch] ⚠️ 补写会话摘要失败（消息已发出，仅列表摘要可能滞后）:', e?.message || e);
      });

      logDbg(`[batch] ✅ send 成功 → ${draft.who} 类型=${draft.mediaKind} conversationId=${conversationId}`);
      const lines: string[] = [
        `收件人：${draft.who}`,
        `消息类型：${SEND_MEDIA_LABELS[draft.mediaKind]}`,
      ];
      if (draft.mediaKind === 'text') {
        lines.push(`消息内容：${draft.message}`);
      } else if (draft.mediaKind === 'image') {
        lines.push('消息内容：[图片]');
      } else if (draft.mediaKind === 'file') {
        lines.push(`文件名：${draft.fileName ?? '文件'}`);
        if (draft.fileSize) lines.push(`文件大小：${draft.fileSize}`);
      } else if (draft.mediaKind === 'voice') {
        lines.push(`语音时长：${draft.voiceSeconds ?? 1} 秒`);
      } else if (draft.locationCoords) {
        lines.push(`坐标：${draft.locationCoords.lat.toFixed(6)}, ${draft.locationCoords.lng.toFixed(6)}`);
      }
      lines.push(`发送时间：${formatCheckTime(new Date().toISOString())}`);
      lines.push('');
      lines.push('（消息已写入你与 TA 之间，对方可在详情页看到）');
      setCheckResult({ ok: true, title: `已发送给 ${draft.who}`, lines });
    } catch (e: any) {
      if (runIdRef.current !== myRun) return;
      logDbg('[batch] ✉️ send 执行失败:', e?.message || e);
      setCheckResult({
        ok: false,
        title: `send ${draft.who}`,
        lines: [`发送失败：${e?.message || '未知错误'}`],
      });
    } finally {
      if (runIdRef.current === myRun) setCheckRunning(false);
    }
  };

  /** 确认卡片点「取消」：丢弃本次发送，不建会话、不发消息 */
  const cancelSend = useCallback(() => {
    const draft = sendConfirm;
    if (!draft) return;
    logDbg(`[batch] ✉️ 用户取消发送 → ${draft.who}`);
    setSendConfirm(null);
    sendConfirmRef.current = null;
    // 取消也要作废代次：否则准备阶段残留的异步回调可能把卡片又弹回来
    runIdRef.current += 1;
    setCheckRunning(false);
    setCheckResult({
      ok: true,
      title: `send ${draft.who}`,
      lines: ['已取消发送，未产生任何消息。'],
    });
  }, [sendConfirm]);

  /**
   * 显示 help / all 说明。
   *
   * 与 check 结果共用 checkResult 渲染管线（同一块结果区、同一套「标签：值」排版），
   * 但**不设 checkState**——说明文案没有在场状态语义，设了会在标题旁多出一个色点。
   * 文案全部来自 `lib/diag-help.ts`（真源是 DIAG_COMMANDS / DIAG_LAYERS /
   * CHECK_SUBCOMMANDS），这里只负责选哪一份 + 打日志。
   *
   * 三种来源：
   * - `all` → 全部指令总览清单（快速浏览用）
   * - 命令框选中 check + `help` → check 命令详解
   * - 其它指令 + `help` → 该指令的专属详解
   */
  const showHelp = useCallback((kind: 'help' | 'all') => {
    runIdRef.current += 1; // 作废在途请求，避免旧回包覆盖说明
    setResult(undefined);
    setCheckState(null);
    setCheckRunning(false);
    setPending(false);

    let lines: string[];
    let title: string;
    if (kind === 'all') {
      lines = buildAllHelp();
      title = '全部指令总览';
    } else if (isCheckSelected(cmdIndex)) {
      lines = buildCheckHelp();
      title = `${CHECK_PREFIX} 命令说明`;
    } else if (isSendSelected(cmdIndex)) {
      // send 是写操作，必须有独立说明入口：混进 check 的说明里，
      // 用户会以为它也是只读查询，从而在没想清楚时把消息发出去。
      lines = buildSendHelp();
      title = `${SEND_PREFIX} 命令说明`;
    } else {
      const cmd = DIAG_COMMANDS[cmdIndex];
      lines = buildCommandHelp(cmd?.key ?? '');
      title = `${cmd?.key ?? '指令'} 指令说明`;
    }
    logDbg(`[batch] 📖 显示说明（${kind}，指令=${COMMAND_LABELS[cmdIndex]}），共 ${lines.length} 行`);
    setCheckResult({ ok: true, title, lines });
  }, [cmdIndex]);

  /**
   * 启动录音（send 命令发语音的第一步）。
   *
   * 【为什么不用 Promise 包住等 onStop】录音是用户交互驱动的：用户点「停止」才触发
   * onStop。用 Promise 等回调会让调用方挂起，而用户可能永远不点停止（或直接退出页面）。
   * 所以这里启动后立即返回，由 onStop 回调接着走后续流程。
   *
   * 【为什么格式首选 wav】与聊天页同口径：百度短语音识别只接受 pcm/wav/amr/m4a，
   * 而部分安卓机型会忽略 `format:'m4a'` 请求、实际回 mp3，导致转文字永远失败。
   * wav 是 PCM 无编码分支，微信与识别服务两侧都原生支持。少数基础库不支持 wav 时
   * 逐级降档 wav → m4a → mp3，保证「发得出去」优先于「转得了文字」。
   */
  const startVoiceRecord = (run: number, username: string, who: string, peerId: string) => {
    // H5 预览端没有录音能力，必须明确拦截，不能静默失败
    if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
      logDbg('[batch] 🎙️ 非微信环境，无法录音');
      setCheckResult({
        ok: false,
        title: `send ${username}`,
        lines: ['录音仅在微信小程序中可用。', '当前在预览环境，请用真机体验。'],
      });
      return;
    }

    voiceCtxRef.current = { run, username, who, peerId };
    setIsRecording(true);
    setRecordingSeconds(0);
    recordTimerRef.current = setInterval(() => setRecordingSeconds((p) => p + 1), 1000);

    const FORMAT_TIERS: Array<'wav' | 'm4a' | 'mp3'> = ['wav', 'm4a', 'mp3'];
    let tier = Math.min(formatTierRef.current, FORMAT_TIERS.length - 1);
    let started = false;
    while (tier < FORMAT_TIERS.length && !started) {
      try {
        recordFormatRef.current = FORMAT_TIERS[tier];
        logDbg(`[batch] 🎙️ 录音器启动: format=${FORMAT_TIERS[tier]} rate=16000 ch=1 bitrate=48000`);
        recorderRef.current?.start({
          duration: 60000,
          sampleRate: 16000,
          numberOfChannels: 1,
          encodeBitRate: 48000,
          // ⚠️ 必须 as never：Taro 的 RecorderManager 类型把 format 收窄成它自己声明的
          // 枚举（不含 m4a），但微信真机实际支持 m4a。聊天页同样绕过了这个类型。
          format: FORMAT_TIERS[tier] as never,
        });
        formatTierRef.current = tier;
        started = true;
      } catch (e) {
        logDbg(`[batch] 🎙️ ${FORMAT_TIERS[tier]} 启动失败，降档重试:`, e);
        tier += 1;
      }
    }
    if (!started) {
      logDbg('[batch] 🎙️ 全部候选格式都无法启动录音器');
      setIsRecording(false);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      voiceCtxRef.current = null;
      setCheckResult({
        ok: false,
        title: `send ${username}`,
        lines: ['当前设备暂不支持录音。', '可以改用「文件」发送音频文件。'],
      });
    }
  };

  /** 停止录音：用户点浮层上的「停止」按钮触发，onStop 回调接着走上传 */
  const stopVoiceRecord = () => {
    if (!isRecording) return;
    logDbg('[batch] 🎙️ 用户点停止录音');
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    recorderRef.current?.stop();
  };

  /** 取消录音：丢弃本次录音，不发消息、不弹确认卡片 */
  const cancelVoiceRecord = () => {
    const ctx = voiceCtxRef.current;
    logDbg('[batch] 🎙️ 用户取消录音');
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    recorderRef.current?.stop();
    // 作废代次：onStop 回调会校验 runIdRef.current === ctx.run，不匹配就丢弃
    runIdRef.current += 1;
    voiceCtxRef.current = null;
    setIsRecording(false);
    setRecordingSeconds(0);
    if (ctx) {
      setCheckResult({
        ok: true,
        title: `send ${ctx.username}`,
        lines: ['已取消录音，未发送任何消息。'],
      });
    }
  };

  /**
   * 录音结束后的续跑：上传音频 → 弹确认卡片。
   *
   * 【为什么单独抽一个函数】onStop 回调里要做的事（校验路径、校正格式、上传、弹卡片）
   * 与「准备阶段」的其它媒体分支是同一件事，只是触发时机不同（回调驱动而非 await）。
   */
  const finishVoiceRecord = async (tempFilePath: string, duration: number) => {
    const ctx = voiceCtxRef.current;
    voiceCtxRef.current = null;
    if (!ctx) return;
    // 代次校验：录音期间用户可能点了「停止」或发起新一轮命令，此时本次录音已作废
    if (runIdRef.current !== ctx.run) {
      logDbg('[batch] 🎙️ 录音已过期（代次不匹配），丢弃');
      return;
    }

    // 以微信实际回包的文件名为准校正格式：部分安卓机型会忽略 start 请求的 m4a、实际回 mp3。
    // 若继续按启动参数命名，存储里就是「扩展名 m4a、内容 mp3」的假 m4a，播放与识别都会失败。
    const baseName = decodeURIComponent(tempFilePath.split(/[?#]/)[0].split('/').pop() || '');
    const realExt = /\.([a-z0-9]{2,4})$/i.exec(baseName)?.[1]?.toLowerCase() || '';
    if (realExt === 'wav' || realExt === 'm4a' || realExt === 'mp3') {
      if (realExt !== recordFormatRef.current) {
        logDbg(`[batch] 🎙️ 录音回包实际格式(${realExt})与启动请求(${recordFormatRef.current})不一致，按实际格式命名`);
        recordFormatRef.current = realExt;
      }
    }

    const seconds = Math.max(1, Math.ceil(duration / 1000));
    const voiceDuration = `[${seconds}s]`;
    const realFormat = recordFormatRef.current;
    const audioMime = realFormat === 'mp3' ? 'audio/mpeg' : realFormat === 'wav' ? 'audio/wav' : 'audio/mp4';

    try {
      logDbg(`[batch] 🎙️ 语音开始上传: ${realFormat} ${seconds}s`);
      const up = await uploadToSupabase(
        { name: `voice-${Date.now()}.${realFormat}`, type: audioMime, size: 0, tempFilePath },
        { bucket: 'chat-media' },
      );
      if (runIdRef.current !== ctx.run) return;
      if (!up.success || !up.data?.path) {
        logDbg('[batch] 🎙️ 语音上传失败:', up.error);
        setCheckResult({
          ok: false,
          title: `send ${ctx.username}`,
          lines: [`语音上传失败：${up.error || '未知错误'}`, '请检查网络后重试。'],
        });
        return;
      }
      const mediaUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${up.data.path}`;
      logDbg('[batch] 🎙️ 语音已上传:', mediaUrl.slice(0, 80));

      // 弹确认卡片：与其它媒体类型走同一套卡片，用户确认后才真正发送
      const draft: SendConfirmState = {
        who: ctx.who,
        peerId: ctx.peerId,
        mediaKind: 'voice',
        message: '',
        mediaUrl,
        voiceDuration,
        voiceSeconds: seconds,
        run: ctx.run,
      };
      setSendConfirm(draft);
      sendConfirmRef.current = draft;
      setCheckRunning(false);
      logDbg(`[batch] 🎙️ 已弹出确认卡片 → ${ctx.who} 语音 ${seconds}s`);
    } catch (e: any) {
      if (runIdRef.current !== ctx.run) return;
      logDbg('[batch] 🎙️ 语音上传异常:', e?.message || e);
      setCheckResult({
        ok: false,
        title: `send ${ctx.username}`,
        lines: [`语音上传失败：${e?.message || '未知错误'}`],
      });
    }
  };

  /**
   * 点「发送类型」按钮：**直接拉起对应的选择器/录音**，不再往输入框填标记。
   *
   * 【为什么改成直接拉起】旧实现是「点按钮 → 输入框出现 `[图片]` → 用户再点开始测试」，
   * 用户反馈「点击后直接在框内出现对应的文字，根本没弹窗」——按钮的语义应该是
   * 「我要发图片」，点下去就该弹相册，而不是让用户先看到一串方括号语法。
   *
   * 【为什么需要用户名】发送必须有收件人。这里从输入框里取首段当用户名：
   * 用户的操作顺序是「先敲用户名 → 再点类型按钮」，所以此时输入框里已有 `hong`。
   * 取不到合法用户名时给出明确提示，而不是弹了相册才发现没填收件人。
   *
   * 【为什么复用 runSendCommand 而不是另写一套】媒体准备、确认卡片、代次令牌、
   * 会话建立、消息落库这一整套逻辑已经在 runSendCommand 里，另写一套必然漂移。
   * 这里只负责「把按钮点击翻译成一次 send 调用」。
   */
  const handlePickMediaKind = (kind: SendMediaKind) => {
    const username = target.trim().split(/\s+/)[0] ?? '';
    if (!USERNAME_RE.test(username)) {
      logDbg(`[batch] ✉️ 点选发送类型 ${kind} 但用户名非法: "${username}"`);
      setResult(undefined);
      setCheckState(null);
      setCheckResult({
        ok: false,
        title: `${SEND_PREFIX} 命令格式`,
        lines: [
          '请先在输入框里填收件人用户名，再点发送类型。',
          '',
          '示例：输入框填 hong，然后点「图片」',
          '',
          '用户名：2-20 位，支持中英文、数字、下划线，区分大小写。',
        ],
      });
      return;
    }
    logDbg(`[batch] ✉️ 点选发送类型 ${kind} → 直接拉起选择器，收件人=${username}`);
    // 媒体消息的正文为空串（内容在准备阶段产生），与手打标记走同一条路径
    void runSendCommand(username, '', kind);
  };

  const handleStart = async () => {
    // help / all 优先拦截：必须在 check 解析之前——`check help` 会被 parseCheckArgs
    // 判成「用户名=check、子命令=help」，而 help 不在子命令白名单里，会落到
    // 「请输入有效的域名或 IP」的兜底提示，用户就看不到说明了。
    const helpKind = parseHelpRequest(target);
    if (helpKind) {
      logDbg(`[batch] 📖 识别为说明请求: ${helpKind}`);
      showHelp(helpKind);
      return;
    }
    // 隐藏命令优先拦截：必须在 normalizeTarget 之前，否则 `check hong message`
    // 会被当成无效地址、弹「请输入有效的域名或 IP」。
    // 三种写法都认：
    //   ① 命令框选中 check + 子命令下拉框选定 + 输入框只填用户名（推荐）
    //   ② 命令框选中 check + 输入框「用户名 子命令」
    //   ③ 输入框里整条敲 `check 用户名 子命令`（历史习惯）
    // ⚠️ ① 必须排在 ② 之前：单段输入在 ② 里会被判成「段数不对」而失败，
    //    若顺序反了，用户按推荐写法填用户名会落到「请输入有效的域名或 IP」。
    const checkSub = CHECK_SUBCOMMANDS[checkSubIndex];
    const cmd = isCheckSelected(cmdIndex)
      ? (parseCheckUsername(target, checkSub) ?? parseCheckArgs(target))
      : parseCheckCommand(target);
    if (cmd) {
      logDbg(
        `[batch] 🔎 识别为隐藏命令: check ${cmd.username} ${cmd.sub}` +
          `${cmd.limit ? ` limit=${cmd.limit}` : ''}${cmd.period ? ` period=${cmd.period}` : ''}`,
      );
      await runCheckCommand(cmd.username, cmd.sub, cmd.limit, cmd.period);
      return;
    }
    // 命令框选中了 check 但没解析成功：说明用户名不合法，给出格式提示而不是
    // 落到「请输入有效的域名或 IP」——用户明明选的是 check，提示域名会让人困惑。
    if (isCheckSelected(cmdIndex)) {
      setResult(undefined);
      setCheckState(null);
      setCheckResult({
        ok: false,
        title: `${CHECK_PREFIX} 命令格式`,
        lines: [
          '格式：先在子命令下拉框选一项，再在输入框填用户名',
          '示例：子命令选 online，输入框填 hong',
          `条数：子命令选 message 时可加数字，如 hong 10（默认 ${CHECK_MESSAGE_DEFAULT_LIMIT} 条，最多 ${CHECK_MESSAGE_MAX_LIMIT} 条）`,
          `周期：子命令选 stats 时可加 ${CHECK_STATS_PERIODS.join(' / ')}，如 hong week（默认 ${CHECK_STATS_DEFAULT_PERIOD} = ${CHECK_STATS_PERIOD_LABELS[CHECK_STATS_DEFAULT_PERIOD]}）`,
          '',
          '用户名：2-20 位，支持中英文、数字、下划线，区分大小写。',
          '',
          `（也可以整条敲：${CHECK_PREFIX} hong online）`,
        ],
      });
      return;
    }
    // 发送命令：与 check 同层拦截，同样必须在 normalizeTarget 之前。
    // 两种写法都认：
    //   ① 命令框选中 send + 输入框「用户名 消息内容」（推荐，不用重复敲 send）
    //   ② 输入框里整条敲 `send 用户名 消息内容`（历史习惯）
    // ⚠️ 选中 send 时**只走两段式**，不再回退 parseSendCommand：否则用户填的
    //    `sendmail.com 你好` 会被当成「给 sendmail.com 发消息」——但 sendmail.com
    //    不是合法用户名（含点号），两段式会判非法并给出格式提示，这才是对的。
    const sendCmd = isSendSelected(cmdIndex) ? parseSendArgs(target) : parseSendCommand(target);
    if (sendCmd) {
      await runSendCommand(sendCmd.username, sendCmd.message, sendCmd.mediaKind);
      return;
    }
    // 命令框选中了 send 但没解析成功：说明格式不对，给出格式提示而不是
    // 落到「请输入有效的域名或 IP」——用户明明选的是 send，提示域名会让人困惑。
    if (isSendSelected(cmdIndex)) {
      setResult(undefined);
      setCheckState(null);
      setCheckResult({
        ok: false,
        title: `${SEND_PREFIX} 命令格式`,
        lines: [
          '格式：用户名 消息内容',
          '示例：hong 你好，在吗',
          '发图片：hong [图片]',
          '发位置：hong [位置]',
          '发文件：hong [文件]',
          '',
          '用户名：2-20 位，支持中英文、数字、下划线，区分大小写。',
          '消息内容：不能为空，最多 2000 字，可以包含空格。',
          '',
          `（也可以整条敲：${SEND_PREFIX} hong 你好，在吗）`,
        ],
      });
      return;
    }
    await handleRun();
  };

  /** 组装单步测试结论文本（含时间、指令、目标、状态、摘要） */
  const buildReportText = (): string => {
    const d = new Date();
    const timeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const cmd = DIAG_COMMANDS[cmdIndex];
    const lines: string[] = [
      `【网络单步测试报告】${timeStr}`,
      `指令：${cmd?.key ?? ''}（${cmd?.title ?? ''}）`,
      `目标：${normalizeTarget(target) ?? target}`,
      '',
    ];
    if (result) {
      lines.push(`状态：${STATUS_TEXT[result.status]}`);
      lines.push(`结论：${result.summary}`);
      if (result.durationMs > 0) lines.push(`耗时：${result.durationMs}ms`);
    } else {
      lines.push('状态：未完成');
    }
    return lines.join('\n');
  };

  const handleCopy = () => {
    const text2 = buildReportText();
    Taro.setClipboardData({
      data: text2,
      success: () => Taro.showToast({ title: '结果已复制', icon: 'success' }),
      fail: (err) => {
        logDbg('[batch] setClipboardData fail:', err, '→ 打开可选中文本降级弹层');
        setCopyFallbackText(text2);
      },
    });
  };

  /**
   * 复制整块隐藏命令结果（标题 + 全部正文行）。
   *
   * 【为什么复制的是「标题 + 正文」而不是只有正文】结果区里标题承载了「谁 + 哪个周期」
   * 这个关键上下文，只复制正文粘到别处就变成一堆没有主语的数字。
   * 【为什么用 `\n` 拼纯文本而不是 JSON】用户要的是能直接粘进聊天框/备忘录的可读文本，
   * JSON 粘过去还得自己解析。
   * ⚠️ 复制失败必须走降级弹层（copyFallbackText）而不是只弹 toast：小程序未开通
   *    剪贴板权限时 setClipboardData 会 fail，此时用户唯一能自救的方式是长按选中文本。
   *    结果正文本身已带 `selectable`，弹层里再给一份完整文本兜底。
   */
  const handleCopyCheckResult = () => {
    if (!checkResult) return;
    // 归一化后按纯文本输出：`kind` 只影响渲染样式，复制内容里不能出现任何标记
    const text2 = [checkResult.title, ...normalizeCheckLines(checkResult.lines).map((l) => l.text)].join('\n');
    Taro.setClipboardData({
      data: text2,
      success: () => Taro.showToast({ title: '结果已复制', icon: 'success' }),
      fail: (err) => {
        logDbg('[batch] 复制命令结果 fail:', err, '→ 打开可选中文本降级弹层');
        setCopyFallbackText(text2);
      },
    });
  };

  /**
   * 复制 `check place` 查到的坐标。
   *
   * 【为什么复制的是「lat,lng」而不是整块结果】用户要的是能直接粘到别处（地图 App、
   * 聊天框、工单）的坐标串，整块结果里混着时间与说明文案，粘过去还得手删。
   * 格式固定 `lat,lng`（英文逗号 + 空格），与结果区展示的「坐标：」行完全一致，
   * 用户看到的和复制到的是同一个串，不会对不上。
   *
   * ⚠️ 复制失败必须走降级弹层而不是只弹 toast：小程序未开通剪贴板权限时
   *    setClipboardData 会 fail，此时用户唯一能自救的方式是长按选中文本，
   *    所以把坐标塞进 copyFallbackText 让弹层里的可选中文本兜住。
   */
  const handleCopyCoords = useCallback((coords: { lat: number; lng: number }) => {
    const text2 = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    Taro.setClipboardData({
      data: text2,
      success: () => Taro.showToast({ title: '坐标已复制', icon: 'success' }),
      fail: (err) => {
        logDbg('[batch] 复制坐标 fail:', err, '→ 打开可选中文本降级弹层');
        setCopyFallbackText(text2);
      },
    });
  }, []);

  /**
   * 打开地图查看 `check place` 查到的坐标。
   *
   * 【为什么复用 openLocationOnMap 而不是内嵌 <Map> 组件】
   * ① 项目里已有 `openLocationOnMap`（lib/location-message），它内部处理了两件容易漏的事：
   *    仅 WEAPP 可用、以及拉起原生全屏页前先 `setNativePreviewGrace()` 豁免隐私罩
   *    （openLocation 会触发 App 级 onAppHide，不豁免会被隐私罩误判成「离开应用」）。
   *    自己内嵌 <Map> 就得把这些逻辑再实现一遍，且 <Map> 在 H5 端根本不支持。
   * ② 原生地图是全屏可缩放拖动的，比结果区里塞一个小地图框好用得多。
   *
   * ⚠️ H5 预览端 openLocationOnMap 直接返回 false，必须给出明确提示，
   *    否则用户点了没反应会以为功能坏了。
   */
  const handleOpenMap = useCallback((coords: { lat: number; lng: number }) => {
    logDbg(`[batch] 🗺️ 点击查看地图: (${coords.lat}, ${coords.lng})`);
    void openLocationOnMap({ lat: coords.lat, lng: coords.lng, name: '', address: '' }).then((ok) => {
      if (!ok) Taro.showToast({ title: '请在微信小程序中查看地图', icon: 'none' });
    });
  }, []);

  /**
   * 打开地点对比页（`check stats` 的「地点对比」）。
   *
   * 【为什么只传 userId + 时间区间，不传点数组】一个周期最多 500 个点，序列化进
   * URL 会超微信的页面 URL 长度限制；且页面刷新/从后台恢复后数据就没了。页面
   * 自己用同一对 `startIso/endIso` 重新查一次 `listLocationHistoryBetween`，
   * 数据源与结果区完全一致。
   *
   * ⚠️ 三个参数都必须 `encodeURIComponent`：ISO 时间串含 `:`，`peerName` 可能是中文，
   *    不编码会让 query 解析错位、页面拿到空参数后显示「缺少时间区间」。
   */
  const handleOpenTrack = useCallback(() => {
    const track = checkResult?.track;
    if (!track) return;
    const me = useAuthStore.getState().user?.id ?? '';
    // 兜底坐标（profiles.last_*）也带过去：历史点不足时页面靠它画「最后位置」，
    // 否则用户点进来只会看到「这段时间没有定位记录」，等于入口白给。
    const fb = (p?: { lat: number; lng: number; recordedAt: string } | null) =>
      p
        ? `&fbLat=${encodeURIComponent(String(p.lat))}&fbLng=${encodeURIComponent(String(p.lng))}&fbAt=${encodeURIComponent(p.recordedAt)}`
        : '';
    const url =
      `/pages/location-track/index?peerId=${encodeURIComponent(track.peerId ?? '')}` +
      `&meId=${encodeURIComponent(me)}` +
      `&start=${encodeURIComponent(track.startIso)}` +
      `&end=${encodeURIComponent(track.endIso)}` +
      `&peerName=${encodeURIComponent(track.peerName)}` +
      fb(track.fallbackMine).replace(/&fbLat/, '&fbMineLat').replace(/&fbLng/, '&fbMineLng').replace(/&fbAt/, '&fbMineAt') +
      fb(track.fallbackPeer).replace(/&fbLat/, '&fbPeerLat').replace(/&fbLng/, '&fbPeerLng').replace(/&fbAt/, '&fbPeerAt');
    logDbg(
      `[batch] 🗺️ 打开地点对比页: 我=${track.mine.length} 点, TA=${track.peer.length} 点, 区间=${track.startIso} ~ ${track.endIso}, 兜底=${track.fallbackMine || track.fallbackPeer ? '有' : '无'}`,
    );
    Taro.navigateTo({ url }).catch((err) => {
      logDbg('[batch] 打开地点对比页失败:', err);
      Taro.showToast({ title: '打开地点对比页失败', icon: 'none' });
    });
  }, [checkResult?.track]);

  // 当前指令 / 是否有二级子命令 / 子命令框宽度：三者都只由 cmdIndex、checkSubIndex 决定，
  // 面板每次输入（target 变化）都会重渲染，不 memo 的话每敲一个字都重算一遍。
  const currentCmd = useMemo(() => DIAG_COMMANDS[cmdIndex], [cmdIndex]);

  /**
   * 当前指令是否有「二级子命令」。
   *
   * 【为什么单独抽一个布尔量】它同时决定三件事：子命令框是否渲染、命令框是否从
   * `flex-[2]` 切成 `flex-none`、输入框是否从 `flex-[3]` 变成 `flex-1`。
   * 三处各写一遍 `isCheckSelected(cmdIndex)` 时，将来新增第二个带子命令的指令
   * 必然漏改其中一处，表现为「子命令框出来了但命令框还是 flex-[2]、输入框被挤没」。
   * 所以收口成一个变量，新增带子命令的指令时只改这里。
   */
  const hasSubCommand = useMemo(() => isCheckSelected(cmdIndex), [cmdIndex]);

  /**
   * 子命令框宽度（px）：按当前子命令文案长度自适应。
   *
   * 【为什么不用固定宽度】用户要求「根据子命令长短自适应框的宽度」。固定宽度下
   * 短子命令（place）会留一大片空白、长子命令会被截断。
   * 【为什么按字符数估算而不是测量真实文本宽度】小程序没有同步的文本测量 API，
   * 而子命令是纯 ASCII 英文单词、字号固定（text-sm），字符数 × 8px 已足够准。
   * 中文按 2 个字符宽计，将来若出现中文子命令也不会算窄。
   * 【为什么夹在 [72, 132]】下限保证「place + 箭头 + 左右 padding」不挤；
   * 上限保证再长的子命令也不会把输入框压到无法输入。
   * ⚠️ 这是「跨端兼容修正」性质的 inline style（宽度必须按内容动态算，Tailwind
   *    任意值类名在小程序下不生效），符合项目「style 只用于跨端兼容修正」的约定。
   */
  const checkSubWidth = useMemo(
    () => Math.min(132, Math.max(72, CHECK_SUB_LABELS[checkSubIndex].length * 8 + 40)),
    [checkSubIndex],
  );

  return (
    <View className={withCardShell ? 'bg-card border border-border rounded-lg p-4 mb-4' : ''}>
      {withCardShell && (
        <View className="flex flex-row items-center justify-between mb-2">
          <Text className="text-foreground text-sm font-bold">网络单步测试</Text>
          <Text className="text-muted-foreground text-xs">选指令 + 填目标</Text>
        </View>
      )}

      {/* 命令 + 参数：左侧选指令（ping/dns/ports…/check）、右侧填参数，同一行。
          ⚠️ 两个框必须各自用 View 包一层：小程序下 Input/Picker 自身的
          padding/bg/radius 会被原生样式覆盖，直接给它们加类名不生效。
          ⚠️ 两个框都不放 placeholder / 副标题：占位文案会挤占高度、也让框显得空，
          这里只保留「已选中的指令名」与「已输入的内容」，靠框本身表达可点/可输。
          ⚠️ 命令框宽度用 flex 比例而非固定百分比：固定宽度下长指令名（dnscompare）
          会被截断，且两个框之间会留出空隙；用 flex-[2]/flex-[3] 让它们紧贴且自适应。
          【有二级子命令时（选中 check）】布局变成「命令框 → 子命令框 → 输入框」三框同行：
          子命令框插在命令框与输入框之间，宽度按当前子命令文案自适应（见下方
          CHECK_SUB_WIDTH 的说明），输入框吃掉剩余空间。没有二级子命令的指令
          （ping/dns/…/send）保持原来的两框布局，不受影响。 */}
      <View className="flex flex-row items-center mb-2">
        <Picker
          mode="selector"
          range={COMMAND_LABELS}
          value={cmdIndex}
          onChange={(e) => setCmdIndex(Number(e.detail.value))}
        >
          <View
            className={`bg-secondary rounded-lg px-3 py-4 flex flex-row items-center justify-between mr-1 ${
              hasSubCommand ? 'flex-none' : 'flex-[2]'
            }`}
          >
            <Text className="text-foreground text-sm font-medium flex-1 overflow-hidden">{COMMAND_LABELS[cmdIndex]}</Text>
            <View className="i-lucide-chevron-down w-4 h-4 text-muted-foreground ml-1" />
          </View>
        </Picker>

        {/* 二级子命令下拉框：只有当前指令有二级子命令时才出现（目前仅 check）。
            【为什么必须有它】子命令原本要手打在输入框里（`用户名 online`），用户得记住
            online / message / place 三个英文单词，且容易拼错。下拉框把「选做什么」从
            「记语法」变成「点一下」，输入框只剩「填用户名」一件事。
            【为什么可选项从 CHECK_SUBCOMMANDS 派生】用户要求「后继增加子命令也自动添加」——
            手写数组必然漏改，派生后新增子命令只需改 check-command.ts 一处。
            【为什么宽度按文案长度算】用户要求「根据子命令长短自适应框的宽度」：固定宽度下
            短子命令（place）会留一大片空白、长子命令会被截断。这里按字符数估算宽度
            （中文按 2 个字符宽计），再夹在 [72, 132] 之间——下限保证「place + 箭头」不挤，
            上限保证不会把输入框压到无法输入。
            ⚠️ 这是彩蛋通道，不对外公布：只显示英文子命令名，**不带中文释义**，
               也不加任何「输入框该填什么」的引导文案——多一行说明就等于把暗号公开了。
            ⚠️ 样式照抄命令框（bg-secondary + rounded-lg + py-4），保持同一行观感一致。 */}
        {hasSubCommand && (
          <Picker
            mode="selector"
            range={CHECK_SUB_LABELS}
            value={checkSubIndex}
            onChange={(e) => setCheckSubIndex(Number(e.detail.value))}
          >
            <View
              className="bg-secondary rounded-lg px-3 py-4 flex flex-row items-center justify-between mr-1 flex-none"
              style={{ width: `${checkSubWidth}px` }}
            >
              <Text className="text-foreground text-sm font-medium flex-1 overflow-hidden">
                {CHECK_SUB_LABELS[checkSubIndex]}
              </Text>
              <View className="i-lucide-chevron-down w-4 h-4 text-muted-foreground ml-1" />
            </View>
          </Picker>
        )}

        <View className="bg-secondary rounded-lg px-3 py-4 flex-1">
          <Input
            className="w-full bg-transparent text-foreground text-sm"
            value={target}
            onInput={(e) => setTarget(e.detail.value)}
            confirmType="search"
            onConfirm={handleStart}
          />
        </View>
      </View>

      {/* send 命令的类型快捷按钮：选中 send 时出现，点一下**直接拉起**对应的选择器/录音。
          【为什么必须有这排按钮】方括号标记（[图片]/[位置]/[文件]/[语音]）是**隐藏语法**，
          不写引导文案就没人知道；用户反馈「没有可选的按钮」正是这个原因。
          【为什么点按钮不填输入框】用户反馈「点击后直接在框内出现对应的文字，根本没弹窗」——
          按钮的语义是「我要发图片」，点下去就该弹相册，而不是让用户先看到一串方括号语法。
          ⚠️ 需要先在输入框里填收件人用户名：发送必须有收件人，取不到会给出明确提示。
          ⚠️ 样式照抄上方命令框（bg-secondary + rounded-lg），保持同一页面观感一致。 */}
      {isSendSelected(cmdIndex) && (
        <View className="flex flex-row items-center mb-2">
          <Text className="text-muted-foreground text-xs mr-2">发送</Text>
          {SEND_MEDIA_KINDS.filter((k) => k !== 'text').map((kind) => (
            <View
              key={kind}
              className="bg-secondary rounded-lg px-3 py-2 mr-2"
              onClick={() => handlePickMediaKind(kind)}
            >
              <Text className="text-foreground text-xs leading-none">{SEND_MEDIA_LABELS[kind]}</Text>
            </View>
          ))}
        </View>
      )}

      <View className="flex flex-row mb-1">
        {pending || checkRunning ? (
          <View
            className="flex-1 rounded-lg py-3 flex items-center justify-center border"
            style={{ borderColor: 'rgba(220, 38, 38, 0.4)', backgroundColor: 'rgba(220, 38, 38, 0.08)' }}
            onClick={handleStop}
          >
            <Text className="text-sm font-medium leading-none" style={{ color: '#dc2626' }}>
              {checkRunning ? '查询中…' : '停止'}
            </Text>
          </View>
        ) : (
          <View className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center" onClick={handleStart}>
            <Text className="text-primary-foreground font-medium text-sm leading-none">开始测试</Text>
          </View>
        )}
      </View>

      {/* 隐藏命令输出：与单步结果分开渲染，避免状态色/标题被命令结果污染 */}
      {checkResult !== null && (
        <View
          className="mt-3 rounded-lg px-3 py-3 border"
          style={{
            borderColor: checkResult.ok ? 'rgba(22, 163, 74, 0.4)' : 'rgba(220, 38, 38, 0.4)',
            backgroundColor: checkResult.ok ? 'rgba(22, 163, 74, 0.08)' : 'rgba(220, 38, 38, 0.08)',
          }}
        >
          <View className="flex flex-row items-center justify-between mb-2">
            <View className="flex flex-row items-center flex-1 mr-2">
              {/* 状态色点：与聊天页/会话列表页共用 presenceDotColor 取色，禁止在此硬编码十六进制。
                  放在标题左侧而非结果底部——状态是这块结果里最该一眼看到的信息，
                  沉在四行时间明细下面会被淹没。只在 online 子命令解析出状态时渲染，
                  其它子命令（message）没有状态语义。
                  ⚠️ 小程序下 bg-foo/N 透明度类名会丢，圆点用 inline backgroundColor。 */}
              {checkState !== null && (
                <View
                  className="w-2 h-2 rounded-full mr-2"
                  style={{ backgroundColor: presenceDotColor(checkState) ?? '#9ca3af' }}
                />
              )}
              <Text className="text-foreground text-xs font-bold flex-1">{checkResult.title}</Text>
              {checkState !== null && (
                <Text className="text-xs font-medium ml-2" style={{ color: presenceDotColor(checkState) ?? '#9ca3af' }}>
                  {formatPresenceLabel(checkState) || '未知（无在场记录）'}
                </Text>
              )}
            </View>
            <View className="px-2 py-1" onClick={() => setCheckResult(null)}>
              <Text className="text-muted-foreground text-xs">关闭</Text>
            </View>
          </View>
          {/* 结果正文：按行语义（section / field / compare / verdict / note）分别渲染。
              ⚠️ 为什么必须拆列：小程序下 Text 是 inline 元素，整行 `最近上线：10-16 12:30`
              在容器里会按字符流折行，折行后「值」会紧贴下一行的「标签」，
              视觉上不同字段连成一片、完全没法读（用户报过）。
              拆成「固定宽度的标签列 + 可换行的值列」后，每个字段各自成行、左对齐成列。
              ⚠️ 为什么要有 section / verdict 两种样式：stats 结果按维度分块，
              块标题必须比字段更醒目、结论必须比数字更醒目，否则整块平铺读不出层次。
              ⚠️ 空行（text 为空）保留为间距，不渲染文字。 */}
          {normalizeCheckLines(checkResult.lines).map((line, li) => {
            if (line.text === '') return <View key={`gap_${li}`} className="h-1" />;
            if (line.kind === 'section') {
              return (
                <View key={`${li}_${line.text}`} className="flex flex-row items-center mt-3 mb-1">
                  <View className="w-1 h-3 rounded-full bg-primary mr-2" />
                  <Text selectable className="text-xs font-bold text-foreground">
                    {line.text}
                  </Text>
                </View>
              );
            }
            if (line.kind === 'verdict') {
              return (
                <View key={`${li}_${line.text}`} className="flex flex-row items-start mt-1">
                  <Text selectable className="flex-1 text-xs font-medium text-primary leading-relaxed">
                    {line.text}
                  </Text>
                </View>
              );
            }
            if (line.kind === 'note') {
              return (
                <View key={`${li}_${line.text}`} className="flex flex-row items-start mt-2">
                  <Text selectable className="flex-1 text-xs text-muted-foreground leading-relaxed">
                    {line.text}
                  </Text>
                </View>
              );
            }
            // field / compare：都按「标签：值」拆两列，compare 的值加粗以突出双方对比
            const sep = line.text.indexOf('：');
            const hasLabel = sep > 0 && sep <= 6;
            const label = hasLabel ? line.text.slice(0, sep + 1) : '';
            const value = hasLabel ? line.text.slice(sep + 1) : line.text;
            return (
              <View key={`${li}_${line.text}`} className="flex flex-row items-start mt-1">
                {hasLabel && (
                  <Text selectable className="text-xs text-muted-foreground leading-relaxed w-16">
                    {label}
                  </Text>
                )}
                <Text
                  selectable
                  className={`flex-1 text-xs leading-relaxed ${line.kind === 'compare' ? 'font-bold text-foreground' : 'text-foreground'}`}
                  style={{ wordBreak: 'break-all' }}
                >
                  {value}
                </Text>
              </View>
            );
          })}

          {/* 操作行：复制整块结果（所有子命令都有）+ 位置相关操作（仅 place / stats 有坐标）。
              ⚠️ 为什么放在结果正文**之后**而不是标题栏：标题栏右侧已被「关闭」占用，
                 再塞按钮会把标题挤没；且这些操作是「看完结果后想做的事」，
                 放在正文下面符合阅读顺序。
              ⚠️ 样式照抄下方单步结果的「复制结果」按钮（border + i-lucide 图标 + text-xs），
                 保持同一页面内操作按钮观感一致。 */}
          <View className="flex flex-row items-center justify-end mt-2">
            <View
              className="flex flex-row items-center px-2 py-1 rounded-md border border-border"
              onClick={handleCopyCheckResult}
            >
              <View className="i-lucide-copy w-3 h-3 text-muted-foreground mr-1" />
              <Text className="text-muted-foreground text-xs">复制结果</Text>
            </View>
            {checkResult.coords && (
              <View
                className="flex flex-row items-center px-2 py-1 rounded-md border border-border ml-2"
                onClick={() => handleOpenMap(checkResult.coords!)}
              >
                <View className="i-lucide-map-pin w-3 h-3 text-muted-foreground mr-1" />
                <Text className="text-muted-foreground text-xs">查看地图</Text>
              </View>
            )}
            {/* 地点对比入口：`check stats` 且（至少一方有定位点，或至少一方有 profiles.last_* 回落坐标）。
                只有 1 个历史点且无回落坐标时与「查看地图」重复，故不显示。 */}
            {checkResult.track &&
              (checkResult.track.mine.length + checkResult.track.peer.length >= 1 ||
                Boolean(checkResult.track.fallbackMine || checkResult.track.fallbackPeer)) && (
                <View
                  className="flex flex-row items-center px-2 py-1 rounded-md border border-border ml-2"
                  onClick={handleOpenTrack}
                >
                  <View className="i-lucide-map-pin w-3 h-3 text-muted-foreground mr-1" />
                  <Text className="text-muted-foreground text-xs">地点对比</Text>
                </View>
              )}
            {checkResult.coords && (
              <View
                className="flex flex-row items-center px-2 py-1 rounded-md border border-border ml-2"
                onClick={() => handleCopyCoords(checkResult.coords!)}
              >
                <View className="i-lucide-copy w-3 h-3 text-muted-foreground mr-1" />
                <Text className="text-muted-foreground text-xs">复制坐标</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* 单步测试结果：只渲染选中指令对应的那一张检测项卡片 */}
      {result !== undefined && currentCmd && (
        <View>
          <LayerProbePanel
            commandKey={currentCmd.key}
            target={normalizeTarget(target) ?? target}
            result={result}
            pending={pending}
            onRetry={handleRetry}
          />
          <View className="flex flex-row items-center justify-end mt-1">
            <View className="flex flex-row items-center px-2 py-1 rounded-md border border-border" onClick={handleCopy}>
              <View className="i-lucide-copy w-3 h-3 text-muted-foreground mr-1" />
              <Text className="text-muted-foreground text-xs">复制结果</Text>
            </View>
            <View className="px-2 py-1 ml-2" onClick={() => onDeepDiagnose(normalizeTarget(target) ?? target)}>
              <Text className="text-primary text-xs">全量诊断</Text>
            </View>
          </View>
        </View>
      )}

      {/* 录音浮层：点「语音」按钮后出现，用户录完点「停止」才继续。
          ⚠️ 遮罩必须 inline backgroundColor（小程序下 bg-foo/N 透明度类名会丢）。
          ⚠️ 点遮罩**不取消**：录音是「正在采集」的状态，误触遮罩就丢弃会让用户白录一遍。
             取消必须走明确的「取消」按钮。
          ⚠️ 计时用 state 驱动（每秒 +1），不用 Date 差值：录音可能被系统打断，
             差值算法在打断后会跳变，而「已录了几秒」用户只关心大致进度。 */}
      {isRecording && (
        <View
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.6)', zIndex: 1100 }}
        >
          <View
            className="bg-card rounded-xl p-4 mx-6"
            style={{ position: 'absolute', top: '22%', left: 0, right: 0 }}
          >
            <View className="flex flex-row items-center justify-center mb-3">
              <View className="i-lucide-mic w-6 h-6 mr-2" style={{ color: '#dc2626' }} />
              <Text className="text-foreground text-sm font-bold">正在录音</Text>
            </View>
            <Text className="text-foreground text-2xl font-bold block text-center mb-1">{recordingSeconds}s</Text>
            <Text className="text-muted-foreground text-xs block text-center mb-4 leading-relaxed">
              最长 60 秒，录完点「停止」后会上传并让你确认
            </Text>
            <View className="flex flex-row">
              <View
                className="flex-1 rounded-lg py-3 flex items-center justify-center border border-border mr-2"
                onClick={cancelVoiceRecord}
              >
                <Text className="text-muted-foreground text-sm font-medium leading-none">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={stopVoiceRecord}
              >
                <Text className="text-primary-foreground text-sm font-medium leading-none">停止</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* send 命令的发送前确认卡片：把「发给谁 + 什么类型 + 内容」摆出来让用户反悔。
          ⚠️ 样式照抄下方复制降级弹层：遮罩必须 inline backgroundColor（小程序下
             bg-foo/N 透明度类名会丢），卡片用 absolute + top 百分比定位。
          ⚠️ 点遮罩 = 取消（与「取消」按钮同语义），点卡片内部阻止冒泡。
          ⚠️ 这是写操作的最后一道闸门，按钮文案必须明确写「确认发送」而不是「确定」，
             让用户清楚点下去会发生什么。 */}
      {sendConfirm !== null && (
        <View
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 1000 }}
          onClick={cancelSend}
        >
          <View
            className="bg-card rounded-xl p-4 mx-6"
            style={{ position: 'absolute', top: '18%', left: 0, right: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Text className="text-foreground text-sm font-bold block mb-3">确认发送这条消息？</Text>

            <View className="flex flex-row items-start mb-2">
              <Text className="text-xs text-muted-foreground w-16">收件人：</Text>
              <Text className="flex-1 text-xs text-foreground" style={{ wordBreak: 'break-all' }}>
                {sendConfirm.who}
              </Text>
            </View>
            <View className="flex flex-row items-start mb-2">
              <Text className="text-xs text-muted-foreground w-16">类型：</Text>
              <Text className="flex-1 text-xs text-foreground">{SEND_MEDIA_LABELS[sendConfirm.mediaKind]}</Text>
            </View>
            <View className="flex flex-row items-start mb-2">
              <Text className="text-xs text-muted-foreground w-16">内容：</Text>
              <Text className="flex-1 text-xs text-foreground" style={{ wordBreak: 'break-all' }}>
                {sendConfirm.mediaKind === 'text'
                  ? sendConfirm.message
                  : sendConfirm.mediaKind === 'image'
                    ? '图片（已上传，确认后发出）'
                    : sendConfirm.mediaKind === 'file'
                      ? `${sendConfirm.fileName ?? '文件'}${sendConfirm.fileSize ? `（${sendConfirm.fileSize}）` : ''}（已上传，确认后发出）`
                      : sendConfirm.mediaKind === 'voice'
                        ? `语音 ${sendConfirm.voiceSeconds ?? 1} 秒（已上传，确认后发出）`
                        : sendConfirm.locationCoords
                          ? `${sendConfirm.locationCoords.lat.toFixed(6)}, ${sendConfirm.locationCoords.lng.toFixed(6)}`
                          : '位置'}
              </Text>
            </View>

            {/* 图片预览：把已上传的图直接显示出来。
                【为什么必须有】确认卡片原本只写「[图片]（已上传）」，用户看不到
                自己选的是哪张图，点确认前无法核对——反馈「只发了个文字」正是这个原因。
                图片消息的 content 是固定占位符 '[图片]'，真实内容全在 media_url 里，
                所以预览必须用 mediaUrl 而不是 content。
                ⚠️ 用 mode="aspectFit" 而不是默认的 scaleToFill：用户可能选竖图或长图，
                拉伸变形会让人怀疑「是不是传错了」。
                ⚠️ 高度用固定值而非百分比：小程序下 Image 在 flex 容器里给百分比高度
                会塌成 0（父容器高度由内容决定，形成循环依赖）。 */}
            {sendConfirm.mediaKind === 'image' && sendConfirm.mediaUrl && (
              <View className="bg-secondary rounded-lg p-2 mb-2">
                <Image
                  src={sendConfirm.mediaUrl}
                  mode="aspectFit"
                  className="w-full rounded-md"
                  style={{ height: '160px' }}
                />
              </View>
            )}

            <Text className="text-muted-foreground text-xs block mt-3 leading-relaxed">
              消息会真的发出去，对方在详情页能看到。发送后只能手动撤回。
            </Text>

            <View className="flex flex-row mt-4">
              <View
                className="flex-1 rounded-lg py-3 flex items-center justify-center border border-border mr-2"
                onClick={cancelSend}
              >
                <Text className="text-muted-foreground text-sm font-medium leading-none">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={confirmSend}
              >
                <Text className="text-primary-foreground text-sm font-medium leading-none">确认发送</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* 复制失败降级弹层：页面内可选中文本，长按即可手动复制 */}
      {copyFallbackText !== '' && (
        <View
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 1000 }}
          onClick={() => setCopyFallbackText('')}
        >
          <View
            className="bg-card rounded-xl p-4 mx-6"
            style={{ position: 'absolute', top: '12%', left: 0, right: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Text className="text-foreground text-sm font-bold block mb-1">自动复制失败，请长按下方文字复制</Text>
            <Text className="text-muted-foreground text-xs block mb-3 leading-relaxed">
              小程序尚未开通剪贴板权限。如需恢复一键复制，请在微信公众平台「用户隐私保护指引」中添加「读取剪贴板」信息类型并填写用途。
            </Text>
            <View className="bg-secondary rounded-lg p-3">
              <ScrollView scrollY style={{ maxHeight: '50vh' }}>
                <Text className="text-foreground text-xs leading-relaxed break-all" selectable userSelect>
                  {copyFallbackText}
                </Text>
              </ScrollView>
            </View>
            <View className="mt-4 bg-primary rounded-lg py-3 flex items-center justify-center" onClick={() => setCopyFallbackText('')}>
              <Text className="text-primary-foreground text-sm font-medium">关闭</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
