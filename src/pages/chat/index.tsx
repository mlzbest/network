import { View, Text, Input, ScrollView, Image, Form, Button } from '@tarojs/components';
import Taro, { useRouter, useDidShow, useDidHide } from '@tarojs/taro';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useMessagesStore, msgCacheKeyOf } from '@/store/messages-store';
import { useAuthStore } from '@/store/auth-store';
import { useChatsStore } from '@/store/chats-store';
import { supabase, supabaseUrl } from '@/supabase/client';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { useKeyboardOffset } from '@/lib/hooks/use-keyboard-offset';
import { uploadToSupabase, selectMediaFiles, selectMessageFile, compressImageFile, compressImageFilesBatch, isPrivacyNotDeclaredError } from '@/lib/upload';
import { abortResizeBatch } from '@/lib/image-resizer';
import { uploadChatFile, openFileMessage, fileIconClass } from '@/lib/file-message';
import {
  LOCATION_LABEL,
  decodeLocation,
  encodeLocation,
  getCurrentLocation,
  locationSubtitle,
  locationTitle,
  openLocationOnMap,
  readLastLocation,
  saveLastLocation,
} from '@/lib/location-message';
import {
  WHERE_COMMAND,
  decodeWhereAck,
  encodeWhereAck,
  isWhereAck,
  isWhereCommand,
} from '@/lib/where-command';
import type { MiniProgramFileInput } from '@/lib/upload';
import type { LocationPayload } from '@/lib/location-message';
import * as messagesApi from '@/api/messages';
import * as conversationsApi from '@/api/conversations';
import { fetchPeerLoginStats, reportLastLocation, backfillLocationHistory } from '@/api/profiles';
import type { LoginWindow, PeerLoginStats } from '@/api/profiles';
import { useProfilesStore } from '@/store/profiles-store';
import { getWindowInfo } from '@/lib/system-info';
import type { Message } from '@/api/messages';
import { canRevoke } from '@/api/messages';
import ChatMessageRow from '@/components/chat-message-row';
import {
  abandonGuard,
  bumpGuard,
  claimFreshEntry,
  clearBackgroundNote,
  getLatestGeneration,
  notePageHidden,
  resolveEntryMode,
  retainGeneration,
  resumeGuard,
  startGuard,
} from '@/lib/page-guard';
import PrivacyShield from '@/components/privacy-shield';
import { isShieldArmed, getArmedRoute, setMediaPickerGrace, endMediaPickerGrace, setNativePreviewGrace } from '@/lib/shield-state';
import { isPeerOnline, formatLastSeen, formatOnlineDuration } from '@/lib/online-status';
import { reportPresence, resolvePresence, formatPresenceLabel, formatPresenceSince, flushPendingPresence, TYPING_LABEL, presenceDotColor, PRESENCE_DOT_COLORS } from '@/lib/presence';
import { WHERE_WAIT_TIMEOUT_MS, isWhereText, whereStatusLabel, type WhereWaitStatus } from '@/lib/where-status';
import { formatLoginDetailTime, toIso } from '@/lib/login-time';
import { markChatExit, readChatExit, readSecretEntry } from '@/lib/secret-entry';
import { transcribeVoice } from '@/api/asr';
import { startWechatAsr, hasWechatAsr } from '@/lib/wechat-asr';
import type { WechatAsrSession } from '@/lib/wechat-asr';
import { readTranscript, readTranscripts, writeTranscript } from '@/lib/voice-transcript-cache';
import {
  TRANSCRIPT_FONT_CLASS,
  TRANSCRIPT_FONT_LABEL,
  readExpandedIds,
  readTranscriptFontScale,
  writeExpandedIds,
  writeTranscriptFontScale,
} from '@/lib/transcript-ui-prefs';
import type { TranscriptFontScale } from '@/lib/transcript-ui-prefs';
import { readRecentEmojis, pushRecentEmoji } from '@/lib/recent-emojis';
import LoginDetailSheet from '@/components/login-detail-sheet';
import StepsCompareCard from '@/components/steps-compare-card';
import { logDbg } from '@/lib/logger';
import ErrorBoundary from '@/components/error-boundary';

// 本页 route（与 app.config.ts pages 一致），供 guard 做栈顶前台校验与代次归属
const PAGE_ROUTE = 'pages/chat/index';

// ===== 功能⑥「正在输入…」信号参数 =====
/** 本端广播节流窗口：首次立即发，之后每 2 秒最多一条，避免逐字符打 Realtime */
const TYPING_THROTTLE_MS = 2_000;
/** 对方静默超过该时长即撤掉指示（比节流窗口略长，容忍一次丢包不至于立刻消失） */
const TYPING_IDLE_MS = 4_000;

// ===== 发送图片多选上限 =====
/**
 * 微信 chooseMedia 的 count 上限就是 9；H5 端没有原生选择器上限，靠这里截断保持一致。
 * 单张图从选到发要跑一轮「压缩(小程序需拉起离屏 canvas 宿主页) → 上传 → 写消息」，
 * 上限过高会让整批耗时不可控、页面栈导航也更易被拒，故取平台最大值 9。
 */
const MAX_CHAT_IMAGES = 9;

// ===== where 指令（暗号）=====
// 常量与判定函数统一收口在 @/lib/where-command（chat 页 / api 层 / 会话列表三处共用同一口径）。
// 本页只做编排：收到 where → 回发位置 + 隐藏自己回的位置 + 发 ack 让 A 隐藏那条 where。

/**
 * 同一条 where 只自动回一次位置。
 * ⚠️ 必须去重：Realtime INSERT 与轮询降级两条通道可能同时/先后拿到同一条消息，
 *    不去重就会连发两条位置；页面重进后同一条历史消息也不该再触发。
 * 只存内存（模块级 Set）：跨会话重进时按「本次会话已处理」重新计，不会无限膨胀。
 */
const handledWhereIds = new Set<string>();

/** 同一条 where_ack 只处理一次（Realtime 与轮询两条通道会重复送达） */
const handledWhereAckIds = new Set<string>();

export default function ChatPage() {
  const router = useRouter();
  const conversationId = router.params.conversationId || '';
  const peerName = decodeURIComponent(router.params.peerName || '详情');

  const { user, loaded, bootstrapped } = useAuthStore();
  const { messages, loading, loaded: msgLoaded, loadError, hasMoreOlder, loadingOlder, loadOlderMessages, restoreFromCache, fetchMessages, sendMessage, receiveMessage, markAsRead, deleteMessage, revokeMessage, deleteAllMessages, reset } = useMessagesStore();
  // 发送失败的占位消息集合（红色感叹号 + 点击重发），真源在 store
  const failedIds = useMessagesStore((s) => s.failedIds);
  // 发送中的占位消息集合（气泡状态显示「发送中」），真源在 store
  const sendingIds = useMessagesStore((s) => s.sendingIds);
  const retrySend = useMessagesStore((s) => s.retrySend);
  const dismissFailed = useMessagesStore((s) => s.dismissFailed);
  const dismissPendingImages = useMessagesStore((s) => s.dismissPendingImages);
  // 批量图片：一次性预挂占位 + 并发落库原位替换（提速关键，见 messages-store）
  const stageImagePlaceholders = useMessagesStore((s) => s.stageImagePlaceholders);
  const sendImageBatch = useMessagesStore((s) => s.sendImageBatch);
  // 【逐张进度】气泡内进度条的数据源与写入器（仅内存态，见 messages-store）
  const imageProgress = useMessagesStore((s) => s.imageProgress);
  const setImageProgress = useMessagesStore((s) => s.setImageProgress);
  const clearImageProgress = useMessagesStore((s) => s.clearImageProgress);
  const [inputValue, setInputValue] = useState('');
  /**
   * 输入框光标位置（表情插入用）。
   * ⚠️ 微信 Input 的 `selectionStart` 只在 onInput / onBlur 等事件里回传，没有「随时读取」的 API，
   *    所以必须自己记：点表情时用它决定插在哪，插完把光标推到表情之后。
   * ⚠️ 初值 null 表示「还没拿到光标信息」，此时按追加到末尾处理。
   */
  const [inputSelection, setInputSelection] = useState<number | null>(null);
  const [inputFocus, setInputFocus] = useState(false); // 默认不聚焦,用户点击后才聚焦
  const inputRef = useRef<any>(null); // Input ref,用于强制聚焦
  const [scrollTop, setScrollTop] = useState(0);
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  /**
   * 最近使用过的表情（最新的在前，最多 6 个 = 面板顶部一行）。
   * ⚠️ 按 uid 隔离存储（见 `@/lib/recent-emojis`）：表情使用习惯是个人数据，
   *    换账号后看到上一个人的最近表情属于串号。
   * ⚠️ 初值给空数组而不是同步读存储：`user` 在首帧可能还没就绪，
   *    真正的 hydrate 放在下方依赖 `user?.id` 的 effect 里。
   */
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  // ===== 语音转文字（仅本机可见，结果落本地缓存，不写回 messages）=====
  /** 已识别出的文字：msgId → text（含冷启动从缓存 hydrate 的历史结果） */
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});
  /** 正在识别的消息 id（同一时刻只允许一条在跑，避免连点重复请求） */
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  /** 已展开转写文本的消息 id 集合（默认折叠，点一下才显示；用户手动开合过则跨会话记忆） */
  const [expandedTranscripts, setExpandedTranscripts] = useState<Set<string>>(new Set());
  /** 转写正文字号档位（全局偏好，进页时从本地读一次） */
  const [transcriptFont, setTranscriptFont] = useState<TranscriptFontScale>('base');
  /** 剪贴板被拒时的降级：页面内可选中文本弹层内容（非空即显示） */
  const [transcriptCopyText, setTranscriptCopyText] = useState('');
  const [hiddenClickCount, setHiddenClickCount] = useState(0);
  // 顶部「聊天对象名称」连点计数（连续3次单向 reLaunch 回 ping 页）
  const [nameClickCount, setNameClickCount] = useState(0);
  const nameClickTimerRef = useRef<any>(null);
  /**
   * 名称文字实测宽度（px）：在线圆点与「3 连点返回」热区都必须贴着名字右缘，
   * 而名字长度随昵称变化，故用 onLayout 量出真实宽度后按 px 定位。
   * 0 = 尚未量到（首帧），此时圆点/热区回退到「紧跟文字」的 inline 布局，不会飘到顶栏右侧。
   */
  const [nameTextWidth, setNameTextWidth] = useState(0);
  // 120秒无操作自动返回 ping 页：起点/代次统一由模块级 page-guard 管理，
  // 组件内只持有本实例代次号（旧实例补跑一律静默忽略，防误踢新页面）。
  const genRef = useRef(0);
  const keyboardOffset = useKeyboardOffset();
  // 转写块的字号是全局偏好：进页读一次（useState 初值只在挂载时取，此处用 effect 兼容热重载场景）
  useEffect(() => {
    setTranscriptFont(readTranscriptFontScale());
  }, []);
  // 最近表情按 uid 隔离：必须等 user 就绪后再读，否则读到的是空 key 下的记录。
  // ⚠️ 依赖 user?.id 而不是空数组：冷启动时 user 由过渡态切到真实账号会换 id，
  //    此时要重新 hydrate，否则会一直显示上一个账号的最近表情。
  useEffect(() => {
    const list = readRecentEmojis(user?.id);
    setRecentEmojis(list);
    logDbg(`[chat] 😊 最近表情已加载: ${list.length} 个`);
  }, [user?.id]);
  const recorderManagerRef = useRef<any>(null);
  /**
   * 录音格式降级档位（onError 只注册一次，必须用 ref 承载跨回调状态）：
   * 0 = wav 优先（百度原生接受，PCM 无编码兼容问题）
   * 1 = 本机 wav 不可用 → m4a
   * 2 = m4a 也不可用/被忽略 → mp3（保底能发出去，但百度不接受 mp3，仅影响转文字）
   */
  const formatTierRef = useRef(0);
  /** 当前录音器实际使用的格式：onError 降级与上传扩展名反解都以此为准 */
  const recordFormatRef = useRef<'wav' | 'm4a' | 'mp3'>('wav');
  // 本次录音的「微信同声传译」识别句柄（免密通道）：录音开始时创建、onStop 时取最终文本落本机缓存。
  // 用 ref 而非 state——识别中间结果不参与渲染，避免每次回调都触发整列表重绘。
  const wechatAsrRef = useRef<WechatAsrSession | null>(null);
  const innerAudioContextRef = useRef<any>(null);
  const recordingTimerRef = useRef<any>(null);
  const hiddenClickTimerRef = useRef<any>(null);
  const pollingTimerRef = useRef<any>(null); // 轮询计时器(Realtime降级方案)
  const realtimeConnectedRef = useRef(false); // Realtime连接状态
  const lastPeerMsgAtRef = useRef(0); // 最近一条对方消息的服务端时间戳(ms),用于计算推送延迟
  const timerIdCounter = useRef<number>(0); // 计时器ID计数器,用于验证setTimeout是否是当前有效的
  const [uploading, setUploading] = useState(false); // 图片上传状态
  // 【多图取消】代次令牌：取消时递增，压缩回调 / 上传队列 / 发送阶段各自校验，不匹配即丢弃回包。
  // 与 ping 页 handleStop、批量诊断面板同思路 —— Taro.request 不可取消，只能丢弃结果。
  const uploadRunIdRef = useRef(0);
  // 当前批次的占位 tempId（供「已上传但决定不发送」的项清场，避免留下无载荷的红色重发壳）
  const activeImageTempIdsRef = useRef<string[]>([]);
  const [uploadSummary, setUploadSummary] = useState(''); // 输入区上方的进度文案（如「上传中 3/9」）
  // 进度条浮在输入行正上方：输入行实测高度约 56px（py-2 + w-9 圆环），用常量而非任意值类名
  const INPUT_ROW_HEIGHT = 56;
  /**
   * 表情面板尺寸（微信原生口径：面板从底部向上展开、**盖住键盘区域**）。
   * ⚠️ 这两个常量必须与 `inputAreaH` 的算式同源，改一处必须改另一处。
   * ⚠️ 面板高度取 240px（约 4 行表情）：微信原生面板约 250px，再高会把消息区压得太窄。
   */
  const EMOJI_PANEL_H = 240;
  /** 面板底部操作栏高度（删除 + 发送），微信原生同样固定在最底部、不随表情列表滚动 */
  const EMOJI_ACTION_BAR_H = 48;
  const [selectMode, setSelectMode] = useState(false); // 长按进入的多选删除模式
  const [selectedIds, setSelectedIds] = useState<string[]>([]); // 已勾选的消息id
  const longPressTimerRef = useRef<any>(null); // 长按计时器
  const pendingLongPressRef = useRef<string | null>(null); // 长按已触发但抬手click未消费的消息id
  const longPressFiredRef = useRef(false); // 本次触摸是否已触发长按
  const [replyTo, setReplyTo] = useState<Message | null>(null); // 正在引用回复的消息
  // 引用定位：点击引用块时把目标消息行 id 交给 ScrollView 的 scroll-into-view，
  // 由小程序原生完成精确滚动（自己按行高累加估算在图片/语音异步撑高时不可靠）。
  const [scrollIntoViewId, setScrollIntoViewId] = useState('');
  // 定位后短暂高亮的消息 id：让用户一眼看到「就是这条」，约 1.6s 后自动褪去
  const [highlightId, setHighlightId] = useState('');
  const highlightTimerRef = useRef<any>(null);
  // 定位期间暂停「新消息自动滚底」跟随，避免刚定位过去就被下一条消息拽回底部
  const locatingRef = useRef(false);
  const [nowTick, setNowTick] = useState(Date.now()); // 每分钟刷新一次,驱动撤回倒计时到期后的菜单项重算
  // 「在线/离线」是时间驱动的（心跳超时即离线），光靠资料更新不够——
  // 每 30 秒 tick 一次，让顶栏绿点与文案在无人改库时也能自动收敛（与会话列表同款机制）。
  const [onlineTick, setOnlineTick] = useState(0);
  // ===== 功能⑥「正在输入…」瞬时信号（不落库，仅 Realtime broadcast）=====
  // 对方是否在输入：由 typing 事件置 true，静默超时/收到消息/离开页面时置 false。
  const [peerTyping, setPeerTyping] = useState(false);
  // 静默到期计时器：超过 TYPING_IDLE_MS 没再收到信号就自动消失
  const typingIdleTimerRef = useRef<any>(null);
  // 已读标记防抖句柄：Realtime 连续收到多条消息时只发一次 markAsRead 请求
  const markAsReadTimerRef = useRef<any>(null);
  // UPDATE 回执批量合并队列：150ms 窗口内的多条回执一次性 setState（模块外无引用需求，页面级即可）
  const updateMergeRef = useRef<Map<string, Message> | null>(null);
  /**
   * where 暗号等待状态（A 端专用）：发出 where 后显示「等待对方回应…」，
   * 超时未收到 ack 则切换为「对方暂未回应，可能不在线」。
   *
   * 【为什么用 state 而不是 ref】它要驱动顶栏渲染，必须触发重绘。
   * 【为什么状态机与文案都在 @/lib/where-status】见该模块注释——三处调用点共用一套口径。
   */
  const [whereWaitStatus, setWhereWaitStatus] = useState<WhereWaitStatus>('idle');
  /** where 等待超时计时器：收到 ack 或离开页面时必须清掉，否则会对已卸载组件 setState */
  const whereWaitTimerRef = useRef<any>(null);
  // 本端发送节流：首次立即发、之后每 TYPING_THROTTLE_MS 最多一条，避免逐字符打广播
  const lastTypingSentAtRef = useRef(0);
  // channel 引用：broadcast 需要在订阅后的同一 channel 上 emit
  const chatChannelRef = useRef<any>(null);
  // peerId 引用：typing 回调里判断事件来源是不是本会话对方（闭包内 peerId 可能滞后）
  const peerIdRef = useRef<string | null>(null);
  // 全局资料 store：页面不再私有维护 participantMap，所有头像/昵称统一从 byId 派生。
  // byId 在 store 创建时已同步读本地缓存 → 冷启动第一帧内存里就有资料，无需等 auth。
  const profileById = useProfilesStore((s) => s.byId);
  const ensureProfiles = useProfilesStore((s) => s.ensure);
  // 功能⑤：profiles Realtime 事件到达即回源拉对方资料，让顶栏在线状态即时重算
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  // 「对方在我离开聊天区期间登录了几次 + 最后登录详细时间」——按需查询，不进全局 store。
  const [peerLoginStats, setPeerLoginStats] = useState<PeerLoginStats | null>(null);
  // 统计窗口：上次退回 ping 页 → 本次暗号进入聊天页，供「登录明细」弹层标注区间
  const [loginWindow, setLoginWindow] = useState<LoginWindow>({ fromAt: null, toAt: null });
  // 顶栏「明细」按钮打开的登录记录弹层开关
  const [loginDetailOpen, setLoginDetailOpen] = useState(false);
  /** 步数对比弹层开关：由顶栏「脚印」图标打开（对比对象固定为当前会话好友） */
  const [stepsCardOpen, setStepsCardOpen] = useState(false);
  // 统计重算触发器：窗口锚点（退场/进入时刻）与对方登录事件都是本地/远端时间驱动，
  // 需要在线绿点之外的独立 tick 才能把「TA 又登录了」刷出来。
  const [statsTick, setStatsTick] = useState(0);
  // 会话参与者 id（自己 + 对方）：进页先拉会话行确定双方 id，再按 id 从全局 store 取资料
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  // 头像图片加载失败的发送者 id：失败后回退昵称首字占位，避免空白圆/布局跳动
  const [avatarErrorIds, setAvatarErrorIds] = useState<Set<string>>(new Set());
  // 图片消息加载失败的 message id：失败后气泡内显示「图片加载失败」占位块
  const [imgErrorIds, setImgErrorIds] = useState<Set<string>>(new Set());
  // H5 端图片放大查看器（Taro.previewImage 仅小程序支持，H5 降级为页面内遮罩弹层）。
  // urls 是本会话全部图片消息的 url 快照，index 为当前张——支持左右滑动翻看多图。
  const [zoomViewer, setZoomViewer] = useState<{ urls: string[]; index: number } | null>(null);
  // 长按图片消息时暂存其 media_url，供操作菜单「发送图片给朋友」转发用
  const longPressImageUrlRef = useRef('');
  /** 「发送我的位置」进行中：防止连点重复发出多条位置消息 */
  const [sendingMyLocation, setSendingMyLocation] = useState(false);
  /**
   * 进入本页时自动获取到的当前位置（用于「发送我的位置」）。
   * null = 尚未拿到 / 拿不到（未授权、定位关闭、H5 预览）。
   * ⚠️ 只存内存不落 storage：位置是敏感信息，且每次进页面都应重新取，缓存旧坐标会误导用户。
   */
  const [currentLocation, setCurrentLocation] = useState<LocationPayload | null>(null);
  /** 自动定位是否已跑完（无论成功失败）。用于区分「还在定位」与「定位失败」，避免按钮文案闪烁 */
  const [locationResolved, setLocationResolved] = useState(false);
  /**
   * where 指令自动回发位置是否进行中。
   * ⚠️ 与 sendingMyLocation 分开：那个是「用户点按钮」的态，这个是「对方发 where」触发的态，
   *    两者共用同一个 ref 会让按钮在自动回发期间也变灰，用户以为按钮坏了。
   */
  const autoWhereSendingRef = useRef(false);
  /**
   * 离线补发暗号是否进行中（B 下次进页时补发最近一次位置）。
   * ⚠️ 与 autoWhereSendingRef 分开：那个是「实时收到 where」的态，这个是「进页补发」的态，
   *    两者可能在同一时刻竞争（进页补发还没跑完，对方又发来一条 where），
   *    共用一个 ref 会让后到的实时 where 被误判成「正在回发中」而静默丢弃。
   */
  const pendingWhereReplyRef = useRef(false);

  // 自定义导航栏(去掉原生返回键)后,顶部需留出状态栏高度,避免内容被刘海/状态栏遮挡
  const statusBarHeight = getWindowInfo().statusBarHeight || 0;

  // 胶囊右留白：navigationStyle custom 后顶栏右侧元素会被微信原生胶囊按钮（···/○）盖住，
  // 必须按胶囊实际位置让位。留白 = 屏宽 - 胶囊左缘 + 8px，保证右侧图标落在胶囊左侧可点区。
  // ⚠️ getMenuButtonBoundingClientRect 在 H5 预览会 reject Promise（errMsg: 暂时不支持 API），
  //    同步 try-catch 捕不到 → 会泄漏成 "Uncaught Object"；故仅在微信端调用，H5 回退 96px。
  // ⚠️ 与 chats / batch-diag 两页同款实现（项目未抽公共函数，三处保持一致）。
  const isWeappEnv = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  const [capsuleRightPadding, setCapsuleRightPadding] = useState(96);
  useEffect(() => {
    if (!isWeappEnv) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect();
      const winW = getWindowInfo().windowWidth;
      if (rect && typeof rect.left === 'number' && rect.left > 0 && winW > 0) {
        setCapsuleRightPadding(Math.round(winW - rect.left + 8));
      }
    } catch (e) {
      logDbg('[chat] getMenuButtonBoundingClientRect 异常，回退固定留白');
    }
  }, [isWeappEnv]);
  logDbg('[chat] custom 导航栏生效，状态栏高度:', statusBarHeight, '胶囊右留白:', capsuleRightPadding);

  // 在线状态自驱动计时器：页面挂载期间每 30 秒 tick 一次（与会话列表同款）。
  // 功能⑤后它降级为**事件通道不可用时的兜底**——profiles Realtime 事件已能即时重算，
  // 但心跳超时这类「时间本身流逝」造成的状态变化没有任何事件，仍必须靠 tick 收敛。
  //
  // ⚠️ 缺陷④（用户三次报「最后活跃时间还是不对」的最终根因）：
  // tick 只让组件重渲染，**不会重新拉数据**——它拿的还是 profiles-store 里那份旧资料。
  // 而本页此前**只在 Realtime profiles UPDATE 事件到达时**才 refreshProfiles，
  // 一旦事件通道不可用（小程序 realtime 断连很常见），对方心跳每 45 秒刷新的
  // last_active_at 就永远进不了本端内存，「最后活跃」于是永久停在进页那一刻。
  // 修复：tick 里顺带强制重拉一次对方资料（单行查询，代价极小），
  // 让「时间流逝」本身也能驱动数据更新，不再单点依赖事件通道。
  useEffect(() => {
    const t = setInterval(() => {
      setOnlineTick((n) => n + 1);
      const pid = peerIdRef.current;
      if (pid) {
        logDbg('[chat] 🔄 30s tick 强制重拉对方资料（兜底 Realtime 事件通道不可用）');
        void refreshProfiles([pid]);
      }
    }, 30_000);
    return () => clearInterval(t);
  }, [refreshProfiles]);

  // 对方资料：从「本会话参与者 id」中排除自己后取。
  // 解析条件放宽为「user 或 会话行 任一就绪」即可 —— 不再等 auth loaded，
  // 这是此前几轮补了缓存写入点却仍不秒出的主因：数据已在内存却被登录态门控挡住渲染。
  // 冷启动秒出兜底：auth 尚未就绪时，若本地缓存里已有除「过渡自己」之外的资料，
  // 直接把它当对方 id 驱动头像/昵称渲染（消息快照行也能立即挂上头像）。
  const earlyPeerId = !loaded && user ? Object.keys(profileById).find((id) => id !== user.id) : undefined;
  // 渲染期日志：每帧都会触发，必须走 logDbg（生产静默），否则刷屏淹没关键链路
  if (earlyPeerId) logDbg(`[chat] ⚡ auth 未就绪，先用本地缓存资料秒出对方头像: ${earlyPeerId}`);
  const peerId = participantIds.find((id) => id !== user?.id) || earlyPeerId;
  // 功能⑥：broadcast 回调在 useEffect 闭包里执行，peerId 每次渲染都变，
  // 用 ref 镜像最新值供回调判断「事件来源是否本会话对方」。
  peerIdRef.current = peerId ?? null;
  const peerProfile = peerId ? profileById[peerId] ?? null : null;
  const displayPeerName =
    peerProfile?.nickname || peerProfile?.username || peerName;

  // 丰富表情列表(120个常用表情)
  // ⚠️ 必须 useMemo：本页每次 tick（在线状态 30s / 统计 30s / 撤回倒计时 60s）都会重渲染，
  //    若每次重建这个 120 项数组，表情面板的 map 会拿到全新引用、整块重绘。
  const emojis = useMemo(() => [
    // 笑脸系列
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
    '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
    '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
    '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
    '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
    '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓',
    // 手势系列
    '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
    '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
    '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
    '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂',
    // 爱心系列
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
    '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️',
    // 动物系列
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
    '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆',
    // 食物系列
    '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈',
    '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦',
    // 庆祝系列
    '🎉', '🎊', '🎈', '🎁', '🎀', '🎗️', '🎟️', '🎫', '🎖️', '🏆',
    '🏅', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '⚾', '🥎', '🎾',
    // 其他常用
    '🔥', '💯', '✨', '⭐', '🌟', '💫', '💥', '💢', '💦', '💨',
    '🕳️', '💣', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤', '👋🏻', '👋🏼',
  ], []);

  // 当 loaded 和 user 都就绪后,自动加载消息
  useEffect(() => {
    if (loaded && user && conversationId) {
      logDbg('[chat] 页面加载完成,conversationId:', conversationId);
      fetchMessages(conversationId);
      // 进入聊天页后,将对方发来的历史消息标记为已读
      markAsRead(conversationId);
    } else {
      logDbg('[chat] 等待加载... loaded:', loaded, 'user:', !!user, 'conversationId:', conversationId);
    }
  }, [loaded, user, conversationId]);

  // 进入页面先用本地缓存快照渲染首屏（秒开），服务端数据由上方 effect 后台刷新覆盖
  useEffect(() => {
    if (!conversationId) return;
    logDbg('[chat] ⚡ 尝试恢复消息缓存快照');
    restoreFromCache(conversationId);
  }, [conversationId, restoreFromCache]);

  // 拉取「对方在我离开聊天区期间登录了几次 + 最后登录详细时间」。
  // 门控 loaded && !bootstrapped：过渡 user 无 token，login_events 查询会被 RLS 当匿名挡掉。
  // 统计窗口 = [上次退回 ping 页时刻, 本次暗号进入时刻]（两个锚点都存在本地 Storage）：
  // - fromAt 为空（首次使用/清缓存）→ 不设下限，退化为全部历史；
  // - toAt 为空（暗号打点已被计数消费或超 5 分钟时效）→ 不设上限，等价于「到现在为止」。
  // ⚠️ 不再依赖 profiles.last_seen_boundary_at：那是「本次登录之后」的口径，与用户要的
  //    「我离开这段时间 TA 登录了几次」完全不同。
  // statsTick 每 30 秒重算一次：停留期间对方新登录时，recentLoggedAt 会变化，
  // 顶栏据此从「登录 N 次」切换成「已在线」。
  useEffect(() => {
    if (!loaded || bootstrapped || !user?.id || !peerId) {
      setPeerLoginStats(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const fromAt = toIso(readChatExit(user.id));
      const toAt = toIso(readSecretEntry());
      const win: LoginWindow = { fromAt, toAt };
      const stats = await fetchPeerLoginStats(peerId, win);
      logDbg(`[chat] 📊 登录统计窗口 ${fromAt ?? '-'} ~ ${toAt ?? '-'} count=${stats?.count ?? 0} last=${stats?.lastLoggedAt ?? '-'} recent=${stats?.recentLoggedAt ?? '-'} 明细 ${(stats?.loggedAts ?? []).length} 条`);
      if (cancelled) return;
      setPeerLoginStats(stats);
      setLoginWindow(win);
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, bootstrapped, user?.id, peerId, statsTick]);

  // 统计重算计时器：页面挂载期间每 30 秒 tick 一次（与在线绿点同款机制），
  // 让「TA 在我停留期间又登录了」能在下一次 tick 被感知并切成「已在线」。
  useEffect(() => {
    const t = setInterval(() => setStatsTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // 拉取会话参与者 id（自己 + 对方）→ 交全局 store 确保资料。
  // getConversation 走 PostgREST，conversations 的 RLS 要求 auth.uid() 匹配；
  // 但「过渡 user」（本地缓存恢复）没有 token，匿名请求会被过滤成空行 → conv=null →
  // 整条资料链路静默中断——这正是「[chat] ⚡ 参与者资料就绪」从未出现在预览日志里的根因。
  // 解法：bootstrapped 期间跳过真实请求（等 auth 真值），资料靠本地缓存 + 消息快照兜底秒出；
  // auth 就绪后（loaded && !bootstrapped）本 effect 重新触发，补一次带登录态的校验。
  // 会话有效性自愈：auth 真值就绪后确认 conversations 行仍存在且属于本人。
  // 双向软删除语义下有两种「不可用」，处理方式完全不同：
  // ① 会话行彻底不存在（双方都删过 → 服务端已清理）：带着旧 conversationId 发消息
  //    必撞 messages 的 INSERT RLS → 403，必须清脏缓存并退回列表。
  // ② 会话行还在、但本人已标记删除（单方删除）：数据仍属于对方，本视图不该再看它，
  //    同样退回列表，但提示语要说「你已删除该会话」而不是「会话已删除」。
  const handleConversationGone = async (reason: string, toastTitle: string) => {
    console.warn(`[chat] 🗑️ 会话不可用(${reason})，清理本地脏缓存并返回会话列表, conversationId:`, conversationId);
    if (user?.id && conversationId) {
      try {
        Taro.removeStorageSync(msgCacheKeyOf(user.id, conversationId));
        logDbg('[chat] 🧹 已清除失效会话的消息快照缓存:', conversationId);
      } catch (e) {
        console.warn('[chat] 清理消息快照缓存失败:', e);
      }
    }
    useChatsStore.getState().fetchConversations();
    Taro.showToast({ title: toastTitle, icon: 'none', duration: 1500 });
    // ⚠️ 缺陷⑧（用户报「第一次会提醒已删除信息并闪退」的根因，勿再只写 navigateBack）：
    //    旧实现是 `Taro.navigateBack().catch(() => reLaunch(...))`。但 navigateBack 在
    //    **页面栈只有一层**时（用户从 ping 页暗号 reLaunch 进聊天区、或列表页被回收后
    //    直接进 chat 页）会**同步抛错**而不是返回 rejected Promise —— `.catch` 捕不到，
    //    异常冒到 Taro 的导航层就是「闪退」。而且即便捕到了，navigateBack 失败时页面
    //    已经处于半销毁状态，再 reLaunch 也容易白屏。
    //    正解：先查页面栈，栈深 > 1 才 navigateBack，否则直接 reLaunch 回列表；
    //    整段包 try-catch 兜底，任何导航异常都降级为 reLaunch，绝不让异常冒出去。
    setTimeout(() => {
      try {
        const stack = Taro.getCurrentPages();
        if (stack.length > 1) {
          logDbg(`[chat] ↩️ 会话不可用，页面栈深 ${stack.length}，navigateBack 回列表`);
          Taro.navigateBack();
        } else {
          logDbg('[chat] 🚪 会话不可用且页面栈仅 1 层，reLaunch 回列表（navigateBack 会抛错导致闪退）');
          Taro.reLaunch({ url: '/pages/chats/index' });
        }
      } catch (e) {
        console.warn('[chat] ⚠️ 会话不可用后的导航异常，降级 reLaunch 回列表:', e);
        try {
          Taro.reLaunch({ url: '/pages/chats/index' });
        } catch (e2) {
          console.error('[chat] ❌ 降级 reLaunch 也失败:', e2);
        }
      }
    }, 800);
  };

  useEffect(() => {
    if (!conversationId || !loaded) return;
    if (bootstrapped) {
      logDbg('[chat] ⏸️ auth 仍为本地缓存过渡态，跳过 getConversation（防匿名被 RLS 挡），资料走缓存秒出');
      return;
    }
    let cancelled = false;
    const t0 = Date.now();
    (async () => {
      try {
        const { exists, deletedByMe, conversation: conv } = await conversationsApi.ensureConversationExists(
          conversationId,
          user!.id,
        );
        if (cancelled) return;
        if (!conv) {
          console.warn('[chat] ⚠️ getConversation 返回空，无法确定参与者（检查登录态/RLS）, conversationId:', conversationId);
          await handleConversationGone('会话行已被双方彻底清理', '该会话已删除');
          return;
        }
        if (!exists) {
          await handleConversationGone('会话不含当前用户', '该会话已删除');
          return;
        }
        if (deletedByMe) {
          logDbg('[chat] 🙈 该会话已被本人删除（对方仍保留），本视图不应继续展示:', conversationId);
          await handleConversationGone('本人已删除该会话', '你已删除该会话');
          return;
        }
        const ids = Array.from(new Set([user?.id, conv.user1_id, conv.user2_id].filter(Boolean) as string[]));
        setParticipantIds(ids);
        await ensureProfiles(ids);
        if (!cancelled) {
          logDbg(`[chat] ⚡ 参与者资料就绪(${ids.length} 人)，耗时 ${Date.now() - t0}ms`);
        }
      } catch (e) {
        console.warn('[chat] 拉取参与者资料失败，头像昵称降级显示:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, loaded, bootstrapped, user?.id, ensureProfiles]);

  // 消息到达后兜底：若有发送者资料尚未入全局 store（如 Realtime 新消息来自陌生 id），补一次
  useEffect(() => {
    if (messages.length === 0) return;
    const ids = Array.from(new Set(messages.map((m) => m.sender_id).filter(Boolean)));
    ensureProfiles(ids);
  }, [messages, ensureProfiles]);

  // 头像解析汇总打点（替代逐条渲染日志，避免刷屏淹没关键信息）
  useEffect(() => {
    if (messages.length === 0) return;
    const ids = Array.from(new Set(messages.map((m) => m.sender_id).filter(Boolean)));
    const hit = ids.filter((id) => profileById[id]).length;
    const withAvatar = ids.filter((id) => profileById[id]?.avatar_url).length;
    logDbg(`[chat] ⚡ 头像解析汇总: ${messages.length} 条消息 / ${ids.length} 个发送者，资料命中 ${hit}，带头像 ${withAvatar}`);
  }, [messages, profileById]);
  // 消息加载完成后,首次进入自动滚动到底部(走统一出口,登记为程序滚动以免污染贴底判定)
  useEffect(() => {
    if (msgLoaded && messages.length > 0) {
      atBottomRef.current = true;
      scrollToLatest(300, '消息加载完成');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgLoaded]);

  // 缓存快照恢复后（auth 尚未就绪的秒开场景）也滚到底部，避免停在顶部
  useEffect(() => {
    if (!loaded && messages.length > 0) {
      atBottomRef.current = true;
      scrollToLatest(200, '缓存快照渲染');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 所有「离开 chat 页」出口的统一收口：只有最新代次实例才允许发起跳转 */
  const exitToPing = (tag: string) => {
    if (genRef.current !== getLatestGeneration()) {
      logDbg(`[chat] 🛑 [GUARD_STALE] ${tag} 但本实例代次(${genRef.current})已过期, 忽略跳转`);
      return;
    }
    logDbg(`[chat] 🚪 [${tag}] 废弃计时, reLaunch 回 ping 页`);
    markChatExit(); // 打退场点：下一次进入聊天页的登录统计窗口从这里起算
    reportPresence('offline'); // 退回 ping 页 = 不在线（必须在 reLaunch 前发起）
    abandonGuard();
    Taro.reLaunch({ url: '/pages/ping/index' });
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    const timeStr = new Date().toLocaleTimeString();
    // ① resolveEntryMode 一次性完成「栈顶前台校验 + didHide/onAppHide 配对判定」。
    //    ⚠️ 原实现在 setInterval tick 里读存储的「当前活跃页」判归属——微信切后台会冻结
    //    JS 定时器，回前台瞬间挂起的 tick 抢在 didShow 前补跑，读到旧值就把计时器 clear
    //    掉，导致「停在页面不操作也永不跳转」（本次 bug 根因）。
    const entry = resolveEntryMode(PAGE_ROUTE);
    if (entry.mode === 'stale') {
      logDbg(`[chat] 👻 [GUARD_STALE] [${timeStr}] didShow 但栈顶非本页(旧实例补触发), 忽略本次生命周期`);
      return;
    }
    genRef.current = entry.mode === 'resume' ? retainGeneration(PAGE_ROUTE) : claimFreshEntry(PAGE_ROUTE);
    clearBackgroundNote();

    // ② 兜底拦截：遮挡未解除期间(如点原生返回键/右滑)落到本页，立即弹回被遮挡页
    if (isShieldArmed() && getArmedRoute() !== PAGE_ROUTE) {
      logDbg('[chat] 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
      abandonGuard();
      Taro.reLaunch({ url: '/' + getArmedRoute() });
      return;
    }

    // ③ 计时决策：resume 按已流逝时长补判/续跑；fresh 全新起表 120s
    const elapsed = entry.elapsedMs;
    logDbg(`[chat] 🧭 [${timeStr}] didShow — mode:`, entry.mode, '| 已流逝(s):', Math.floor(elapsed / 1000), '| 代次:', genRef.current);
    if (entry.mode === 'resume') {
      if (elapsed >= 120000) {
        logDbg(`[chat] 🔙 后台切回补判已超时(${Math.floor(elapsed / 1000)}秒)`);
        exitToPing('EXIT_RESUME');
        return;
      }
      resumeGuard(genRef.current);
    } else {
      startGuard({ pageRoute: PAGE_ROUTE, generation: genRef.current, onTimeout: () => exitToPing('EXIT_TICK') });
      // 首次进入且有消息时,自动滚动到底部(走统一出口,登记为程序滚动以免污染贴底判定)
      if (messages.length > 0) {
        atBottomRef.current = true;
        scrollToLatest(500, '首次进入');
      }
    }

    if (!conversationId) return;

    // ④ 在场状态：停留在聊天页 = 在线。必须在 stale/遮挡弹回分支 return 之后，
    //    否则旧实例补触发会把状态覆盖成错的。
    reportPresence('online');
    // 缺陷②：进入聊天区也是补发未送达 offline 的时机（网络可能已恢复）
    void flushPendingPresence();

    // ⑤ 自动获取当前位置：每次进入本页都重新取一次（用户可能已经移动了位置）。
    //    放在所有 return 分支之后，保证 stale 实例不会触发定位。
    //    ⚠️ 不 await（生命周期回调不能 async），失败静默由函数内部处理。
    void autoFetchCurrentLocation();

    // ⑥ 离线补发暗号：B 不在线时收到的 where，在本次进页时补发最近一次位置。
    //    与 ⑤ 并行发出（互不依赖）：补发优先用本地存储的位置，定位只是兜底。
    //    ⚠️ 同样不 await，失败静默。
    void checkAndReplyPendingWhere();

    // ⑦ 进页自愈：补写「对方发来的 where」中尚未隐藏的隐藏行。
    //    实时链路若写失败（网络抖动/请求中断），那条 where 会永久留在 B 的列表里
    //    （handledWhereIds 去重导致不会二次触发），这里兜底保证最终一致。
    void healPeerWhereVisibility();
  });

  // 页面隐藏时:记录 hide 时刻 + 仅停表（保留起点供切回补判）
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    logDbg(`[chat] 👻 [${timeStr}] useDidHide 触发, 记录 hide 时刻 + 仅停表(保留计时起点供切回补判)`);
    // 【返回列表前补写会话摘要】用户点返回键回 chats 页时，本页 hide 先于列表 didShow 触发。
    // 会话摘要（last_message）走的是 1200ms 尾沿合并，若此刻还在窗口内，列表拿到的
    // last_message 仍是上一条 —— 表现为「返回列表看不到刚发的那条，要下拉刷新」。
    // 这里主动 flush 一次：把待提交的摘要立刻写库，让列表 didShow 的查询能读到最新值。
    // 时间戳（last_message_at）已在 updateLastMessage 里立即落库，无需在此重复处理。
    // ⚠️ 不 await（生命周期回调不能 async）：flush 内部会把本次写入登记为模块级句柄，
    //    chats 页的 listConversations 发查询前会 await 它 —— 读请求自动排在写请求之后，
    //    这才是「返回列表看不到最新摘要」的真正修复点（两个请求并发时读常常先返回）。
    void conversationsApi.flushPendingLastMessage();
    // 导航离开或切后台都会触发 hide → 先记「不在当前」；若随后真的退回 ping 页，
    // 各退场出口会用 offline 覆盖（offline 不参与抑制、保证送达）。
    reportPresence('away');
    // 功能⑥：离开页面立刻撤掉「正在输入…」——对方看不到我的输入态了，
    // 留着假指示比没有更糟。
    if (typingIdleTimerRef.current) {
      clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
    setPeerTyping(false);
    // where 等待状态：离开页面即清除。它是「本次会话内的即时反馈」，跨页面保留没有意义；
    // 且不清计时器的话，超时回调会在页面已隐藏时触发 setState。
    clearWhereWait();
    // 记录 hide 时刻：与随后的 App onAppHide 配对，供下次 didShow 区分
    // 「切后台导致的 hide」(保留起点) vs 「导航离开导致的 hide」(作废旧起点)。
    notePageHidden(PAGE_ROUTE);
  });

  // Realtime 订阅对方发来的新消息和已读状态更新
  useEffect(() => {
    if (!conversationId || !user) return;

    const channel = supabase
      .channel('chat:' + conversationId);
    chatChannelRef.current = channel;

    // 必须在 subscribe() 之前注册所有 on() 回调

    // 功能⑥：接收对方的「正在输入」瞬时广播（不落库，仅 broadcast）。
    // ⚠️ 用标准 'broadcast' 事件而非自定义事件名：supabase-wechat-js 的 RealtimeChannel
    //    对未知 type 的 on() 注册行为不可验证，走官方文档明确支持的通道最稳妥。
    //    payload 自带 { name, data, ref }，按 name 过滤即可。
    channel.on('broadcast', { event: 'typing' }, (payload: any) => {
      const data = payload?.data as { from?: string; kind?: string } | undefined;
      const from = data?.from;
      if (!from || from === user.id) return; // 只关心对方，忽略自己/异常来源
      if (from !== peerIdRef.current) return; // 非本会话对方，忽略
      const cur = useProfilesStore.getState().byId[from];
      if (cur?.hide_presence) {
        logDbg('[chat] 🙈 对方已隐藏在场状态，忽略其 typing 广播');
        return;
      }
      // 对方消息已发出 → 立刻撤指示（stop 不受任何门控，优先判定）
      if (data?.kind === 'stop') {
        if (typingIdleTimerRef.current) {
          clearTimeout(typingIdleTimerRef.current);
          typingIdleTimerRef.current = null;
        }
        setPeerTyping(false);
        return;
      }
      logDbg('[chat] ✍️ 收到对方 typing 信号');
      setPeerTyping(true);
      bumpGuard(genRef.current);
      // 重置静默计时：超过窗口没有新信号就自动消失
      if (typingIdleTimerRef.current) clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = setTimeout(() => {
        setPeerTyping(false);
        typingIdleTimerRef.current = null;
      }, TYPING_IDLE_MS);
    });

    // 监听新消息(INSERT)
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + conversationId },
      (payload) => {
        const newMsg = payload.new as Message;
        // 计算从对方发出(created_at服务端时间)到本机收到推送的真实延迟
        const sentAt = new Date(newMsg.created_at).getTime();
        const latencyMs = Date.now() - sentAt;
        logDbg('[chat] ⚡ Realtime收到INSERT事件:', newMsg.id, '发送者:', newMsg.sender_id === user.id ? '自己' : '对方', '推送延迟(ms):', latencyMs);
        if (newMsg.sender_id !== user.id) {
          lastPeerMsgAtRef.current = Math.max(lastPeerMsgAtRef.current, sentAt);
          receiveMessage(newMsg);
          // 收到对方消息后自动标记为已读。
          // ⚡ 性能修复：markAsRead 是一次 PostgREST UPDATE（200-500ms 网络往返），
          // 此前同步 await 在 Realtime 回调里会拖慢同批后续事件的处理。
          // 改为 500ms 防抖 + 不等待：连续多条消息只发一次已读请求，渲染链路零阻塞。
          // 500ms 延迟对「已读」语义无感（对方看到双勾最多晚半秒）。
          if (markAsReadTimerRef.current) clearTimeout(markAsReadTimerRef.current);
          markAsReadTimerRef.current = setTimeout(() => {
            markAsReadTimerRef.current = null;
            void markAsRead(conversationId);
          }, 500);
          // 功能⑥：消息发出即代表输入结束，立刻撤掉「正在输入…」并取消静默计时
          if (typingIdleTimerRef.current) {
            clearTimeout(typingIdleTimerRef.current);
            typingIdleTimerRef.current = null;
          }
          setPeerTyping(false);
          // where 指令：对方发来纯文本 where → 自动把当前位置发回去（内部自带去重与防重入）
          if (isWhereCommand(newMsg)) {
            void handleWhereCommand(newMsg);
          } else if (isWhereAck(newMsg)) {
            // 暗号回执：B 已回发位置，本端（A）把那条 where 隐藏掉
            void handleWhereAck(newMsg);
          }
        }
      },
    );

    // 监听消息更新(UPDATE) - 用于同步送达/已读/撤回状态
    //
    // ⚠️ 缺陷⑤（用户报「对方不在的情况下切换下页面也会变为已读」的根因，勿再删掉 sender 过滤）：
    // 本端进页 / 收到对方新消息时会调 markAsRead → UPDATE 对方消息的 read_at，
    // 而 Realtime 订阅的是**整个会话**的 UPDATE（filter 只有 conversation_id），
    // 本端自己发起的这次 UPDATE 也会被推回来（回环）。旧版回调**无条件**把
    // payload.new 的 read_at 写进本地行，于是「我发的消息」被自己标记已读的
    // 那次 UPDATE 顺带污染成双勾——对方根本没在线，却显示已读。
    // 修复：只同步**对方发来的**消息（我的消息的回执由轮询 listMyChangedMessages 负责，
    // 那条路径按 id 精确匹配、且只查 sender_id=自己，天然无回环）。
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + conversationId },
      (payload) => {
        const updatedMsg = payload.new as Message;
        // 回环拦截：自己发的消息的 UPDATE 事件一律忽略（含本端 markAsRead 触发的回环）
        if (updatedMsg.sender_id === user.id) {
          logDbg('[chat] ↩️ 忽略自己消息的 UPDATE 事件(防已读回环):', updatedMsg.id);
          return;
        }
        logDbg('[chat] 收到消息更新事件:', updatedMsg.id, 'delivered_at:', updatedMsg.delivered_at, 'read_at:', updatedMsg.read_at, 'revoked_at:', updatedMsg.revoked_at);
        // ⚡ 批量合并：对方批量已读时会连续收到多条 UPDATE，逐条 setState 会触发
        // 同等次数的全量 map 遍历 + 重渲染。150ms 窗口内的事件合并成一次批量更新。
        const pending = updateMergeRef.current;
        if (pending) {
          pending.set(updatedMsg.id, updatedMsg); // 后到覆盖先到（同 id 取最新状态）
          return;
        }
        updateMergeRef.current = new Map([[updatedMsg.id, updatedMsg]]);
        setTimeout(() => {
          const batch = updateMergeRef.current;
          updateMergeRef.current = null;
          if (!batch || batch.size === 0) return;
          useMessagesStore.setState((state) => ({
            messages: state.messages.map((m) => {
              const upd = batch.get(m.id);
              return upd
                ? { ...m, delivered_at: upd.delivered_at, read_at: upd.read_at, revoked_at: upd.revoked_at }
                : m;
            }),
          }));
        }, 150);
      },
    );

    // 功能⑤：对方资料变更（在场状态/心跳/隐藏开关）即时重算顶栏状态。
    // ⚠️ 事件只当触发器，绝不直接吃 payload.new 的字段 patch UI——profiles 是宽表，
    //    WAL REPLICA IDENTITY 下 new 行可能缺列，必须回源拉真值。
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'profiles' },
      (payload) => {
        const changedId = (payload?.new as { id?: string } | undefined)?.id;
        if (!changedId || changedId !== peerIdRef.current) return; // 非本会话对方，忽略
        void refreshProfiles([changedId]);
      },
    );

    // 最后才调用 subscribe(),并监听订阅状态
    channel.subscribe((status) => {
      logDbg('[chat] Realtime订阅状态:', status);
      if (status === 'SUBSCRIBED') {
        logDbg('[chat] ✅ Realtime订阅成功,可以实时接收消息');
        realtimeConnectedRef.current = true;
        // Realtime成功后,停止轮询(如果正在轮询)
        if (pollingTimerRef.current) {
          clearInterval(pollingTimerRef.current);
          pollingTimerRef.current = null;
          logDbg('[chat] Realtime已连接,停止轮询');
        }
        // 补拉一次:订阅建立前一刻发出的消息可能错过事件,立即对齐最新列表
        fetchMessages(conversationId);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[chat] ⚠️ Realtime订阅失败:', status, '- 启动轮询降级方案');
        realtimeConnectedRef.current = false;
        // Realtime失败时,启动轮询
        startPolling();
      }
    });

    return () => {
      channel.unsubscribe();
      chatChannelRef.current = null;
      reset();
      // 功能⑥：离开页面清掉 typing 状态与静默计时，避免下次进页残留假指示
      if (typingIdleTimerRef.current) {
        clearTimeout(typingIdleTimerRef.current);
        typingIdleTimerRef.current = null;
      }
      setPeerTyping(false);
      // where 等待状态同理：清状态 + 清计时器，避免下次进页残留「等待对方回应…」
      clearWhereWait();
      // 清理轮询
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [conversationId, user]);

  // ===== 功能⑥：本端 typing 广播（不落库的瞬时信号）=====
  /**
   * kind='start' 受节流与「本人隐藏在场状态」门控；kind='stop' 必须无视两者——
   * 消息已发出却漏撤指示会让对方长时间挂着假的红点/文案。
   */
  const sendTypingSignal = (kind: 'start' | 'stop') => {
    const ch = chatChannelRef.current;
    const uid = user?.id;
    if (!ch || !uid || !realtimeConnectedRef.current) return; // 通道不可用时静默跳过
    const now = Date.now();
    if (kind === 'start') {
      if (profileById[uid]?.hide_presence) return;
      if (now - lastTypingSentAtRef.current < TYPING_THROTTLE_MS) return;
      lastTypingSentAtRef.current = now;
    } else {
      lastTypingSentAtRef.current = 0; // 发送后重置节流窗口，下一条消息可立即再报
    }
    try {
      void ch.send({
        type: 'broadcast',
        event: 'typing',
        payload: { from: uid, kind, at: now },
      });
    } catch (e) {
      console.warn('[chat] typing 广播发送失败(不影响使用):', e);
    }
  };

  const notifyPeerTyping = () => sendTypingSignal('start');

  // 轮询函数:定期检查新消息和已读状态(Realtime降级方案)
  const startPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
    }
    logDbg('[chat] 🔄 启动轮询模式,每1秒增量检查一次新消息和已读状态');
    pollingTimerRef.current = setInterval(async () => {
      if (!conversationId || !user) return;

      try {
        const user_id = useAuthStore.getState().user?.id;
        if (!user_id) return;

        const currentMessages = useMessagesStore.getState().messages;

        // 增量拉取1:对方新消息——以「已知最后一条消息的服务端时间」为游标(而非本地时钟),
        // 避免设备时钟偏差漏拉;结果集极小、单次往返即拿到新消息。
        const lastKnownAt = currentMessages.length > 0
          ? new Date(currentMessages[currentMessages.length - 1].created_at).getTime()
          : 0;
        const cursor = Math.max(lastKnownAt, lastPeerMsgAtRef.current);
        const peerNew = await messagesApi.listPeerMessagesSince(
          conversationId, user_id, new Date(cursor - 2000).toISOString(),
        );
        logDbg('[chat] 轮询增量拉取完成: 对方新消息', peerNew.length, '条(静态导入模式)');

        if (peerNew.length > 0) {
          const knownIds = new Set(useMessagesStore.getState().messages.map((m) => m.id));
          const fresh = peerNew.filter((m) => !knownIds.has(m.id));
          if (fresh.length > 0) {
            // 计算从对方发出到本机发现的真实延迟(ms),用于评估接收速度
            const firstSentAt = new Date(fresh[0].created_at).getTime();
            logDbg('[chat] 轮询发现对方新消息:', fresh.length, '条, 接收延迟(ms):', Date.now() - firstSentAt);
            fresh.forEach((m) => {
              receiveMessage(m);
              lastPeerMsgAtRef.current = Math.max(lastPeerMsgAtRef.current, new Date(m.created_at).getTime());
              // where 指令：Realtime 不可用时的降级通道同样要生效，否则弱网下 where 会失效
              if (isWhereCommand(m)) {
                void handleWhereCommand(m);
              } else if (isWhereAck(m)) {
                // 暗号回执：降级通道同样要处理，否则弱网下 A 的 where 永远隐藏不掉
                void handleWhereAck(m);
              }
            });
            markAsRead(conversationId);
          }
        }

        // 增量拉取2:自己发出消息的送达/已读/撤回状态变化——只查自己发的、三项回执至少一项非空的行
        const mineChanged = await messagesApi.listMyChangedMessages(conversationId, user_id);
        let hasStatusChange = false;
        const changeMap = new Map(mineChanged.map((m) => [m.id, m]));
        latestLoop: for (const cm of useMessagesStore.getState().messages) {
          if (cm.sender_id === user_id) {
            const remote = changeMap.get(cm.id);
            if (
              remote &&
              (remote.delivered_at !== cm.delivered_at ||
                remote.read_at !== cm.read_at ||
                remote.revoked_at !== cm.revoked_at)
            ) {
              hasStatusChange = true;
              break latestLoop;
            }
          }
        }
        if (hasStatusChange) {
          logDbg('[chat] 轮询检测到送达/已读/撤回状态变化');
          useMessagesStore.setState({
            messages: useMessagesStore.getState().messages.map((m) => {
              const remote = m.sender_id === user_id ? changeMap.get(m.id) : undefined;
              return remote
                ? { ...m, delivered_at: remote.delivered_at, read_at: remote.read_at, revoked_at: remote.revoked_at }
                : m;
            }),
          });
        }
      } catch (e) {
        console.error('[chat] 轮询失败:', e);
      }
    }, 1000); // 每1秒轮询一次
  };

  // ===== 贴底判定(瀑布式跟随的开关) =====
  // atBottomRef:用户当前是否停留在列表底部附近。true=自动跟随滚底;false=正在上滑翻阅历史,暂停跟随。
  // 【为什么不能只看 onScroll】程序化 setScrollTop 同样会触发 onScroll 事件,若只靠事件里
  // 「距底 < 阈值 → 置 true」,则每次自动滚底后都会重新武装跟随——用户明明上滑离开了,
  // 下一条新消息到来仍会被强行拉回底部。故用 scrollArmedRef 区分「滚动由谁发起」:
  // 程序化滚底前置 true,onScroll 命中目标位置时消费掉并跳过本次判定;
  // 未武装的滚动一律视为用户手势,据距底远近切换跟随状态。
  const atBottomRef = useRef(true); // 初始视为在底部(进页即应滚到底)
  const scrollArmedRef = useRef(false); // 最近一次滚动是否由程序化滚底发起
  const lastScrollInfoRef = useRef({ scrollTop: 0, scrollHeight: 0 });
  // ScrollView 可视高度数值(px),与下方 style.height 同款算式;用于 onScroll 里计算「距底」。
  // 【为什么用 windowWidth/750 换算】小程序 rpx 以 750 为设计基准,rpx→px 需按屏宽折算,
  // 否则 px 值会被当成 rpx 使用,阈值判定整体偏移。
  const sysInfo = getWindowInfo();
  const winW = sysInfo.windowWidth || 375;
  const rpx2px = (rpx: number) => (winW / 750) * rpx;
  const navH = statusBarHeight + rpx2px(88); // 顶部导航(状态栏避让 + py-3 上下12px + 图标行高约24px)
  // 底部输入区固定高度(与 ScrollView style.height 的扣减值保持同源:未弹面板时共扣 228px,
  // 其中导航占约 50px、安全区余量占约 48px,故输入区取 130px;表情面板态总扣 278px → 180px)
  // 表情面板态：面板本体 240px + 底部操作栏（删除/发送）48px = 288px。
  // ⚠️ 必须与下方面板渲染块的 `EMOJI_PANEL_H` / `EMOJI_ACTION_BAR_H` 严格同源，
  //    两处不一致会让最新消息被面板遮住或下方留出空白。
  const inputAreaH = showEmojiPanel ? EMOJI_PANEL_H + EMOJI_ACTION_BAR_H : 130;
  const viewportH = Math.max((sysInfo.windowHeight || 667) - keyboardOffset - navH - inputAreaH, 200);

  // 程序化滚底统一出口:递增计数器保证 scrollTop 同值也能触发更新,并登记「本次为程序滚动」
  const scrollToLatest = (delay = 0, tag = '默认') => {
    timerIdCounter.current += 1;
    const newScrollTop = 999999 + timerIdCounter.current;
    scrollArmedRef.current = true;
    const doScroll = () => {
      logDbg(`[chat] ⬇️ [${tag}] 程序化滚底 scrollTop:`, newScrollTop, 'atBottom:', atBottomRef.current);
      setScrollTop(newScrollTop);
    };
    if (delay > 0) setTimeout(doScroll, delay);
    else doScroll();
  };

  // 消息列表变化(新消息到达/发送成功/快照恢复)后自动滚到底部。
  // 【为什么必须加回】此前为防"滚动导致键盘收起"移除了本 effect,副作用是进页与收发消息时
  // 最新消息被输入区遮挡;现输入框走 focus 受控 + adjustPosition=false,程序化 scrollTop
  // 不会触发原生 blur 收键盘,键盘常驻不受影响。
  // 【贴底才跟随】用户上滑翻阅历史(atBottomRef=false)时不打断;回到底部附近后自动恢复。
  useEffect(() => {
    if (messages.length === 0) return;
    // 【历史分页豁免】上滑加载更早消息会让 messages.length 突然变大，但用户此刻在
    // 列表中部翻阅——这不是「新消息到达」，绝不能把它当跟随信号把视图拽回底部。
    // loadingOlder 由 store 在请求前置位、返回后清除，effect 运行时仍能读到真值。
    if (loadingOlderRef.current) {
      logDbg('[chat] ⏸️ 正在加载更早历史,跳过本次自动滚底, count:', messages.length);
      return;
    }
    if (!atBottomRef.current) {
      logDbg('[chat] ⏸️ 用户正在翻阅历史,暂停自动滚底, count:', messages.length);
      return;
    }
    // 双时机补滚:立即一次覆盖纯文本等即时布局,350ms 一次等图片等异步内容撑开高度
    scrollToLatest(0, '消息变化');
    setTimeout(() => scrollToLatest(0, '消息变化·补滚'), 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  // ===== 上滑加载更多历史消息 =====
  // 首屏只拉最近一屏（FIRST_PAGE_SIZE），更早的历史靠列表顶部的「加载更多」按钮按需分页。
  // 用显式点击而非 scrolltoupper 自动触发：自动触发会在用户手势滚动的同一帧 prepend 数据，
  // 列表高度突变导致滚动位置跳动，且会被 onScroll 误判成「回到底部/上翻」扰乱跟随策略。
  // loadingOlderRef 供上方 messages.length effect 识别「这是补历史、不是新消息」，跳过滚底。
  const loadingOlderRef = useRef(false);
  const handleLoadOlder = async () => {
    if (loadingOlder || !hasMoreOlder) return;
    bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
    loadingOlderRef.current = true;
    const beforeCount = messages.length;
    const added = await loadOlderMessages();
    loadingOlderRef.current = false;
    if (added <= 0) return;
    logDbg(`[chat] ⬆️ 已加载更早消息 ${added} 条(${beforeCount} → ${beforeCount + added})`);
    Taro.showToast({ title: `已加载 ${added} 条历史消息`, icon: 'none' });
  };

  // 键盘弹出/表情面板开合会改变 ScrollView 可视高度(见下方 style.height),
  // 变化后补滚一次,保证最新消息不被缩短的可视区遮挡。
  // 【强制跟随】点输入框弹键盘即代表要发言,即使刚在上翻历史也回到最新处,
  // 否则会出现"敲完字看不到自己刚发的消息"。
  useEffect(() => {
    if (messages.length === 0) return;
    atBottomRef.current = true;
    scrollToLatest(320, '可视区变高');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardOffset, showEmojiPanel]);

  const onSendText = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || !conversationId) return;

    try {
      logDbg('[chat] 发送文字消息:', text, replyTo ? '引用消息:' + replyTo.id : '');

      await sendMessage(
        conversationId,
        text,
        'text',
        undefined,
        replyTo ? { id: replyTo.id, content: quoteSummaryRef.current(replyTo) } : undefined,
      );
      logDbg('[chat] 消息发送成功,重置计时器');
      bumpGuard(genRef.current); // 用户操作，重置120秒计时起点

      // where 暗号：A 发出 where 后启动「等待对方回应」状态提示。
      // ⚠️ 必须在 sendMessage **成功之后**才启动：发送失败时 store 已保留红色占位行，
      //    此时显示「等待对方回应」是错的（消息根本没发出去）。
      // ⚠️ 用 isWhereText 判定输入框原文（此时还没有 Message 对象），口径与 isWhereCommand 一致。
      if (isWhereText(text)) {
        startWhereWaitRef.current();
      }

      // 功能⑥：我这条消息已送达，本端「正在输入」语义结束——
      // 广播一条 stop 让对方立刻撤掉指示，不必等它的静默计时到期。
      sendTypingSignal('stop');

      // 清空输入框、引用状态并保持焦点
      setInputValue('');
      setReplyTo(null);
      setInputFocus(true);

      // 滚底双保险:messages.length effect 已覆盖 store 追加路径;
      // 发送即代表要看自己的消息,重置贴底态并延时补滚一次
      atBottomRef.current = true;
      setTimeout(() => scrollToLatest(0, '文字发送后'), 300);
    } catch (err) {
      // 失败时 store 已保留乐观占位并标红 → 输入框内容回填，方便用户直接改后重发或点感叹号重发
      console.error('[chat] 发送文字消息失败:', err);
      setInputValue(text);
      const msg = (err as Error).message || '';
      if (msg.includes('已被删除')) {
        console.warn('[chat] 🚫 文字发送被 messages INSERT RLS 拒绝 → 会话行已不存在（双方均已删除），不再提供重发', conversationId);
        await handleConversationGone('发送被 messages INSERT RLS 拒绝', '该会话已删除');
        return;
      }
      Taro.showToast({ title: msg || '发送失败，点击消息旁的 ! 可重发', icon: 'none' });
    }
  }, [inputValue, conversationId, replyTo, sendMessage, isWhereText, sendTypingSignal]);

  // 引用气泡仅做展示与定位，不改变 ScrollView 高度；点击定位原消息用近似滚动
  const onSendImage = async (url: string) => {
    if (!conversationId) return;
    try {
      await sendMessage(
        conversationId,
        '[图片]',
        'image',
        url,
        replyTo ? { id: replyTo.id, content: quoteSummary(replyTo) } : undefined,
      );
      bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
      setReplyTo(null);
      // 发送后刷新列表(滚底由 messages.length 变化 effect 统一处理)
      await fetchMessages(conversationId);
      logDbg('[chat] 图片消息发送完成,列表已刷新,交由自动滚底 effect 跟随最新消息');
      // 发送后保持焦点
      setInputFocus(true);
    } catch (e) {
      const msg = (e as Error).message || '';
      console.error('[chat] 发送图片消息失败:', msg);
      if (msg.includes('已被删除')) {
        console.warn('[chat] 🚫 图片发送被 messages INSERT RLS 拒绝 → 会话行已不存在（双方均已删除），不再提供重发', conversationId);
        await handleConversationGone('图片发送被 messages INSERT RLS 拒绝', '该会话已删除');
        return;
      }
      Taro.showToast({ title: msg || '发送失败，点击消息旁的 ! 可重发', icon: 'none' });
    }
  };

  /**
   * 批量发送已上传的图片：走 store 的 sendImageBatch（有限并发 + 原位替换）。
   * 【为什么可以并发】占位已由 stageImagePlaceholders 按选图顺序预先排好，
   * 每条落库结果**原位替换**自己那一行，不像 sendMessage 那样追加到末尾，因此不会乱序。
   * 【引用只挂第一张】与微信一致：一次批量属于同一个回复动作。
   * 【单张失败不断链】失败的占位保留标红可单独重发；会话失效则整批终止。
   */
  const sendImagesBatch = async (urls: string[], tempIds: string[]) => {
    if (!conversationId || urls.length === 0) return { sent: 0, failed: 0, gone: false };
    const replyToAll = replyTo ? { id: replyTo.id, content: quoteSummary(replyTo) } : undefined;
    if (replyToAll) setReplyTo(null);

    const r = await sendImageBatch(conversationId, urls, tempIds, replyToAll);
    bumpGuard(genRef.current); // 用户操作，重置120秒计时起点

    atBottomRef.current = true;
    setTimeout(() => scrollToLatest(0, '批量图片发送后'), 300);
    setInputFocus(true);
    logDbg(`[chat] 批量图片发送结束：成功 ${r.sent}/${urls.length}`);
    if (r.conversationGone) {
      await handleConversationGone('图片发送被 messages INSERT RLS 拒绝', '该会话已删除');
      return { sent: r.sent, failed: urls.length - r.sent, gone: true };
    }
    if (r.failedTempIds.length > 0) {
      Taro.showToast({ title: `${r.failedTempIds.length} 张发送失败，点 ! 可重发`, icon: 'none' });
    } else {
      sendTypingSignal('stop'); // 这一批已送达，撤掉对方的「正在输入…」
    }
    return { sent: r.sent, failed: r.failedTempIds.length, gone: false };
  };

  // 初始化录音管理器
  useEffect(() => {
    if (Taro.getEnv() === Taro.ENV_TYPE.WEAPP) {
      recorderManagerRef.current = Taro.getRecorderManager();
      innerAudioContextRef.current = Taro.createInnerAudioContext();

      recorderManagerRef.current.onStop((res: any) => {
        setIsRecording(false);
        setRecordingDuration(0);
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
        }

        // ⚠️ 「无法发送语音」的直接根因之一：部分机型/基础库在极短录音、或录音被系统
        // 打断时 onStop 回包 tempFilePath 为空串。旧代码不做任何校验，直接把空路径丢给
        // 上传函数 → readFile fail → 用户只看到一句「发送失败」。这里显式拦截并给出
        // 可读原因，同时打日志留证。
        const rawPath = typeof res?.tempFilePath === 'string' ? res.tempFilePath : '';
        logDbg(`[chat] 🎙️ 录音结束: path=${rawPath || '(空)'} duration=${res?.duration ?? '?'}ms`);
        if (!rawPath) {
          console.warn('[chat] ⚠️ onStop 未返回音频文件路径，终止发送');
          Taro.showToast({ title: '没录到声音，请按住再说', icon: 'none' });
          return;
        }

        // **以微信实际回包的文件名为准**（决定性一步）：部分安卓机型会**忽略** start 里请求的
        // `format:'m4a'`，回包仍是 xxx.mp3。若继续按启动参数命名成 .m4a，云函数拿到的就是
        // 「扩展名 m4a、内容 mp3」的假 m4a —— 百度识别必然报格式错误，用户永远转不出文字。
        // 取路径末段并剥掉查询串（形如 `http://tmp/xxx.mp3?token=` 时 split('.').pop() 会脏）。
        const baseName = decodeURIComponent(rawPath.split(/[?#]/)[0].split('/').pop() || '');
        const realExt = /\.([a-z0-9]{2,4})$/i.exec(baseName)?.[1]?.toLowerCase() || '';
        const uploadPath = rawPath;
        if (realExt === 'wav' || realExt === 'm4a' || realExt === 'mp3') {
          if (realExt !== recordFormatRef.current) {
            console.warn(
              `[chat] ⚠️ 录音回包实际格式(${realExt})与启动请求(${recordFormatRef.current})不一致，按实际格式命名`,
            );
            recordFormatRef.current = realExt;
          }
        } else if (realExt) {
          // 未知后缀（如部分机型回 .aac/.amr）：保留原判定并打日志，避免把非法扩展名写进存储路径
          console.warn(`[chat] ⚠️ 录音回包后缀(${realExt})不在支持列表，仍按启动格式(${recordFormatRef.current})命名`);
        }

        // 先取走本次录音的免密识别结果（同声传译插件），再交给上传流程。
        // 必须在 handleUploadVoice 之前 finish()：插件 stop 后还会补发最后一包，
        // 但为不阻塞发送我们只取当前累计值——漏掉半句可接受，卡住发送不可接受。
        const asrText = wechatAsrRef.current ? wechatAsrRef.current.finish() : '';
        wechatAsrRef.current = null;

        // 上传语音文件
        handleUploadVoice(uploadPath, res.duration ?? 0, asrText);
      });

      recorderManagerRef.current.onError((err: any) => {
        const errMsg = String(err?.errMsg || err?.message || err || '');
        console.error(`[chat] ❌ 录音错误: ${errMsg}`);
        setIsRecording(false);
        setRecordingDuration(0);
        // 录音失败时同步撤掉识别会话，避免残留句柄把上一句文本误配到下一条消息
        if (wechatAsrRef.current) {
          wechatAsrRef.current.finish();
          wechatAsrRef.current = null;
        }
        // 安全隐藏loading(可能未显示)
        try { Taro.hideLoading(); } catch {}
        // 机型兼容：部分基础库不支持当前请求的编码（start 不抛异常、只在录音阶段报
        // invalid format）。按 wav → m4a → mp3 逐级降档，用户重新按住即可。
        // ⚠️ 必须用 ref 而不是闭包变量——onError 只注册一次，闭包里的标记不会随新录音重置。
        // 已到最低档 mp3 还报错就是真故障，不再误导用户「换个格式试试」。
        const TIERS: Array<'wav' | 'm4a' | 'mp3'> = ['wav', 'm4a', 'mp3'];
        const curIdx = TIERS.indexOf(recordFormatRef.current);
        if (/format|codec|m4a|wav/i.test(errMsg) && curIdx >= 0 && curIdx < TIERS.length - 1) {
          const nextFmt = TIERS[curIdx + 1];
          formatTierRef.current = curIdx + 1;
          console.warn(`[chat] 🎙️ 本机不支持 ${recordFormatRef.current} 录音，后续改用 ${nextFmt}（mp3 仅影响转文字，不影响发送）`);
          Taro.showToast({ title: `本机型不支持该音频格式，已切换，请重新按住录音`, icon: 'none', duration: 2500 });
          return;
        }
        Taro.showToast({ title: '录音失败', icon: 'none' });
      });
    }

    return () => {
      if (innerAudioContextRef.current) {
        innerAudioContextRef.current.destroy();
      }
    };
  }, []);

  const handleUploadVoice = async (tempFilePath: string, duration: number, asrText = '') => {
    if (!conversationId) return;
    // 本次语音在列表里的消息 id：识别文本要按它落本机缓存，供「转文字」秒开。
    // 走 store 返回值拿不到（sendMessage 在 store 内部生成 tempId），故发送后从 messages 里
    // 按 media_url 反查——上传成功即 publicUrl 唯一，不会撞车。
    let voiceMediaUrl = '';
    try {
      Taro.showLoading({ title: '发送中...' });

      // 构造 MiniProgramFileInput 对象。**扩展名/MIME 必须跟真实录音格式一致**：
      // 存储路径按 name 的扩展名生成，云函数 handleAsr 也据此（并结合字节嗅探）判定百度识别的
      // format 字段（百度只接受 pcm/wav/amr/m4a）。硬编码会与「onError 降级 mp3」「机型忽略
      // format 请求」冲突——把 mp3 存成 .m4a 后播放与识别都因容器/编码不符而失败。
      // 扩展名取 recordFormatRef：onStop 已用**微信实际回包的文件名**校正过它（部分安卓机型会
      // 忽略 start 请求的 m4a、实际回 mp3），所以这里就是本次音频的真实容器。
      // 不在此处再从 tempFilePath 反解后缀：路径可能带查询串，split('.').pop() 会得到脏后缀。
      const realExt = recordFormatRef.current; // 'wav' | 'm4a' | 'mp3'（已按实际回包校正）
      if (!tempFilePath.toLowerCase().split(/[?#]/)[0].endsWith(`.${realExt}`)) {
        console.warn(`[chat] ⚠️ 录音回包路径与期望格式(${realExt})不匹配，仍按已校正格式命名: ${tempFilePath}`);
      }
      const audioMime = realExt === 'mp3' ? 'audio/mpeg' : realExt === 'wav' ? 'audio/wav' : 'audio/mp4';
      const file = {
        name: `voice-${Date.now()}.${realExt}`,
        type: audioMime,
        size: 0, // 小程序环境不需要 size
        tempFilePath,
      };

      // 使用统一的上传函数(自动处理小程序/Web环境)
      logDbg(`[chat] 🎙️ 语音开始上传: file=${file.name} mime=${file.type} src=${tempFilePath}`);
      const result = await uploadToSupabase(file, { bucket: 'chat-media' });

      if (!result.success) {
        console.error(`[chat] ❌ 语音上传失败: ${String(result.error)} path=${file.name}`);
        throw new Error(result.error || '上传失败');
      }
      logDbg(`[chat] ✅ 语音已存入 chat-media: ${String(result.data?.path)}`);

      // 获取公开 URL
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${result.data.path}`;
      voiceMediaUrl = publicUrl;

      // 发送消息
      await sendMessage(conversationId, `[${Math.ceil(duration / 1000)}s]`, 'voice', publicUrl);
      bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
      // 发送后刷新列表(滚底由 messages.length 变化 effect 统一处理)
      await fetchMessages(conversationId);
      logDbg('[chat] 语音消息发送完成,列表已刷新,交由自动滚底 effect 跟随最新消息');

      // 免密通道（微信同声传译）的识别结果：只写本机缓存，绝不进 messages.content。
      // 放在刷新之后，此时真实消息行已入库、能按 media_url 反查到服务端 id。
      if (asrText && user?.id && voiceMediaUrl) {
        const row = useMessagesStore.getState().messages.find((m) => m.media_url === voiceMediaUrl);
        if (row) {
          writeTranscript(user.id, row.id, asrText);
          setTranscripts((prev) => ({ ...prev, [row.id]: asrText }));
          // 默认展开：用户刚录完，最想知道转得对不对，收起反而要再点一次。
          // ⚠️ 这里**不写展开记忆**（remember=false）——系统行为不是用户偏好，
          //    否则下次进会话会把这条莫名恢复成展开态，与「折叠记忆」语义冲突。
          setExpandedTranscripts((prev) => new Set(prev).add(row.id));
          logDbg(`[chat] 🎙️ 录音期免密识别已落缓存: ${asrText.length} 字`);
        } else {
          console.warn('[chat] ⚠️ 免密识别结果未能匹配到消息行，丢弃（不影响语音已发送）');
        }
      }

      Taro.hideLoading();
      Taro.showToast({ title: '发送成功', icon: 'success' });
      // 发送后保持焦点
      setInputFocus(true);
    } catch (e: any) {
      console.error('上传语音失败:', e);
      // 安全隐藏loading(可能未显示)
      try { Taro.hideLoading(); } catch {}
      Taro.showToast({ title: e.message || '发送失败', icon: 'none' });
    }
  };

  const onStartRecording = useCallback(() => {
    if (isRecording) return;

    if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
      Taro.showToast({ title: '请在小程序中使用', icon: 'none' });
      return;
    }

    setIsRecording(true);
    setRecordingDuration(0);

    // 启动计时器
    recordingTimerRef.current = setInterval(() => {
      setRecordingDuration((prev) => prev + 1);
    }, 1000);

    // 开始录音。**首选 wav**：百度短语音识别只接受 pcm/wav/amr/m4a，而 m4a 还额外要求
    // AAC-LC + CBR 24000-96000 + brand mp42:0；真机日志实测部分安卓机型会**忽略**
    // `format:'m4a'` 请求、实际回包 mp3（云函数拿到 ctype=audio/mpeg），这类语音无论怎么
    // 命名都送不进百度 → 用户永远看到 415。wav 是 PCM 无编码分支，微信 RecorderManager
    // 与百度两侧都原生支持，是唯一能绕开该死结的容器。
    // 代价如实说明：wav 体积大（16000Hz×16bit×60s ≈ 1.9MB），但远小于云端 8MB 上限。
    // 机型兼容兜底：少数基础库不支持 wav，逐级降档 wav → m4a → mp3，
    // 保证「发得出去」永远优先于「转得了文字」。
    const FORMAT_TIERS: Array<'wav' | 'm4a' | 'mp3'> = ['wav', 'm4a', 'mp3'];
    const startRecorder = (fmt: 'wav' | 'm4a' | 'mp3') => {
      recordFormatRef.current = fmt;
      logDbg(`[chat] 🎙️ 录音器启动: format=${fmt} rate=16000 ch=1 bitrate=48000`);
      recorderManagerRef.current.start({
        duration: 60000, // 最长60秒
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: fmt,
      });
    };
    // onError 已把本机判定为高档格式不可用 → 直接从更低档起步，不再重复撞墙
    let tier = Math.min(formatTierRef.current, FORMAT_TIERS.length - 1);
    let started = false;
    let lastErr: unknown = null;
    while (tier < FORMAT_TIERS.length && !started) {
      try {
        startRecorder(FORMAT_TIERS[tier]);
        formatTierRef.current = tier;
        started = true;
      } catch (e) {
        lastErr = e;
        console.warn(`[chat] ⚠️ ${FORMAT_TIERS[tier]} 启动录音器失败，尝试降档:`, e);
        tier += 1;
      }
    }
    if (!started) {
      console.error('[chat] ❌ 所有录音格式均启动失败:', lastErr);
      setIsRecording(false);
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      Taro.showToast({ title: '录音启动失败', icon: 'none' });
    }

    // 同步启动「微信同声传译」免密识别：必须在 start 之后调用，插件靠录音器的音频流工作。
    // 拿不到插件（未配 APPID / 未授权）时返回 null，静默跳过——语音照常发送，
    // 只是这条没有现成文本，长按仍可按需走云端识别（需已配置 Key）。
    wechatAsrRef.current = startWechatAsr(recorderManagerRef.current);
    if (!wechatAsrRef.current && hasWechatAsr()) {
      logDbg('[chat] 🎙️ 本次录音未能启动免密识别，将仅保存语音不预转文字');
    }

    // 安全显示toast(可能因权限问题失败)
    try {
      Taro.showToast({ title: '正在录音...', icon: 'none', duration: 60000 });
    } catch {}
  }, [isRecording]);

  const onStopRecording = useCallback(() => {
    if (!isRecording) return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
    }
    recorderManagerRef.current.stop();
    Taro.hideToast();
  }, [isRecording]);

  const onSendVoice = useCallback(() => {
    logDbg('[chat] 语音按钮被点击, isRecording:', isRecording);
    if (isRecording) {
      onStopRecording();
    } else {
      onStartRecording();
    }
  }, [isRecording, onStopRecording, onStartRecording]);

  /**
   * 发送文件：选文件 → 上传 chat-media → 发 content_type='file' 消息。
   * ⚠️ 豁免接线（与发图同款「批次级布尔」）：chooseMessageFile / chooseMedia(H5) 会拉起
   * 系统面板，真机常产生 App 级 onAppHide；不置位就会被防护罩误弹。整批落定的 finally
   * 里 endMediaPickerGrace() 释放——释放后用户真实切后台照常亮罩，不会把真实遮挡豁免掉。
   */
  const handleSelectFile = async () => {
    if (!conversationId) return;
    if (uploading) return;
    logDbg('[chat] 附件入口 → 发送文件');
    setMediaPickerGrace();
    try {
      const file = await selectMessageFile({ count: 1, type: 'file', extension: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip', 'png', 'jpg', 'jpeg'] });
      if (!file) {
        // null 只有一种含义：用户主动取消（selectMessageFile 内部已把真实失败改成 throw）
        logDbg('[chat] 用户取消选择文件，终止流程');
        return;
      }
      // 原始文件名：小程序 tempFiles[0].name 与 H5 File.name 都有；兜底按 MIME 反推扩展名
      const fileName = (file as any).name || `文件-${Date.now()}`;
      Taro.showLoading({ title: '发送中...' });
      const { url, size } = await uploadChatFile(file, fileName);
      logDbg(`[chat] 📎 文件已上传（${size} bytes），准备发送:`, fileName);
      await sendMessage(conversationId, fileName, 'file', url);
      bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
      await fetchMessages(conversationId);
      logDbg('[chat] ✅ 文件消息发送完成，列表已刷新');
      Taro.hideLoading();
      Taro.showToast({ title: '发送成功', icon: 'success' });
    } catch (e: any) {
      try { Taro.hideLoading(); } catch {}
      const msg = (e as Error).message || '';
      console.error('[chat] ❌ 发送文件失败:', msg);
      if (msg.includes('已被删除')) {
        await handleConversationGone('文件发送被 messages INSERT RLS 拒绝', '该会话已删除');
        return;
      }
      // ⛔ 微信隐私接口未声明：这是**公众平台后台配置问题，代码里改不了**。
      // 真机 errMsg 形如 "chooseMessageFile:fail api scope is not declared in the privacy
      // agreement"（upload.ts 已把它翻译成中文语义文案抛出）。
      // ⚠️ 修复路径**不是** app.config.ts 的 requiredPrivateInfos——那个字段只接受 8 个
      //    地理位置类接口，写采集类接口会让平台 CI 生成预览码时被微信直接拒绝
      //    （实测 CI_PREVIEW_FAILED，连预览都出不来）。正解只有去后台《用户隐私保护指引》勾选。
      // 旧版直接甩英文串 toast 用户完全看不懂该做什么；这里沿用 ping 页剪贴板被拒的同款
      // 范式——showModal 长文案给出可执行的后台路径（短 toast 装不下这段指引）。
      if (isPrivacyNotDeclaredError(msg)) {
        console.warn('[chat] ⛔ 判定为隐私声明缺失（需公众平台后台配置），弹出引导');
        Taro.showModal({
          title: '微信隐私权限未开通',
          content: '小程序尚未在微信公众平台《用户隐私保护指引》中声明「所选文件」这项信息，微信因此拦截了选文件。请前往：微信公众平台 → 设置 → 服务内容声明 → 用户隐私保护指引 → 添加信息类型「所选文件」（发图片/语音若同样被拦，再一并勾选「相册」「麦克风」「剪切板」）并填写用途，保存后重新生成预览码即可。此项只能在后台开通，代码无法绕过。',
          confirmText: '知道了',
          showCancel: false,
        });
        return;
      }
      Taro.showToast({ title: msg || '文件发送失败，请稍后重试', icon: 'none' });
    } finally {
      // 选图/上传/发送整批落定，关闭豁免窗口，之后的真实切后台照常遮挡
      endMediaPickerGrace();
      logDbg('[chat] 📎 文件流程结束，系统面板豁免已释放');
    }
  };

  // ===== 语音转文字：识别 / 展开收起 / 冷启动 hydrate =====
  /**
   * 点「转文字」：先查本地缓存（命中即秒开展开），未命中才请求云函数。
   * 结果只写本机缓存，**绝不写回 messages.content**——那条字段对语音消息存的是时长串
   * `[12s]`，会话列表摘要要靠它算「[语音] 0:12」，改写会直接砸掉时长显示。
   */
  const handleTranscribe = useCallback(async (msgId: string) => {
    const target = messages.find((m) => m.id === msgId);
    const url = target?.media_url;
    if (!url) {
      Taro.showToast({ title: '这条语音还没有上传完成', icon: 'none' });
      return;
    }
    const gen = genRef.current;
    // 已有结果：只做展开/收起切换，不再发请求
    const cached = transcripts[msgId] || readTranscript(user?.id, msgId);
    if (cached) {
      logDbg('[chat] 🎙️ 转文字命中缓存，直接切换展开:', msgId);
      if (!transcripts[msgId]) setTranscripts((prev) => ({ ...prev, [msgId]: cached }));
      setExpandedTranscripts((prev) => {
        const next = new Set(prev);
        if (next.has(msgId)) next.delete(msgId);
        else next.add(msgId);
        return next;
      });
      bumpGuard(gen);
      return;
    }
    if (transcribingId) {
      Taro.showToast({ title: '上一条还在识别中，稍等一下', icon: 'none' });
      return;
    }

    // 免密插件只能识别「正在录的音频」，识别不了已入库的历史语音。
    // 本机有插件能力时先给一句诚实说明，避免用户反复点同一个坏掉的云端通道。
    if (hasWechatAsr()) {
      Taro.showModal({
        title: '这条语音暂时转不了',
        content: '微信同声传译只能在录音当场识别，已经发出的语音（含对方发来的）无法回头转写。以后你录的每条语音都会自动带上文字。',
        showCancel: false,
        confirmText: '知道了',
      }).catch(() => {});
      bumpGuard(gen);
      return;
    }

    logDbg('[chat] 🎙️ 开始语音识别:', msgId);
    // 重试场景：先清掉上一次的失败文案，避免展开块里残留「⚠️」被误认成结果
    setTranscripts((prev) => {
      if (!prev[msgId]) return prev;
      const next = { ...prev };
      delete next[msgId];
      return next;
    });
    setTranscribingId(msgId);
    setExpandedTranscripts((prev) => new Set(prev).add(msgId));
    bumpGuard(gen);
    try {
      const text = await transcribeVoice(url);
      // 代次已变（用户离开/页面重建）→ 丢弃回包，不污染新实例
      if (genRef.current !== gen) {
        logDbg('[chat] 🎙️ 识别回包已过代次，丢弃');
        return;
      }
      if (!text) {
        setExpandedTranscripts((prev) => {
          const next = new Set(prev);
          next.delete(msgId);
          return next;
        });
        Taro.showToast({ title: '没听清内容，再试试别条？', icon: 'none' });
        return;
      }
      setTranscripts((prev) => ({ ...prev, [msgId]: text }));
      writeTranscript(user?.id, msgId, text);
      logDbg(`[chat] ✅ 语音识别完成: ${text.length} 字`);
    } catch (e) {
      if (genRef.current !== gen) return;
      const message = e instanceof Error ? e.message : '识别失败，请重试';
      console.warn('[chat] ⚠️ 语音识别失败:', message);
      // 失败时保留展开块，在里面显示错误文案 + 重试入口，比一闪而过的 toast 更好读
      setTranscripts((prev) => ({ ...prev, [msgId]: `⚠️ ${message}` }));
      setExpandedTranscripts((prev) => new Set(prev).add(msgId));
    } finally {
      if (genRef.current === gen) setTranscribingId(null);
    }
  }, [messages, transcripts, transcribingId, user?.id]);

  /**
   * 折叠/展开某条语音的转写文本。
   * `remember` 为真表示这是**用户主动**的开合（区别于免密识别成功后的默认展开），
   * 只有主动操作才写入记忆，避免把系统行为当成用户偏好带到下次进入会话。
   */
  const toggleTranscript = useCallback((msgId: string, remember = true) => {
    setExpandedTranscripts((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      if (remember) writeExpandedIds(user?.id, next);
      return next;
    });
    bumpGuard(genRef.current);
  }, [user?.id]);

  /** 字号档位切换：点击即循环「小 → 标准 → 大」，落本地后全局生效 */
  const cycleTranscriptFont = useCallback(() => {
    const order: TranscriptFontScale[] = ['sm', 'base', 'lg'];
    const idx = order.indexOf(transcriptFont);
    const next = order[(idx + 1) % order.length];
    setTranscriptFont(next);
    writeTranscriptFontScale(next);
    Taro.showToast({ title: `字号已设为${TRANSCRIPT_FONT_LABEL[next]}`, icon: 'none' });
    bumpGuard(genRef.current);
  }, [transcriptFont]);

  /**
   * 复制转写文本。真机常见 errno 112（隐私指引未声明「读取剪贴板」），
   * 被拒时不静默失败，而是降级打开页面内 `<Text selectable>` 弹层让用户长按手动复制
   * ——与 ping 页结论复制、批量诊断复制同款兜底。
   */
  const copyTranscript = useCallback((text: string) => {
    const pure = text.replace(/^⚠️\s*/, '');
    if (!pure) return;
    Taro.setClipboardData({
      data: pure,
      success: () => {
        logDbg('[chat] 📋 转写文本已复制');
        Taro.showToast({ title: '已复制文字', icon: 'success' });
      },
      fail: (err) => {
        logDbg('[chat] setClipboardData fail:', err, '→ 打开可选中文本降级弹层');
        setTranscriptCopyText(pure);
      },
    });
    bumpGuard(genRef.current);
  }, []);

  // 冷启动 hydrate：把本会话语音消息里已缓存的转写一次性读出来备好
  // （默认仍折叠，只是数据先到位，点开展开时无需等网络）
  useEffect(() => {
    if (!user?.id || messages.length === 0) return;
    const voiceIds = messages.filter((m) => m.content_type === 'voice').map((m) => m.id);
    if (voiceIds.length === 0) return;
    const map = readTranscripts(user.id, voiceIds);
    const known = Object.keys(map);
    if (known.length === 0) return;
    setTranscripts((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of known) {
        if (!next[id]) {
          next[id] = map[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // 展开记忆只恢复「仍然有效」的 id：与本次 hydrate 出的转写取交集，
    // 顺带让已删除/撤回消息的残留记录自然淘汰，不必额外清理。
    const remembered = readExpandedIds(user.id);
    if (remembered.size > 0) {
      const valid = new Set(known.filter((id) => remembered.has(id)));
      if (valid.size > 0) {
        setExpandedTranscripts((prev) => {
          const next = new Set(prev);
          valid.forEach((id) => next.add(id));
          return next;
        });
        logDbg(`[chat] ⚡ 已恢复 ${valid.size} 条语音转写的展开状态`);
      }
    }
    logDbg(`[chat] ⚡ 已从本地缓存 hydrate ${known.length}/${voiceIds.length} 条语音转写`);
  }, [user?.id, messages]);

  // ⚠️ useCallback：被 renderMessageContent（语音分支）引用，而 renderMessageContent 又要
  //    作为 prop 传给 memo 化的消息行——引用不稳会让所有语音气泡重渲染。
  const playVoice = useCallback((messageId: string, url: string) => {
    if (!innerAudioContextRef.current) return;

    // 如果正在播放同一条,则暂停
    if (playingVoiceId === messageId) {
      innerAudioContextRef.current.pause();
      setPlayingVoiceId(null);
      return;
    }

    // 停止之前的播放
    if (playingVoiceId) {
      innerAudioContextRef.current.stop();
    }

    // 播放新语音
    innerAudioContextRef.current.src = url;
    innerAudioContextRef.current.play();
    setPlayingVoiceId(messageId);

    innerAudioContextRef.current.onEnded(() => {
      setPlayingVoiceId(null);
    });

    innerAudioContextRef.current.onError(() => {
      setPlayingVoiceId(null);
      Taro.showToast({ title: '播放失败', icon: 'none' });
    });
  }, [playingVoiceId]);

  // 顶部「聊天对象名称」连点计数处理(连续3次单向返回Ping页)
  // ⚠️ reLaunch 会销毁整个页面栈，本页实例连同 genRef/闭包一起消失，
  //    因此不存在「回到本页后残留旧计数」的问题，无需额外清理。
  const handleNameTripleClick = () => {
    const newCount = nameClickCount + 1;
    logDbg(`[chat] 名称区连点次数: ${newCount}`);
    setNameClickCount(newCount);

    // 2 秒内未继续点击则计数归零
    if (nameClickTimerRef.current) {
      clearTimeout(nameClickTimerRef.current);
    }
    nameClickTimerRef.current = setTimeout(() => {
      logDbg('[chat] 名称区连点计数器重置');
      setNameClickCount(0);
    }, 2000);

    if (newCount >= 3) {
      logDbg('[chat] 触发隐藏功能: 名称区连点3次, 单向返回Ping页面');
      setNameClickCount(0);
      if (nameClickTimerRef.current) {
        clearTimeout(nameClickTimerRef.current);
      }
      Taro.showToast({ title: '返回网络检测', icon: 'success', duration: 1500 });
      setTimeout(() => {
        logDbg('[chat] 🚪 [EXIT_NAME_TRIPLE_CLICK] 主动离开本页, 废弃计时起点');
        markChatExit(); // 打退场点：下一次进入聊天页的登录统计窗口从这里起算
        reportPresence('offline'); // 退回 ping 页 = 不在线（必须在 reLaunch 前发起）
        abandonGuard();
        Taro.reLaunch({ url: '/pages/ping/index' });
      }, 500);
    }
  };

  // 隐藏按钮点击处理(连续3次返回Ping页)
  const handleHiddenClick = () => {
    const newCount = hiddenClickCount + 1;
    logDbg(`[chat] 隐藏按钮点击次数: ${newCount}`);
    setHiddenClickCount(newCount);

    // 清除之前的定时器
    if (hiddenClickTimerRef.current) {
      clearTimeout(hiddenClickTimerRef.current);
    }

    // 设置2秒内重置计数器
    hiddenClickTimerRef.current = setTimeout(() => {
      logDbg('[chat] 隐藏按钮计数器重置');
      setHiddenClickCount(0);
    }, 2000);

    // 达到3次点击
    if (newCount >= 3) {
      logDbg('[chat] 触发隐藏功能: 返回Ping页面');
      setHiddenClickCount(0);
      if (hiddenClickTimerRef.current) {
        clearTimeout(hiddenClickTimerRef.current);
      }
      Taro.showToast({ title: '返回网络检测', icon: 'success', duration: 1500 });
      setTimeout(() => {
        logDbg('[chat] 🚪 [EXIT_HIDDEN_CLICK] 主动离开本页, 废弃计时起点');
        markChatExit(); // 打退场点：下一次进入聊天页的登录统计窗口从这里起算
        reportPresence('offline'); // 退回 ping 页 = 不在线（必须在 reLaunch 前发起）
        abandonGuard();
        Taro.reLaunch({ url: '/pages/ping/index' });
      }, 500);
    }
  };

  // ===== 长按多选删除 =====
  const exitSelectMode = useCallback(() => {
    logDbg('[chat] 退出多选删除模式');
    setSelectMode(false);
    setSelectedIds([]);
  }, []);

  const toggleMessageSelect = useCallback((messageId: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(messageId)
        ? prev.filter((id) => id !== messageId)
        : [...prev, messageId];
      logDbg('[chat] 勾选消息:', messageId, '当前已选数量:', next.length);
      return next;
    });
  }, []);

  // 触摸开始:650ms后触发长按,弹出多选确认菜单。
  // 【防误触】手指移动超过10px(滚动/滑动)立即取消长按判定——
  // 之前500ms纯计时,滚动时手指在任何消息上停顿都会误弹菜单。
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  // ⚠️ messages 的 ref 镜像：onMsgTouchStart 要作为 prop 传给 memo 化的消息行，
  //    若把 messages 放进依赖数组，每来一条新消息所有行的 touch 回调都会换引用 → memo 全失效。
  //    用 ref 读最新值，回调本身保持 useCallback([]) 稳定。
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // ⚠️ handleForwardImage / handleRevoke 声明在本函数之后：依赖数组在渲染时立即求值，
  //    直接列进去会触发 TS2448（TDZ）。用 ref 持有最新引用，回调本身保持稳定。
  const forwardImageRef = useRef<(url: string) => void>(() => {});
  const revokeRef = useRef<(messageId: string) => void>(() => {});
  const quoteSummaryRef = useRef<(msg: Message) => string>(() => '');
  const startWhereWaitRef = useRef<() => void>(() => {});
  const onMsgTouchStart = useCallback((e: any, msgId: string) => {
    // 长按热区已收窄到气泡/勾选框,但事件仍会冒泡到行层——多选模式内
    // 点空白处只该退出多选,绝不能再弹操作菜单
    if (selectMode) return;
    pendingLongPressRef.current = null;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const t = e?.touches?.[0];
    touchStartPosRef.current = t ? { x: t.clientX, y: t.clientY } : null;
    longPressTimerRef.current = setTimeout(() => {
      // 长按达成后抬手仍会补发一次click,置pending标记供行内消费(多选未开启时也会被ScrollView兜底消费)
      pendingLongPressRef.current = 'longpress';
        logDbg('[chat] 长按消息触发,弹出操作菜单:', msgId);
      const target = messagesRef.current.find((m) => m.id === msgId);
      // 仅自己的、对方未读、发送2分钟内的消息提供「撤回」项（服务端条件UPDATE做最终兜底）
      void nowTick; // 依赖当前计时,确保倒计时到期后本闭包重建
      const revocable = !!target && target.sender_id === user?.id && canRevoke(target);
      // 图片消息长按额外提供「发送图片给朋友」转发项：把同一张已上传图片作为新消息再发一条
      const isImageMsg = !!target && target.content_type === 'image' && !!target.media_url;
      longPressImageUrlRef.current = isImageMsg ? (target?.media_url as string) : '';
      // 语音消息长按提供「转文字」：结果只存本机（见 voice-transcript-cache），对方不可见
      const isVoiceMsg = !!target && target.content_type === 'voice' && !!target.media_url;
      // 菜单文案随本机能力变化：免密插件可用时，历史语音当场转不了就说清「以后录的会自动转」，
      // 避免用户反复点同一个坏掉的云端通道。
      const transcribeLabel = hasWechatAsr() ? '转文字（限新录音）' : '转文字';
      const items = [
        '回复',
        ...(isImageMsg ? ['发送图片给朋友'] : []),
        ...(isVoiceMsg ? [transcribeLabel] : []),
        ...(revocable ? ['撤回'] : []),
        '多选删除消息',
      ];
      Taro.vibrateShort({ type: 'light' }).catch(() => {});
      Taro.showActionSheet({
        itemList: items,
        itemColor: '#3f3f46',
        success: (res) => {
          const label = items[res.tapIndex];
          if (label === '回复') {
            // 进入引用回复：展示引用条并聚焦输入框
            if (target) {
              logDbg('[chat] 用户选择回复消息:', target.id);
              setReplyTo(target);
              setInputFocus(true);
            }
          } else if (label === '发送图片给朋友') {
            if (longPressImageUrlRef.current) {
              void forwardImageRef.current(longPressImageUrlRef.current);
            }
          } else if (label === transcribeLabel) {
            logDbg('[chat] 用户选择语音转文字:', msgId);
            void handleTranscribe(msgId);
          } else if (label === '撤回') {
            logDbg('[chat] 用户选择撤回消息:', msgId);
            revokeRef.current(msgId);
          } else if (label === '多选删除消息') {
            // 用户主动点菜单确认后才进入多选模式,此时不消费任何click,无需pending标记
            logDbg('[chat] 用户确认进入多选删除模式');
            setSelectMode(true);
          } else {
            logDbg('[chat] 用户取消,不进入任何模式');
          }
        },
        fail: () => {
          logDbg('[chat] ActionSheet被关闭,不进入任何模式');
        },
      });
    }, 650);
  }, [selectMode, user?.id, nowTick, handleTranscribe]);

  // ⚠️ 这两个是纯函数（只读 ref，不依赖任何 state），useCallback([]) 固定引用，
  //    否则消息行 memo 会因为 touch 回调每次换引用而全部失效。
  const onMsgTouchMove = useCallback((e: any) => {
    const start = touchStartPosRef.current;
    const t = e?.touches?.[0];
    if (!start || !t) return;
    const dx = Math.abs(t.clientX - start.x);
    const dy = Math.abs(t.clientY - start.y);
    if ((dx > 10 || dy > 10) && longPressTimerRef.current) {
      logDbg(`[chat] 手指移动(${Math.round(dx)},${Math.round(dy)}px),取消长按判定`);
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const onMsgTouchEnd = useCallback(() => {
    touchStartPosRef.current = null;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // 头像加载失败：记下发送者 id，后续该发送者的消息统一降级为文字头像。
  // ⚠️ useCallback([])：作为 prop 传给 memo 化的消息行，引用必须稳定。
  const handleAvatarError = useCallback((senderId: string) => {
    setAvatarErrorIds((prev) => (prev.has(senderId) ? prev : new Set(prev).add(senderId)));
  }, []);

  // 多选模式下点击消息行:切换勾选。
  // 【根因】小程序/Taro里子元素onClick默认继续冒泡到ScrollView,
  // 会被ScrollView的"点空白退出多选"逻辑误判并exitSelectMode,
  // 表现为"刚勾上第2条就自动取消"。必须显式stopPropagation阻断冒泡。
  const lastToggleRef = useRef<{ id: string; time: number }>({ id: '', time: 0 });
  const onMsgTapInSelectMode = useCallback((messageId: string, e?: any) => {
    // 关键:无论后续走哪条分支,先阻断向ScrollView的冒泡
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (!selectMode) return;
    // 长按刚触发(弹菜单)的消息,其抬手补发的click直接消费掉,不进入toggle逻辑。
    // 同步复位longPressFiredRef,防止其它层再次误判。
    if (pendingLongPressRef.current !== null) {
      pendingLongPressRef.current = null;
      longPressFiredRef.current = false;
      logDbg('[chat] 消费长按后的误触click:', messageId);
      return;
    }
    // 一次物理触摸可能派发多次click(行内+残留),400ms同id去重作为最后防线。
    const now = Date.now();
    if (lastToggleRef.current.id === messageId && now - lastToggleRef.current.time < 400) {
      logDbg('[chat] 同一消息400ms内重复toggle,已去重:', messageId);
      return;
    }
    lastToggleRef.current = { id: messageId, time: now };
    logDbg('[chat] 点击消息行,切换勾选(已阻断冒泡):', messageId);
    toggleMessageSelect(messageId);
  }, [selectMode, toggleMessageSelect]);

  // 全选/取消全选
  const handleToggleSelectAll = () => {
    if (selectedIds.length === messages.length) {
      logDbg('[chat] 取消全选');
      setSelectedIds([]);
    } else {
      logDbg('[chat] 全选消息,数量:', messages.length);
      setSelectedIds(messages.map((m) => m.id));
    }
  };

  // 删除已勾选的消息(软删除,仅自己视图消失)。
  // 【防误删】点删除先弹二次确认,避免多选模式下顺手点错直接删掉。
  const handleDeleteSelected = () => {
    if (selectedIds.length === 0) {
      Taro.showToast({ title: '请先选择消息', icon: 'none' });
      return;
    }
    const count = selectedIds.length;
    logDbg('[chat] 点击删除按钮,弹出二次确认,数量:', count);
    Taro.showModal({
      title: '确认删除',
      content: `确定删除选中的 ${count} 条消息吗？仅从你的记录中移除。`,
      confirmText: '删除',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) {
          logDbg('[chat] 用户取消删除');
          return;
        }
        logDbg('[chat] 确认删除选中消息,数量:', count);
        try {
          Taro.showLoading({ title: '删除中...', mask: true });
          for (const id of selectedIds) {
            await deleteMessage(id);
          }
          Taro.hideLoading();
          Taro.showToast({ title: `已删除${count}条`, icon: 'success', duration: 1200 });
          exitSelectMode();
          bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
        } catch (e) {
          try { Taro.hideLoading(); } catch (_) {}
          console.error('[chat] 删除选中消息失败:', e);
          Taro.showToast({ title: (e as Error).message || '删除失败', icon: 'none' });
        }
      },
      fail: () => {
        logDbg('[chat] 确认弹窗打开失败');
      },
    });
  };

  // 撤回自己发送且对方未读的消息(二次确认后执行,双方替换为撤回占位)
  const handleRevoke = useCallback((messageId: string) => {
    Taro.showModal({
      title: '撤回消息',
      content: '仅可撤回对方未读的消息，撤回后双方均不可见。',
      confirmText: '撤回',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await revokeMessage(messageId);
          logDbg('[chat] 消息撤回成功:', messageId);
          Taro.showToast({ title: '已撤回', icon: 'success', duration: 1200 });
          bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
        } catch (e) {
          console.error('[chat] 撤回消息失败:', e);
          Taro.showToast({ title: (e as Error).message || '撤回失败', icon: 'none' });
        }
      },
    });
  }, [revokeMessage]);
  // 把最新实现挂到 ref 上（onMsgTouchStart 通过 ref 调用，避免依赖数组 TDZ）
  revokeRef.current = handleRevoke;

  // 撤回倒计时周期刷新(60s一次):超时后长按菜单不再出现「撤回」项。
  // ⚡ 性能：每 60s 一次的 setState 会让 4200 行页面全量重渲染（messages.map 重跑几百次
  // 日期格式化）。改成「只在有未读可撤回消息时才 tick」——没有候选消息时定时器空转不触发渲染。
  useEffect(() => {
    const t = setInterval(() => {
      // 仅当存在「2 分钟内发出、未读、未撤回」的可撤回消息时才需要刷新倒计时状态
      const cutoff = Date.now() - 2 * 60 * 1000;
      const hasRevocable = useMessagesStore
        .getState()
        .messages.some(
          (m) => m.sender_id === user?.id && !m.revoked_at && !m.read_at &&
                 new Date(m.created_at).getTime() > cutoff,
        );
      if (hasRevocable) setNowTick(Date.now());
    }, 60000);
    return () => clearInterval(t);
  }, [user?.id]);

  // 清空聊天记录(入口:长按聊天名称,无可见按钮)
  // ⚠️ 语义：只清「自己这边」的记录 —— 走 message_deletes 软删，对方照常可见、可继续发送。
  // 不再连带删除会话行（旧版会物理删 conversations，导致对方的会话一起消失）。
  const handleClearAllMessages = () => {
    Taro.showModal({
      title: '确认清空',
      content: '确定要清空与对方的所有记录吗？仅清除你这边的记录，对方仍可见。',
      success: async (res) => {
        if (res.confirm) {
          try {
            Taro.showLoading({ title: '清空中...', mask: true });
            await deleteAllMessages(conversationId);
            logDbg('[chat] 🧹 已软删除本人视角的全部消息（不删除会话行，对方不受影响）:', conversationId);
            // 本地消息快照必须清空：否则下次进页 restoreFromCache 会把已删的记录又渲染出来。
            if (user?.id && conversationId) {
              try {
                Taro.removeStorageSync(msgCacheKeyOf(user.id, conversationId));
                logDbg('[chat] 🧹 已清除本人的消息快照缓存:', conversationId);
              } catch (e) {
                console.warn('[chat] 清理消息快照缓存失败:', e);
              }
            }
            bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
            Taro.hideLoading();
            Taro.showToast({ title: '已清空', icon: 'success', duration: 1500 });
            // 停留在当前会话页：会话仍在（对方还留着），只是本视图空了
            useMessagesStore.setState({ messages: [] });
          } catch (e) {
            Taro.hideLoading();
            console.error('[chat] ❌ 清空聊天记录失败:', e);
            Taro.showToast({ title: (e as Error).message, icon: 'none' });
          }
        }
      },
    });
  };

  // 顶栏名称长按菜单：把「清空记录（仅自己）」和「删除会话（仅自己隐藏）」两个动作分开
  const handleConversationMenu = () => {
    Taro.showActionSheet({
      itemList: ['清空记录（仅本机）', '删除会话（对方仍保留）'],
      success: (res) => {
        if (res.tapIndex === 0) handleClearAllMessages();
        else if (res.tapIndex === 1) handleDeleteConversation();
      },
      fail: (err) => {
        if (err.errMsg?.includes('cancel')) logDbg('[chat] 用户取消会话菜单');
      },
    });
    logDbg('[chat] 🏷️ 打开会话长按菜单');
    bumpGuard(genRef.current);
  };

  // 删除会话（双向软删除）：只对自己隐藏，对方仍保留；双方都删才彻底清理数据库
  const handleDeleteConversation = () => {
    Taro.showModal({
      title: '确认删除会话',
      content: '确定要删除这个会话吗？仅从你的列表移除，对方仍会保留该会话；双方都删除后才会彻底清除数据。',
      success: async (res) => {
        if (!res.confirm) return;
        const currentUser = useAuthStore.getState().user;
        if (!currentUser) {
          console.warn('[chat] ⚠️ 无登录态，无法删除会话');
          Taro.showToast({ title: '请先登录', icon: 'none' });
          return;
        }
        try {
          Taro.showLoading({ title: '删除中...', mask: true });
          logDbg('[chat] 🗑️ 开始删除会话（双向软删除）:', conversationId, '| 当前用户:', currentUser.id);
          await useChatsStore.getState().deleteConversation(conversationId);
          Taro.hideLoading();
          bumpGuard(genRef.current);
          Taro.showToast({ title: '已删除', icon: 'success', duration: 1200 });
          // ⚠️ 缺陷⑩（与 handleConversationGone 同款，上一轮漏改，勿再写 .catch()）：
          //   小程序端 `Taro.navigateBack()` 返回 **void 而不是 Promise**，`.catch()` 会抛
          //   `TypeError: Cannot read property 'catch' of undefined`；且页面栈只有 1 层时
          //   navigateBack 本身同步抛错 —— 两者都会冒到导航层，表现为**闪退**。
          //   正解：先看页面栈深度，>1 才 navigateBack，否则 reLaunch 回列表；整段 try-catch 兜底。
          setTimeout(() => {
            try {
              const stack = Taro.getCurrentPages();
              if (stack.length > 1) {
                logDbg(`[chat] ↩️ 会话已删除，页面栈深 ${stack.length}，navigateBack 回列表`);
                Taro.navigateBack();
              } else {
                logDbg('[chat] 🚪 会话已删除且页面栈仅 1 层，reLaunch 回列表（navigateBack 会抛错导致闪退）');
                Taro.reLaunch({ url: '/pages/chats/index' });
              }
            } catch (e) {
              console.warn('[chat] ⚠️ 删除会话后的导航异常，降级 reLaunch 回列表:', e);
              try {
                Taro.reLaunch({ url: '/pages/chats/index' });
              } catch (e2) {
                console.error('[chat] ❌ 降级 reLaunch 也失败:', e2);
              }
            }
          }, 800);
        } catch (e) {
          Taro.hideLoading();
          console.error('[chat] ❌ 删除会话异常:', e);
          Taro.showToast({ title: (e as Error).message || '删除失败', icon: 'none', duration: 3000 });
        }
      },
    });
  };

  /**
   * 表情面板点击：**只把表情插入输入框，不直接发送**（用户要求）。
   * ⚠️ 旧实现是点一下立刻 `sendMessage(..., 'emoji')` 发出去，用户反馈「选表情就发出去了」——
   *    表情应当和打字一样先进入输入框，由用户自己决定什么时候按发送。
   * ⚠️ 插入位置取光标处（`selectionStart`），没有光标信息时追加到末尾；
   *    插入后把光标移到表情之后，连续点多个表情能按顺序接上。
   * ⚠️ 不关闭面板：用户通常要连选几个表情，关掉就得重新点开。
   */
  const onPickEmoji = useCallback((emoji: string) => {
    logDbg(`[chat] 😊 表情面板选中: ${emoji}`);
    const prev = inputValue;
    const pos = typeof inputSelection === 'number' ? inputSelection : prev.length;
    const next = prev.slice(0, pos) + emoji + prev.slice(pos);
    setInputValue(next);
    setInputSelection(pos + emoji.length);
    bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
    // 记入「最近使用」：pushRecentEmoji 直接返回更新后的完整列表，省一次读存储。
    // ⚠️ 不 await、不 try/catch：本地存储失败不该影响「表情已插入输入框」这个主流程。
    const updated = pushRecentEmoji(user?.id, emoji);
    setRecentEmojis(updated);
    logDbg(`[chat] 表情已插入输入框: ${emoji}（长度 ${prev.length} → ${next.length}），最近表情 ${updated.length} 个`);
  }, [inputValue, inputSelection, user?.id]);

  /**
   * 【取消多图上传】递增代次令牌即可让在途的压缩回调 / 上传队列 / 发送阶段全部丢弃回包。
   * Taro.request 与宿主页 canvas 导出都无法真正中断，只能「不再消费其结果」——
   * 与 ping 页 handleStop、批量诊断面板同一套思路。
   */
  const handleCancelUpload = useCallback(() => {
    if (!uploading) return;
    uploadRunIdRef.current += 1;
    abortResizeBatch(); // 通知离屏 canvas 宿主页：剩余图片不压了，立刻返回上一页
    const ids = activeImageTempIdsRef.current;
    // 未完成的占位直接清掉（已发送成功的行已被原位替换成真实消息，不在 ids 里）
    ids.forEach((id) => setImageProgress(id, null));
    dismissPendingImages(ids);
    clearImageProgress(ids);
    setUploadSummary('');
    setUploading(false);
    try {
      Taro.hideLoading();
    } catch {}
    Taro.showToast({ title: '已取消上传', icon: 'none' });
    logDbg(`[chat] 🛑 用户取消多图上传，批次 ${ids.length} 张占位已清理`);
  }, [uploading, setImageProgress, dismissPendingImages, clearImageProgress]);

  /**
   * 附件按钮：一个入口同时支持「发图片」和「发文件」。
   *
   * ⚠️ 为什么合并：原先底部并排两个按钮（加号=图片、回形针=文件），用户反馈
   *    「图片和文件应该是一个按钮」。合并后点一下弹 ActionSheet 让用户选，
   *    底部输入区少一个按钮、视觉更清爽。
   *
   * ⚠️ 两个分支各自保留原有的完整链路（豁免窗口、隐私声明引导、代次令牌），
   *    这里只做「选哪条路」的分发，不把两条链路揉在一起——它们的失败处理
   *    与进度反馈差异很大（图片是整批流水线 + 占位行，文件是单文件 + loading）。
   */
  const handlePickAttachment = useCallback(() => {
    if (uploading) return;
    // 按微信的做法：图片 / 文件 / 位置全部收进最右侧「加号带圈」按钮，点一下弹 ActionSheet 三选一。
    // ⚠️ 位置分支复用 handleSendMyLocation（进页已自动定位，一键发当前坐标），
    //    不再单独占一个按钮——底部输入区只留「表情 + 加号」两个入口。
    Taro.showActionSheet({ itemList: ['发送图片', '发送文件', '发送位置'] })
      .then((res) => {
        if (res.tapIndex === 0) {
          void handleSelectImage();
        } else if (res.tapIndex === 1) {
          void handleSelectFile();
        } else if (res.tapIndex === 2) {
          void handleSendMyLocation();
        }
      })
      .catch(() => {
        // 用户点取消 / 点空白关闭：静默返回，不提示
        logDbg('[chat] 用户取消选择附件类型');
      });
  }, [uploading]);

  // 选择并上传图片（支持一次选多张，整批一次压缩 + 边压边传 + 并发发送）
  const handleSelectImage = async () => {
    logDbg('[chat] 附件入口 → 发送图片');

    if (uploading) return;

    // 本批次代次号：后续每个异步回调都据此判定「是否已被取消」
    const myRun = ++uploadRunIdRef.current;
    const isCancelled = () => uploadRunIdRef.current !== myRun;

    try {
      // 先让用户选择图片,此时不显示loading,避免"未选先提示发送中"的体验问题
      // 开启豁免窗口:调起系统相册会触发一次或多次瞬时 onAppHide(部分机型),
      // 窗口内的 hide 不弹防护罩;Promise 落定后在 finally 里关闭窗口
      setMediaPickerGrace();
      const files = await selectMediaFiles({ count: MAX_CHAT_IMAGES, mediaType: ['image'] });
      logDbg('[chat] 选择图片结果:', files.length, '个文件');

      // 用户取消选择(未选中任何图片),直接返回,不做任何提示
      if (files.length === 0) {
        logDbg('[chat] 用户取消选择图片,终止流程');
        return;
      }

      // 确认已选中图片后,再进入上传状态
      setUploading(true);

      const total = files.length;
      // 【先上屏】按选图顺序一次性预挂 N 条占位行（media_url 为空 → 气泡渲染逐张进度），
      // 用户立刻看到自己选的图，后台再边压边传边补真值。
      const tempIds = await stageImagePlaceholders(conversationId, total);
      activeImageTempIdsRef.current = tempIds;
      // 占位一上屏就把每张置为「压缩中」，气泡立刻有进度反馈（不等网络往返）
      tempIds.forEach((id) => setImageProgress(id, { percent: 5, stage: 'compressing' }));

      // 【边压边传的流水线】上传是纯网络 IO，不必等整批压缩完成：
      // 压缩每产出一张就投递给上传队列（并发 3），压缩与上传时间重叠。
      // ⚠️ 小程序端压缩本身必须整批一次导航（canvas 宿主页单槽位 + 连续导航会被微信拒绝），
      // 所以这里不再逐张 compressImageFile —— 那等于退回每张图一轮页面跳转。
      const urlsByIndex: (string | undefined)[] = new Array(total);
      let uploadFailed = 0;
      let doneCount = 0;
      // 进度文案只出现在输入区上方一行（真正的逐张进度在各气泡内），不再反复 showLoading
      const refreshSummary = () => {
        if (isCancelled()) return;
        setUploadSummary(total > 1 ? `上传中 ${doneCount}/${total}` : '上传中…');
      };
      refreshSummary();

      const uploadQueue = new Set<Promise<void>>();
      const UPLOAD_CONCURRENCY = 3;
      const queueUpload = (index: number, file: MiniProgramFileInput | File): Promise<void> => {
        const run = async () => {
          const tempId = tempIds[index];
          // 取消后到达的产出直接丢弃：不再发起上传，也不回填 url
          if (isCancelled()) {
            if (tempId) setImageProgress(tempId, null);
            return;
          }
          if (tempId) setImageProgress(tempId, { percent: 10, stage: 'uploading' });
          try {
            const result = await uploadToSupabase(file, { bucket: 'chat-media' });
            if (!result.success) throw new Error(result.error || '上传失败');
            if (isCancelled()) return; // 回包时用户已取消：url 不回填，这条不发送
            urlsByIndex[index] = `${supabaseUrl}/storage/v1/object/public/chat-media/${result.data.path}`;
            if (tempId) setImageProgress(tempId, { percent: 95, stage: 'uploading' });
          } catch (e: any) {
            console.error(`[chat] ❌ 第 ${index + 1} 张图片上传失败:`, e);
            uploadFailed += 1;
          } finally {
            doneCount += 1;
            refreshSummary();
          }
        };
        // 【限并发】超过阈值就等最早完成的那条落定再继续投递，
        // 避免小程序并发请求数触顶反而变慢（微信 request 默认并发上限 10）。
        const p = (async () => {
          if (uploadQueue.size >= UPLOAD_CONCURRENCY) {
            await Promise.race(Array.from(uploadQueue));
          }
          await run();
        })().finally(() => uploadQueue.delete(p));
        uploadQueue.add(p);
        return p;
      };

      await compressImageFilesBatch(
        files,
        { maxSide: 1280, quality: 0.8 },
        (index, compressed) => {
          void queueUpload(index, compressed);
        },
        // 压缩层每轮询一拍就来问一次：用户点取消后宿主页随即停手，不必干等到超时
        isCancelled,
      );
      await Promise.all(Array.from(uploadQueue));

      if (isCancelled()) return; // 用户在上传途中点了取消：整批作废，占位已由取消按钮清理

      // 按下标回填，保证最终顺序 == 用户选图顺序（失败的槽位跳过）
      const orderedUrls = urlsByIndex.filter((u): u is string => !!u);
      const orderedTempIds = tempIds.filter((_, i) => !!urlsByIndex[i]);
      // 上传阶段就失败的项：占位没有可重发的载荷，直接清掉不留红壳
      tempIds
        .filter((_, i) => !urlsByIndex[i])
        .forEach((id) => dismissPendingImages([id]));

      if (orderedUrls.length === 0) {
        // 一张都没传上去：清掉占位，别留一堆可重发的空壳在列表里
        orderedTempIds.forEach((id) => dismissFailed(id));
        throw new Error(uploadFailed > 0 ? '图片上传失败，请稍后重试' : '未选择有效图片');
      }

      // 并发发出（引用只挂第一张，单张发送失败仍可在列表里点 ! 重发）
      setUploadSummary('发送中…');
      const r = await sendImagesBatch(orderedUrls, orderedTempIds);
      if (r.gone) return; // 会话已失效：handleConversationGone 已给出提示并离开本页

      if (total > 1) {
        const lost = total - orderedUrls.length; // 上传阶段就失败的张数
        Taro.showToast({
          title:
            lost + r.failed > 0
              ? `${r.sent} 张已发送，${lost + r.failed} 张失败`
              : `已发送 ${r.sent} 张图片`,
          icon: 'none',
        });
      } else {
        Taro.showToast({ title: '发送成功', icon: 'success' });
      }
    } catch (e: any) {
      console.error('上传图片失败:', e);
      Taro.showToast({ title: e.message || '上传失败', icon: 'none' });
    } finally {
      // 选图流程结束(成功/取消/报错均走到这里),关闭豁免窗口,
      // 之后的真实切后台照常遮挡
      endMediaPickerGrace();
      setUploading(false);
      setUploadSummary('');
      activeImageTempIdsRef.current = [];
      // 收尾清掉本批残留进度（已替换成真实行的占位自然不在列表里，这里只是防内存泄漏）
      clearImageProgress(Object.keys(imageProgress));
      try {
        Taro.hideLoading();
      } catch {}
    }
  };

  /**
   * 进入聊天页时自动获取当前位置（供「发送我的位置」使用）。
   *
   * ⚠️ 必须静默：这是页面生命周期里的自动调用，用户没点任何按钮，
   *    失败（未授权 / 定位关闭 / H5 预览）只打日志，绝不弹提示打扰。
   * ⚠️ 用代次令牌守卫：本函数是异步的，用户可能在定位返回前就离开本页，
   *    此时 setState 会作用在已卸载的实例上（旧实例补触发场景下还会污染新实例）。
   */
  const autoFetchCurrentLocation = async () => {
    const gen = genRef.current;
    logDbg('[chat] 📡 进入页面，自动获取当前位置');
    const loc = await getCurrentLocation();
    if (genRef.current !== gen) {
      logDbg('[chat] 🛑 [GUARD_STALE] 定位返回时代次已过期，丢弃结果');
      return;
    }
    setCurrentLocation(loc);
    setLocationResolved(true);
    // 暗号链路：把本次定位结果落本地存储，供「B 不在线时下次进页补发最近一次位置」使用。
    // ⚠️ 本地缓存只在本机存（位置是敏感信息），换设备就没了。
    if (loc) saveLastLocation(loc);
    // 同时上报云端 profiles.last_lat/last_lng/last_location_at：隐藏命令
    // `check <用户名> place` 要查「TA 最后一次自动定位的位置」，必须有云端记录。
    // 静默失败（fire-and-forget），绝不阻塞进页面主流程。
    // ⚠️ 必须现读 store 拿 uid：本函数在 useDidShow 里被调用，闭包里的 user 可能是
    //    上一轮渲染的快照（冷启动过渡态时甚至为空），现读才能拿到真实登录态。
    const me = useAuthStore.getState().user?.id;
    if (loc && me) {
      // ⚠️ 必须 await：`reportLastLocation` 内部会接着写一条定位历史，而历史 INSERT
      //    在 fire-and-forget 模式下会随页面销毁被中断（实测历史表恒为 0 行）。
      //    这里 await 只是让「写历史」有机会跑完，失败仍由内部吞掉，不影响进页主流程。
      const ok = await reportLastLocation(me, loc.lat, loc.lng);
      logDbg(`[chat] 📍 位置上报${ok ? '成功' : '失败(不影响使用)'}`);
      // 存量补录：定位历史表是后加的，升级前的位置只存在 profiles.last_* 里。
      // 不补的话「定位次数」永远是 0、轨迹页永远没有点，用户会以为功能坏了。
      // 只在「该用户历史为空」时补一次，之后由正常上报累积。
      if (ok) {
        const backfilled = await backfillLocationHistory(me, loc.lat, loc.lng);
        if (backfilled) logDbg('[chat] 📍 已补录一条历史定位（历史表此前为空）');
      }
    }
    logDbg(loc ? '[chat] ✅ 当前位置已就绪，可一键发送' : '[chat] ⚠️ 当前位置不可用（未授权或定位关闭）');
  };

  /**
   * 发送「我的位置」：把自动定位拿到的坐标直接发出去，不再拉起地图。
   *
   * ⚠️ 与 handleSelectLocation 的分工：本函数发的是**设备当前坐标**（getLocation 的结果），
   *    handleSelectLocation 发的是**用户在地图上挑的点**（chooseLocation 的结果）。
   *    两者共用同一条落库链路（encodeLocation + content_type='location'）。
   * ⚠️ 拿不到坐标时**不静默失败**：用户是主动点的按钮，必须给出可执行的下一步
   *    （去设置里开权限），而不是让按钮点了没反应。
   */
  const handleSendMyLocation = async () => {
    if (!conversationId) return;
    if (sendingMyLocation) return;
    if (!currentLocation) {
      console.warn('[chat] ⚠️ 当前位置不可用，引导用户检查授权');
      Taro.showModal({
        title: '无法获取当前位置',
        content: '可能是未授权位置权限，或手机定位服务未开启。请在「微信 → 我 → 设置 → 隐私 → 授权管理」中允许本小程序使用位置信息，并确认手机定位已打开，然后重新进入本页。',
        confirmText: '知道了',
        showCancel: false,
      });
      return;
    }
    logDbg('[chat] 📡 发送我的位置:', currentLocation.lat, currentLocation.lng);
    setSendingMyLocation(true);
    Taro.showLoading({ title: '发送中...' });
    try {
      await sendMessage(
        conversationId,
        encodeLocation(currentLocation),
        'location',
        undefined,
        replyTo ? { id: replyTo.id, content: quoteSummary(replyTo) } : undefined,
      );
      bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
      setReplyTo(null);
      sendTypingSignal('stop'); // 这条已送达，撤掉对方的「正在输入…」
      await fetchMessages(conversationId);
      logDbg('[chat] ✅ 我的位置发送完成，列表已刷新');
      Taro.hideLoading();
      Taro.showToast({ title: '发送成功', icon: 'success' });
    } catch (e: any) {
      try { Taro.hideLoading(); } catch {}
      const msg = (e as Error).message || '';
      console.error('[chat] ❌ 发送我的位置失败:', msg);
      if (msg.includes('已被删除')) {
        await handleConversationGone('位置发送被 messages INSERT RLS 拒绝', '该会话已删除');
        return;
      }
      Taro.showToast({ title: msg || '发送失败，请稍后重试', icon: 'none' });
    } finally {
      setSendingMyLocation(false);
    }
  };

  /**
   * where 指令：对方发来纯文本 where → 本端自动把当前位置发回去。
   *
   * ⚠️ 与 handleSendMyLocation 的分工：那个是「用户点按钮」的入口，会弹授权引导弹窗；
   *    本函数是**被动触发**（对方发 where），绝不能弹任何模态框——用户没做任何操作，
   *    突然弹窗会莫名其妙。拿不到坐标时只打日志 + 给对方回一条文字说明，让请求方知道原因。
   * ⚠️ 必须去重（handledWhereIds）：Realtime 与轮询两条通道会拿到同一条消息。
   * ⚠️ 必须用 ref 防重入：定位是异步的，两条通道几乎同时到达时 state 还没更新。
   */
  const handleWhereCommand = async (msg: Message) => {
    if (!conversationId) return;
    if (handledWhereIds.has(msg.id)) {
      logDbg('[chat] 📡 where 指令已处理过，跳过重复触发:', msg.id);
      return;
    }
    // ⚠️【登记去重必须在防重入检查之后】旧实现先 `add` 再判 `autoWhereSendingRef`，
    //    于是「正在回发中」被挡掉的那条 where 会被**永久标记为已处理却从未回发**：
    //    它既不会重试（handledWhereIds 命中直接 return），也不会被进页自愈补上
    //    （自愈只补隐藏行、不回发位置）→ A 永远等不到位置。
    //    正确顺序：先确认「本次真的会执行」，再登记。
    if (autoWhereSendingRef.current) {
      logDbg('[chat] 📡 where 指令正在回发中，跳过本次（不登记去重，留待下次触发）:', msg.id);
      return;
    }
    handledWhereIds.add(msg.id);
    autoWhereSendingRef.current = true;
    logDbg('[chat] 📡 收到 where 指令，自动回发当前位置:', msg.id);
    // 暗号链路：B 端不该看到 A 发来的 where —— 立刻登记隐藏（隐藏行归属 B 自己）。
    // ⚠️ 本地立即移除，不等下一次 fetchMessages，避免可见窗口。
    // ⚠️ 必须 await 落库：线上实测发现 fire-and-forget 的写法会让隐藏行**根本没写进去**
    //    （message_visibility 里查不到任何归属接收方的行），于是 B 重新进页时
    //    listMessages 查不到隐藏行、那条 where 又冒出来 —— 用户报的「上线后还是能看到」。
    //    而 handledWhereIds 是模块级去重集合，同一条 where 不会二次触发，所以写失败就永不补写。
    const meForHide = useAuthStore.getState().user?.id;
    if (meForHide) {
      useMessagesStore.setState({
        messages: useMessagesStore.getState().messages.filter((m) => m.id !== msg.id),
      });
      logDbg('[chat] 🙈 已从本端列表移除对方发来的 where，开始登记隐藏:', msg.id);
      try {
        await messagesApi.hideMessageForPeer(msg.id, meForHide);
        logDbg('[chat] ✅ 隐藏行已落库，B 端重新进页也不会再看到这条 where:', msg.id);
      } catch (e: any) {
        console.warn('[chat] ⚠️ 隐藏对方发来的 where 失败，重试一次:', (e as Error)?.message || e);
        try {
          await messagesApi.hideMessageForPeer(msg.id, meForHide);
          logDbg('[chat] ✅ 重试成功，隐藏行已落库:', msg.id);
        } catch (e2: any) {
          // 仍失败也不阻断主流程：进页自愈（healPeerWhereVisibility）会在下次进页补写
          console.error('[chat] ❌ 隐藏对方发来的 where 两次均失败，交由进页自愈补写:', (e2 as Error)?.message || e2);
        }
      }
    }
    try {
      // 进页时已自动定位过；若当时失败（未授权/定位关闭）则此刻再试一次，
      // 用户可能刚在系统里打开了定位开关。
      let loc = currentLocation;
      if (!loc) {
        logDbg('[chat] 📡 where 指令：内存无坐标，重新定位一次');
        loc = await getCurrentLocation();
        if (loc) {
          setCurrentLocation(loc);
          setLocationResolved(true);
        }
      }
      if (!loc) {
        console.warn('[chat] ⚠️ where 指令：拿不到当前位置，回一条文字说明（不弹窗打扰）');
        await sendMessage(conversationId, '我这边暂时拿不到位置，请检查定位权限后重试', 'text');
        return;
      }
      const sent = await sendMessage(conversationId, encodeLocation(loc), 'location');
      // 暗号链路：B 端看不到自己回的这条位置 —— 由 B 自己（发送者，有权限）插入隐藏记录。
      // ⚠️ 必须用 sendMessage 返回的真实行 id，不能用乐观占位 id（temp- 前缀不是合法 UUID）。
      const me = useAuthStore.getState().user?.id;
      if (me) {
        try {
          await messagesApi.hideMessageForSelf(sent.id, me);
        } catch (e: any) {
          console.warn('[chat] ⚠️ 隐藏自动回发的位置失败（静默）:', (e as Error)?.message || e);
        }
        // ⚠️ 本地立即移除，不等下面的 fetchMessages：否则从「位置上屏」到「重新拉取完成」
        //    之间有一个可见窗口，用户会看到自己回的位置先出现、过一会儿才消失。
        useMessagesStore.setState({
          messages: useMessagesStore.getState().messages.filter((m) => m.id !== sent.id),
        });
        logDbg('[chat] 🙈 已从本端列表移除自动回发的位置:', sent.id);
      }
      // 发 ack 让 A 隐藏那条 where（A 是发送者，只有 A 有权限隐藏它）
      await sendMessage(conversationId, encodeWhereAck(msg.id), 'text');
      bumpGuard(genRef.current);
      sendTypingSignal('stop');
      await fetchMessages(conversationId);
      logDbg('[chat] ✅ where 指令：位置已自动回发并隐藏，ack 已发出');
    } catch (e: any) {
      console.error('[chat] ❌ where 指令自动回发位置失败:', (e as Error)?.message || e);
    } finally {
      autoWhereSendingRef.current = false;
    }
  };

  /**
   * 启动 where 等待状态（A 端发出 where 后调用）。
   *
   * 【为什么超时只切文案、不清状态】超时**不代表失败**——B 可能只是定位慢或刚进页。
   * 若超时直接隐藏提示，A 会以为「什么都没发生」；保留一行「对方暂未回应，可能不在线」
   * 才能回答用户的问题「B 是没在线还是没回」。收到 ack 时仍会正常清除（状态机允许 timeout → idle）。
   *
   * ⚠️ 必须重置已有计时器：A 可能连续发多条 where，旧计时器不清会在新等待期间提前触发超时。
   */
  const startWhereWait = () => {
    if (whereWaitTimerRef.current) {
      clearTimeout(whereWaitTimerRef.current);
      whereWaitTimerRef.current = null;
    }
    setWhereWaitStatus('waiting');
    logDbg(`[chat] 📡 where 等待状态已启动（${WHERE_WAIT_TIMEOUT_MS / 1000}s 后转超时文案）`);
    whereWaitTimerRef.current = setTimeout(() => {
      whereWaitTimerRef.current = null;
      setWhereWaitStatus('timeout');
      logDbg('[chat] 📡 where 等待超时：未收到对方 ack，切换为「对方暂未回应」文案');
    }, WHERE_WAIT_TIMEOUT_MS);
  };
  // 供 onSendText 通过 ref 调用（避免 TDZ）
  startWhereWaitRef.current = startWhereWait;

  /**
   * 清除 where 等待状态（收到 ack / 离开页面时调用）。
   *
   * ⚠️ 必须同时清计时器：只 setState 不清 timer，超时回调仍会在之后触发，
   *    把已经清除的状态又改回 timeout（用户会看到提示「自己冒出来」）。
   */
  const clearWhereWait = () => {
    if (whereWaitTimerRef.current) {
      clearTimeout(whereWaitTimerRef.current);
      whereWaitTimerRef.current = null;
    }
    setWhereWaitStatus((prev) => {
      if (prev !== 'idle') logDbg('[chat] 📡 where 等待状态已清除（收到对方回应）');
      return 'idle';
    });
  };

  /**
   * 暗号回执（where_ack）：A 端收到 B 的 ack 后，把**自己发的那条 where** 隐藏掉。
   *
   * 【为什么由 A 自己隐藏】message_visibility 的 INSERT RLS 只允许**消息发送者本人**
   * 插入隐藏行——B 不是那条 where 的发送者，无权隐藏它。所以 B 回发位置时顺带发一条
   * ack 信号，把「隐藏这条 where」这件事交回给发送者 A 自己完成。
   * 这样既满足 RLS 约束，又不需要放宽权限（放宽会让任一方都能隐藏对方的消息）。
   *
   * ⚠️ 必须去重：Realtime 与轮询两条通道会重复送达同一条 ack。
   * ⚠️ 失败静默：隐藏失败最多让 A 多看到一次自己发的 where，不影响任何主流程。
   */
  const handleWhereAck = async (msg: Message) => {
    const whereId = decodeWhereAck(msg.content);
    if (!whereId) return;
    if (handledWhereAckIds.has(msg.id)) return;
    handledWhereAckIds.add(msg.id);
    // 收到 ack = B 已成功回发位置（B 只在发位置成功后才发 ack，见 handleWhereCommand）。
    // 这是 A 端**唯一可靠**的「对方已回应」信号，故在此清除等待状态。
    // ⚠️ 放在去重之后：重复送达的 ack 不该重复触发状态变更。
    clearWhereWait();
    const me = useAuthStore.getState().user?.id;
    if (!me) return;
    logDbg('[chat] 🙈 收到暗号回执，隐藏自己发出的 where:', whereId);
    try {
      await messagesApi.hideMessageForSelf(whereId, me);
      // 本地立即移除，不等下一次 fetchMessages（避免 ack 与列表刷新之间的空窗期里
      // 那条 where 还挂在界面上，用户会看到「自己发的 where 突然消失」的跳变）
      useMessagesStore.setState({
        messages: useMessagesStore.getState().messages.filter((m) => m.id !== whereId),
      });
      logDbg('[chat] ✅ 暗号回执处理完成，where 已从本端列表移除');
    } catch (e: any) {
      console.warn('[chat] ⚠️ 隐藏 where 失败（静默，不影响主流程）:', (e as Error)?.message || e);
    }
  };

  /**
   * 进页自愈：把「对方发来的 where」中**尚未被我隐藏**的那些补写隐藏行。
   *
   * 【为什么需要】实时收到 where 时若隐藏行写入失败（网络抖动、请求被中断），
   * 由于 handledWhereIds 是模块级去重集合，同一条 where 不会二次触发 handleWhereCommand，
   * 那条 where 就会**永久留在 B 的列表里**（用户报的「B 上线后还是能看到 where」）。
   * 本函数在每次进页时兜底补写，保证最终一致。
   *
   * 【判据】取「对方发来的全部 where」与「我已隐藏的消息 id」的差集，逐条补写。
   * 差集为空时零额外开销（只多一次隐藏集查询，与 listMessages 共用同一张表）。
   */
  const healPeerWhereVisibility = async () => {
    if (!conversationId) return;
    const me = useAuthStore.getState().user?.id;
    if (!me) return;
    try {
      const [peerMsgs, hiddenIds] = await Promise.all([
        messagesApi.listPeerWhereCommands(conversationId, me),
        messagesApi.listHiddenMessageIds(conversationId, me),
      ]);
      const wheres = peerMsgs.filter((m) => isWhereCommand(m));
      const missing = wheres.filter((m) => !hiddenIds.has(m.id));
      if (missing.length === 0) {
        logDbg('[chat] 🩹 进页自愈：对方发来的 where 均已隐藏，无需补写');
        return;
      }
      logDbg('[chat] 🩹 进页自愈：发现', missing.length, '条未隐藏的 where，开始补写隐藏行');
      for (const w of missing) {
        try {
          await messagesApi.hideMessageForPeer(w.id, me);
          logDbg('[chat] 🩹 进页自愈：已补写隐藏行:', w.id);
        } catch (e: any) {
          console.warn('[chat] ⚠️ 进页自愈：补写隐藏行失败（静默）:', w.id, (e as Error)?.message || e);
        }
      }
      // 补写完成后本地同步移除，避免这些 where 在本次会话里继续显示
      const missingIds = new Set(missing.map((m) => m.id));
      useMessagesStore.setState({
        messages: useMessagesStore.getState().messages.filter((m) => !missingIds.has(m.id)),
      });
      logDbg('[chat] ✅ 进页自愈完成：未隐藏的 where 已全部补写并从本端列表移除');
    } catch (e: any) {
      console.warn('[chat] ⚠️ 进页自愈失败（静默，不影响主流程）:', (e as Error)?.message || e);
    }
  };

  /**
   * 离线补发暗号：B 下次进入本页时，把「对方发来但还没回过位置」的 where 补上。
   *
   * 【为什么需要】Realtime 推不到已退出/被冻结的小程序，B 离线时收到 where 不会自动回位置。
   * 用户明确要求「不在线可返回最近一次进入聊天页面时自动获取的位置信息」，
   * 故在进页时补一次。
   *
   * 【怎么判断「还没回过」】取「对方发来的最后一条 where」与「我发出的最后一条位置消息」比时间：
   * where 更晚 → 说明这条 where 之后我还没回过位置，需要补发。
   * ⚠️ 不能用 message_visibility 反查（B 无权隐藏 A 的消息，那条记录根本写不进去）。
   *
   * 【位置从哪来】优先用本地存储的「最近一次位置」（用户要求的语义）；
   * 本机没有记录（换设备/清缓存/从未授权）时退回重新定位一次。
   */
  const checkAndReplyPendingWhere = async () => {
    if (!conversationId) return;
    if (pendingWhereReplyRef.current) {
      logDbg('[chat] 📡 离线补发暗号进行中，跳过本次');
      return;
    }
    const me = useAuthStore.getState().user?.id;
    if (!me) return;
    pendingWhereReplyRef.current = true;
    try {
      const peerMsgs = await messagesApi.listPeerWhereCommands(conversationId, me);
      const wheres = peerMsgs.filter((m) => isWhereCommand(m));
      if (wheres.length === 0) {
        logDbg('[chat] 📡 离线补发暗号：本会话没有对方发来的 where，跳过');
        return;
      }
      const lastWhere = wheres[wheres.length - 1];
      // ⚠️ 这条日志是「A 看不到 B 回的位置」类问题的第一诊断依据：
      //    必须能看出「拿到的是哪条 where、它是什么时候发的」。
      //    若这里打印的时间远早于用户刚发的那条，说明查询被 limit 截断（见 listPeerWhereCommands 注释）。
      logDbg(
        `[chat] 📡 离线补发暗号：对方 where 共 ${wheres.length} 条，最后一条 id=${lastWhere.id} 时间=${lastWhere.created_at}`,
      );
      const myLastLocAt = await messagesApi.getMyLastLocationSentAt(conversationId, me);
      logDbg(`[chat] 📡 离线补发暗号：我最后一条位置时间=${myLastLocAt ?? '(从未发过)'}`);
      if (myLastLocAt && new Date(myLastLocAt).getTime() >= new Date(lastWhere.created_at).getTime()) {
        logDbg('[chat] 📡 离线补发暗号：最后一条 where 之后已回过位置，无需补发');
        return;
      }
      logDbg('[chat] 📡 离线补发暗号：发现待回复的 where，准备补发位置:', lastWhere.id);
      // 位置来源：本地存储的最近一次位置优先（用户要求的语义），没有则重新定位
      let loc: LocationPayload | null = readLastLocation();
      if (loc) {
        logDbg('[chat] 📡 离线补发暗号：使用本地记录的最近一次位置');
      } else {
        logDbg('[chat] 📡 离线补发暗号：本机无位置记录，重新定位一次');
        loc = await getCurrentLocation();
        if (loc) saveLastLocation(loc);
      }
      if (!loc) {
        console.warn('[chat] ⚠️ 离线补发暗号：拿不到位置，回一条文字说明（不弹窗打扰）');
        await sendMessage(conversationId, '我这边暂时拿不到位置，请检查定位权限后重试', 'text');
        return;
      }
      const sent = await sendMessage(conversationId, encodeLocation(loc), 'location');
      // B 端看不到自己回的这条位置：由 B 自己（发送者，有权限）插入隐藏记录
      await messagesApi.hideMessageForSelf(sent.id, me);
      // ⚠️ 本地立即移除，不等下面的 fetchMessages（否则位置会先上屏、过一会儿才消失）
      useMessagesStore.setState({
        messages: useMessagesStore.getState().messages.filter((m) => m.id !== sent.id),
      });
      logDbg('[chat] 🙈 已从本端列表移除离线补发的位置:', sent.id);
      // 发 ack 让 A 隐藏那条 where（A 是发送者，只有 A 有权限隐藏它）
      await sendMessage(conversationId, encodeWhereAck(lastWhere.id), 'text');
      bumpGuard(genRef.current);
      sendTypingSignal('stop');
      await fetchMessages(conversationId);
      logDbg('[chat] ✅ 离线补发暗号完成：位置已补发并隐藏，ack 已发出');
    } catch (e: any) {
      console.error('[chat] ❌ 离线补发暗号失败:', (e as Error)?.message || e);
    } finally {
      pendingWhereReplyRef.current = false;
    }
  };

  const formatTime = useCallback((iso: string) => {
    const d = new Date(iso);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${h}:${m}`;
  }, []);

  /** 消息列表日期分隔头：跨天时插入居中灰字（今天/昨天/周X/MM-DD，跨年带年份），
   * 与会话列表 formatTime 分级口径一致。同一天多条消息只出现一个头。 */
  // ⚠️ 这两个是纯函数（不依赖任何 state），用 useCallback 固定引用：
  //    消息列表每行都会调它们，引用稳定后行内闭包不会因父组件 tick 而全部重建。
  const dateKey = useCallback((iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }, []);
  const formatDateHeader = useCallback((iso: string): string => {
    const d = new Date(iso);
    const now = new Date();
    const dayDiff = Math.floor(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
        new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
        86400000,
    );
    if (dayDiff <= 0) return '今天';
    if (dayDiff === 1) return '昨天';
    if (dayDiff < 7) {
      const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return weekNames[d.getDay()];
    }
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() < now.getFullYear() ? `${d.getFullYear()}-${mm}-${dd}` : `${mm}-${dd}`;
  }, []);

  // 消息的引用摘要文本（非文字消息用类型占位符表示）
  const quoteSummary = useCallback((msg: Message) => {
    // 暗号回执是纯信号，不该被引用；真被引用时给个中性占位而不是露出协议串
    if (isWhereAck(msg)) return '[暗号]';
    if (msg.content_type === 'text') return msg.content;
    if (msg.content_type === 'emoji') return `[表情] ${msg.content}`;
    if (msg.content_type === 'image') return '[图片]';
    if (msg.content_type === 'voice') return '[语音]';
    if (msg.content_type === 'file') return `[文件] ${msg.content}`;
    // 位置：content 是 JSON 串，引用条里必须显示地点名而不是原始 JSON
    if (msg.content_type === 'location') {
      const loc = decodeLocation(msg.content);
      return loc ? `${LOCATION_LABEL} ${locationTitle(loc)}` : LOCATION_LABEL;
    }
    return msg.content;
  }, []);
  // 供 onSendText 通过 ref 调用（避免 TDZ）
  quoteSummaryRef.current = quoteSummary;

  /**
   * 引用气泡内点击：滚动定位到被引用的原消息并短暂高亮。
   *
   * ⚠️ 用 ScrollView 的 `scroll-into-view`（小程序原生能力）而不是自己算 scrollTop：
   *    消息行高随文本长短/图片语音异步撑开而变，按行高累加估算误差可达数百 px。
   * ⚠️ 定位期间必须暂停「新消息自动滚底」跟随（locatingRef + atBottomRef），
   *    否则定位后一条新消息到达会把视图拽回底部，用户根本看不到高亮。
   * ⚠️ 三种「找不到」要分开提示，不能都报「已删除」：
   *    ① 消息确实不在列表里（被彻底删除）→ 原消息已删除；
   *    ② 消息在更早的分页里（hasMoreOlder）→ 引导先加载更多；
   *    ③ 其余情况按已删除处理。
   */
  const onQuoteTap = useCallback((messageId: string) => {
    const target = messages.find((m) => m.id === messageId);
    if (!target) {
      logDbg('[chat] 🔍 引用定位失败：目标消息不在当前列表', messageId, 'hasMoreOlder=', hasMoreOlder);
      Taro.showToast({
        title: hasMoreOlder ? '原消息在更早的历史里，请先加载更多' : '原消息已删除',
        icon: 'none',
      });
      return;
    }
    const rowId = `msg-row-${messageId}`;
    logDbg('[chat] 🔍 引用定位：滚动到原消息', messageId);
    // 暂停自动跟随，并登记为程序滚动（避免 onScroll 把这次滚动误判成用户上翻）
    locatingRef.current = true;
    atBottomRef.current = false;
    scrollArmedRef.current = true;
    setScrollIntoViewId(rowId);
    setHighlightId(messageId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightId('');
      highlightTimerRef.current = null;
    }, 1600);
    // 定位完成后恢复跟随：清掉 scroll-into-view（否则后续滚底会被它反复拉回原消息），
    // 并解除程序滚动登记，让用户后续手势能正常接管贴底判定。
    setTimeout(() => {
      locatingRef.current = false;
      setScrollIntoViewId('');
      scrollArmedRef.current = false;
      atBottomRef.current = true;
    }, 2000);
  }, [messages, hasMoreOlder]);

  // 名称文字宽度测量：在线圆点与「3 连点返回」热区都要贴着名字右缘，
  // 而名字长度随昵称变化，故用 createSelectorQuery 量出真实宽度后按 px 定位。
  // ⚠️ 不用 onLayout —— 本项目的 Taro ViewProps 类型里没有该属性（tsc TS2322）。
  // ⚠️ 必须 .in(page)：页面级 query 不指定作用域时小程序端可能取不到节点。
  // 依赖 displayPeerName：昵称变化（资料到达/切换会话）后重新量一次。
  useEffect(() => {
    if (!displayPeerName) return;
    const t = setTimeout(() => {
      try {
        const query = Taro.createSelectorQuery().in(Taro.getCurrentInstance().page as any);
        query.select('#chat-peer-name').boundingClientRect();
        query.exec((res: any) => {
          const rect = Array.isArray(res) ? res[0] : null;
          const w = rect ? Math.round(rect.width) : 0;
          if (w > 0) {
            setNameTextWidth(w);
            logDbg('[chat] 名称文字宽度:', w, '→ 连点热区与在线圆点均按此宽度贴合名字右缘');
          } else {
            logDbg('[chat] ⚠️ 名称宽度测量为空，热区回退 fit-content');
          }
        });
      } catch (e) {
        logDbg('[chat] 名称宽度测量跳过:', e);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [displayPeerName]);

  // 气泡自适应诊断日志(仅微信端):验证 fit-content 收缩是否生效,短消息不应撑满75%宽
  useEffect(() => {
    if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP || messages.length === 0) return;
    const t = setTimeout(() => {
      try {
        const query = Taro.createSelectorQuery().in(Taro.getCurrentInstance().page as any);
        query.select('#msg-bubble-last').boundingClientRect();
        query.exec((res: any) => {
          const rect = Array.isArray(res) ? res[0] : null;
          if (rect) logDbg('[chat] 最后一条气泡宽度:', Math.round(rect.width), '屏宽:', getWindowInfo().windowWidth);
        });
      } catch (e) {
        logDbg('[chat] 气泡宽度测量跳过:', e);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [messages.length]);

  // 会话内全部图片消息 url（按时间正序，排除加载失败/待发送的行）——供放大查看器左右翻页
  // ⚠️ 必须 useMemo：本页 tick 频繁（在线/统计/撤回倒计时），每次重渲染都重扫一遍消息数组
  //    在长会话下是纯浪费；且 openImageViewer 依赖它的引用稳定性。
  const imageUrls = useMemo(
    () =>
      messages
        .filter((m) => m.content_type === 'image' && m.media_url && !m.revoked_at && !imgErrorIds.has(m.id))
        .map((m) => m.media_url as string),
    [messages, imgErrorIds],
  );

  /** 打开图片放大查看：小程序走原生 previewImage（自带左右滑动+缩放），H5 走页面内翻页弹层 */
  // ⚠️ useCallback：它被消息列表里每条图片气泡的 onClick 引用，若每次渲染都新建，
  //    长会话下所有图片气泡的 props 全部变化，等于白做 memo。
  const openImageViewer = useCallback((url: string) => {
    bumpGuard(genRef.current);
    const urls = imageUrls.length > 0 ? imageUrls : [url];
    const idx = Math.max(0, urls.indexOf(url));
    if (Taro.getEnv() === Taro.ENV_TYPE.WEAPP) {
      logDbg(`[chat] 🔍 previewImage 放大查看, 共 ${urls.length} 张, 当前第 ${idx + 1} 张`);
      // previewImage 是原生全屏视图，拉起/退出会触发 App 级 onAppHide/onAppShow，
      // 不豁免的话用户看个照片回来就被弹防护罩
      setNativePreviewGrace();
      Taro.previewImage({ current: url, urls }).catch((e: any) =>
        console.warn('[chat] previewImage 异常:', e),
      );
      return;
    }
    logDbg(`[chat] 🔍 H5 图片放大查看, 共 ${urls.length} 张, 当前第 ${idx + 1} 张`);
    setZoomViewer({ urls, index: idx });
  }, [imageUrls]);

  /** 转发图片给朋友：先弹二次确认，确认后把已上传的图片 url 原样作为新图片消息再发一条（无需重新上传） */
  const handleForwardImage = useCallback((url: string) => {
    Taro.showModal({
      title: '发送图片给朋友',
      content: `确定把这张图片发送给 ${displayPeerName} 吗？`,
      confirmText: '发送',
      cancelText: '取消',
      success: (res) => {
        if (!res.confirm) {
          logDbg('[chat] 用户取消转发图片');
          return;
        }
        logDbg('[chat] ↪️ 二次确认通过，转发图片给朋友:', url);
        void onSendImage(url);
      },
    }).catch((e: any) => console.warn('[chat] showModal 异常:', e));
  }, [displayPeerName, onSendImage]);
  // 同上：供 onMsgTouchStart 通过 ref 调用
  forwardImageRef.current = handleForwardImage;

  const renderMessageContent = useCallback((msg: Message, isMine: boolean) => {
    // 暗号回执（where_ack）是纯信号：不渲染任何气泡内容。
    // ⚠️ 必须在 switch 之前拦截——它的 content_type 是 'text'，会走 text 分支把
    //    `where_ack:<uuid>` 原样显示出来（用户会看到一串内部协议串）。
    if (isWhereAck(msg)) return null;
    switch (msg.content_type) {
      case 'image':
        if (!msg.media_url || imgErrorIds.has(msg.id)) {
          // 【逐张进度】temp 占位行（media_url 为空）在气泡内显示该张自己的进度，
          // 取代旧版全局 showLoading 的「上传中 n/N」—— 用户能看出是哪一张卡住了。
          const prog = msg.id.startsWith('temp-') ? imageProgress[msg.id] : undefined;
          if (prog && (prog.stage === 'compressing' || prog.stage === 'uploading')) {
            return (
              <View
                className="rounded-lg bg-muted flex flex-col items-center justify-center gap-2"
                style={{ width: '160px', height: '120px' }}
              >
                <Text className={`text-xs leading-none ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                  {prog.stage === 'compressing' ? '压缩中' : `上传中 ${prog.percent}%`}
                </Text>
                {/* 轨道 + 填充：宽度用 inline style（禁用 Tailwind 任意值），半透明也必须 inline */}
                <View className="w-full rounded-full overflow-hidden" style={{ height: '4px', backgroundColor: 'rgba(255, 255, 255, 0.35)' }}>
                  <View
                    className="h-full rounded-full"
                    style={{
                      width: `${prog.percent}%`,
                      backgroundColor: isMine ? '#ffffff' : 'var(--primary)',
                      transition: 'width 200ms ease-out',
                    }}
                  />
                </View>
              </View>
            );
          }
          return (
            <View
              className="rounded-lg bg-muted flex items-center justify-center"
              style={{ width: '160px', height: '120px' }}
            >
              <Text className={`text-xs ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                {msg.media_url ? '图片加载失败' : prog?.stage === 'cancelled' ? '已取消' : '图片待发送'}
              </Text>
            </View>
          );
        }
        return (
          <Image
            src={msg.media_url}
            mode="widthFix"
            lazy-load
            className="rounded-lg max-w-full"
            style={{ maxWidth: '200px' }}
            onError={() => setImgErrorIds((prev) => (prev.has(msg.id) ? prev : new Set(prev).add(msg.id)))}
            onClick={() => {
              // 点图放大：小程序端 previewImage 全屏预览（左右滑动看多图、双指缩放）；
              // H5 端该 API 不支持，降级为页面内自绘翻页弹层。
              const url = msg.media_url;
              if (!url) return;
              openImageViewer(url);
            }}
          />
        );
      case 'emoji':
        return (
          <Text className={`text-3xl ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
            {msg.content}
          </Text>
        );
      case 'file': {
        // 文件气泡：图标 + 文件名 + 体积，点击走 openFileMessage（下载→系统文档预览，
        // 内部已接批次级豁免，避免 openDocument 拉起系统界面时误弹防护罩）
        const fname = msg.content || '未命名文件';
        const iconCls = fileIconClass(fname);
        return (
          <View
            onClick={() => {
              const url = msg.media_url;
              if (!url) {
                Taro.showToast({ title: '文件尚未上传完成', icon: 'none' });
                return;
              }
              logDbg('[chat] 📎 点击文件气泡，准备打开:', fname);
              void openFileMessage(url, fname);
              bumpGuard(genRef.current);
            }}
            className="flex flex-row items-center gap-2 cursor-pointer"
            style={{ width: '200px' }}
          >
            <View
              className={`shrink-0 rounded-lg ${isMine ? 'bg-primary' : 'bg-muted'} w-9 h-9 flex items-center justify-center`}
            >
              {/* 图标类名必须是字面量：动态拼接 Tailwind 扫不到、不会打包 */}
              <View className={`${iconCls} w-5 h-5 ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`} />
            </View>
            <View className="flex-1 overflow-hidden">
              <Text className={`text-sm leading-none truncate ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
                {fname}
              </Text>
              <Text className={`text-xs leading-none mt-1 block ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                {msg.media_url ? '点击查看' : '上传中…'}
              </Text>
            </View>
          </View>
        );
      }
      case 'location': {
        // 位置气泡：纯文字卡片（地图针图标 + 地点名 + 详细地址），点击拉起原生地图查看/导航。
        //
        // ⚠️ 这里**刻意不画地图缩略图**：国内主流地图厂商（腾讯/高德）的静态地图接口
        //    全部强制要求 key，无 key 时返回的是 JSON 而非图片，而 <Image> 拿到 JSON
        //    既不报错也不渲染、只留一片空白（用户报「位置卡片没有地图」的根因）。
        //    与其依赖第三方 key，不如把卡片做成零依赖的纯文字版式——微信原生地图
        //    本身就能看地图、能导航，缩略图只是装饰。
        //
        // ⚠️ content 是 JSON 串，必须走 decodeLocation 解析；脏数据降级成占位块，
        //    绝不能让 JSON.parse 异常冒到渲染层（会让整条消息列表白屏）。
        const loc = decodeLocation(msg.content);
        if (!loc) {
          return (
            <View
              className="rounded-lg bg-muted flex items-center justify-center"
              style={{ width: '180px', height: '80px' }}
            >
              <Text className={`text-xs ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                位置信息不可用
              </Text>
            </View>
          );
        }
        const title = locationTitle(loc);
        const subtitle = locationSubtitle(loc);
        return (
          <View
            onClick={() => {
              logDbg('[chat] 📍 点击位置气泡，拉起地图查看:', title);
              bumpGuard(genRef.current);
              void openLocationOnMap(loc).then((ok) => {
                if (!ok) {
                  // H5 预览 / 拉起失败：给出明确提示，不静默无反应
                  Taro.showToast({ title: '请在微信小程序中查看地图', icon: 'none' });
                }
              });
            }}
            className="flex flex-row items-center gap-2 cursor-pointer"
            style={{ width: '200px' }}
          >
            {/* 图标块：与文件消息卡片同款版式（圆角方形 + 居中图标），
                底色随气泡归属切换，保证聊天流里各类卡片观感统一。 */}
            <View
              className={`shrink-0 rounded-lg ${isMine ? 'bg-primary' : 'bg-muted'} w-9 h-9 flex items-center justify-center`}
            >
              <View className={`i-lucide-map-pin w-5 h-5 ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`} />
            </View>
            <View className="flex-1 overflow-hidden">
              <Text className={`text-sm leading-none truncate ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
                {title}
              </Text>
              <Text
                className={`text-xs leading-tight mt-1 block ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}
                style={{
                  display: '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  overflow: 'hidden',
                }}
              >
                {subtitle}
              </Text>
              <Text className={`text-xs leading-none mt-1 block ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                点击查看地图
              </Text>
            </View>
          </View>
        );
      }
      case 'voice': {
        const isPlaying = playingVoiceId === msg.id;
        // 转写文本（仅本机）：有结果或正在识别时才在气泡下方画一块可点按折叠区。
        // ⚠️ 这里展示的内容绝不参与 messages.content——那条字段是时长串 [12s]。
        const transcript = transcripts[msg.id];
        const isTranscribing = transcribingId === msg.id;
        const expanded = expandedTranscripts.has(msg.id);
        const failed = typeof transcript === 'string' && transcript.startsWith('⚠️');
        return (
          <View className="flex flex-col">
            <View
              onClick={() => msg.media_url && playVoice(msg.id, msg.media_url)}
              className="flex flex-row items-center gap-2 cursor-pointer"
            >
              {/* 类名必须字面量三元：动态拼接 `i-lucide-${...}` Tailwind 扫描不到，
                  实测 dist/app-origin.wxss 里 .i-lucide-play/.i-lucide-pause 均缺失，图标渲染为空白 */}
              <View className={isPlaying ? 'i-lucide-pause w-5 h-5' : 'i-lucide-play w-5 h-5'} />
              <Text className={`text-sm ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
                {msg.content}
              </Text>
              {isPlaying && (
                <View className="ml-1">
                  <View className="i-lucide-volume-2 w-4 h-4 animate-pulse" />
                </View>
              )}
            </View>
            {(isTranscribing || transcript) && (
              <View
                onClick={() => {
                  if (isTranscribing) return;
                  toggleTranscript(msg.id);
                }}
                className="mt-2 rounded-lg px-3 py-2"
                style={{
                  backgroundColor: isMine ? 'rgba(255, 255, 255, 0.16)' : 'var(--muted)',
                }}
              >
                {isTranscribing ? (
                  <View className="flex flex-row items-center gap-2">
                    <View className="i-lucide-loader-2 w-4 h-4 animate-spin" />
                    <Text className={`text-xs leading-none ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                      正在识别语音…
                    </Text>
                  </View>
                ) : (
                  <>
                    {/* 标题行：左「文字转换 + 折叠箭头」，右「字号 / 复制」两个小按钮。
                        按钮必须 e.stopPropagation()，否则点它会连带触发整块折叠/展开。 */}
                    <View className="flex flex-row items-center gap-1">
                      <Text
                        className={`text-xs leading-none ${failed ? '' : isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}
                        style={failed ? { color: '#f87171' } : undefined}
                      >
                        {failed ? '识别失败' : '文字转换'}
                      </Text>
                      {!failed && (
                        <View className={`i-lucide-chevron-${expanded ? 'up' : 'down'} w-3 h-3`} />
                      )}
                      {!failed && expanded && (
                        <Text className={`text-xs leading-none ml-1 ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                          {transcript.replace(/^⚠️\s*/, '').length} 字
                        </Text>
                      )}
                      <View className="flex-1" />
                      {!failed && (
                        <>
                          <View
                            onClick={(e) => {
                              e.stopPropagation();
                              cycleTranscriptFont();
                            }}
                            className="px-2 py-1 rounded-full active:opacity-60"
                            style={{ backgroundColor: isMine ? 'rgba(255, 255, 255, 0.24)' : 'var(--background)' }}
                          >
                            <Text className={`text-xs leading-none ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
                              {TRANSCRIPT_FONT_LABEL[transcriptFont]}
                            </Text>
                          </View>
                          <View
                            onClick={(e) => {
                              e.stopPropagation();
                              copyTranscript(transcript);
                            }}
                            className="flex flex-row items-center gap-1 px-2 py-1 rounded-full active:opacity-60"
                            style={{ backgroundColor: isMine ? 'rgba(255, 255, 255, 0.24)' : 'var(--background)' }}
                          >
                            <View className="i-lucide-copy w-3 h-3" />
                            <Text className={`text-xs leading-none ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
                              复制
                            </Text>
                          </View>
                        </>
                      )}
                    </View>
                    {failed ? (
                      <View className="mt-1 flex flex-col gap-2">
                        <Text className={`text-xs leading-normal ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
                          {transcript.replace(/^⚠️\s*/, '')}
                        </Text>
                        <View
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleTranscribe(msg.id);
                          }}
                          className="active:opacity-60 self-start px-3 py-1 rounded-full"
                          style={{ backgroundColor: isMine ? 'rgba(255, 255, 255, 0.28)' : 'var(--secondary)' }}
                        >
                          <Text className={`text-xs leading-none ${isMine ? 'text-primary-foreground' : 'text-primary'}`}>
                            重新识别
                          </Text>
                        </View>
                      </View>
                    ) : expanded ? (
                      <Text
                        selectable
                        className={`${TRANSCRIPT_FONT_CLASS[transcriptFont]} leading-relaxed mt-1 block ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}
                        style={{ wordBreak: 'break-word' }}
                      >
                        {transcript}
                      </Text>
                    ) : (
                      <Text className={`text-xs leading-normal mt-1 block ${isMine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                        点击展开全文
                      </Text>
                    )}
                  </>
                )}
              </View>
            )}
          </View>
        );
      }
      default:
        return (
          <Text className={`text-sm ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
            {msg.content}
          </Text>
        );
    }
  }, [
    // 依赖只列「渲染分支里真正读到的外部值」：漏一个就会渲染陈旧内容，
    // 多列一个则失去 memo 意义。新增分支读取新 state 时必须同步补进来。
    imgErrorIds,
    imageProgress,
    playingVoiceId,
    transcripts,
    transcribingId,
    expandedTranscripts,
    transcriptFont,
    handleTranscribe,
    toggleTranscript,
    cycleTranscriptFont,
    copyTranscript,
    openImageViewer,
    handleForwardImage,
    onSendVoice,
  ]);

  // 登录状态加载中显示加载提示（有缓存快照或全局资料时先渲染，auth 就绪后由 effect 后台刷新）
  const hasProfileCache = Object.keys(profileById).length > 0;
  if (!loaded && messages.length === 0 && !hasProfileCache) {
    logDbg('[chat] ⏳ auth 未就绪且无本地缓存，显示加载态');
    return (
      <View className="min-h-screen flex items-center justify-center bg-background">
        <View className="flex flex-col items-center gap-4">
          <View className="i-lucide-loader-2 w-8 h-8 animate-spin text-primary" />
          <Text className="text-muted-foreground text-sm">正在加载...</Text>
        </View>
      </View>
    );
  }
  if (!loaded && (messages.length > 0 || hasProfileCache)) {
    logDbg(`[chat] ⚡ auth 未就绪但已有本地数据(消息 ${messages.length} 条 / 全局资料 ${Object.keys(profileById).length} 份)，跳过加载态直接渲染`);
  }

  // 未登录跳转到登录页
  if (loaded && !user) {
    redirectToLogin();
    return null;
  }

  return (
    <ErrorBoundary route="pages/chat/index">
    <PrivacyShield>
      <View className="min-h-screen flex flex-col bg-background">
        {/* 顶部导航栏 */}
      <View
        className="flex items-center gap-3 px-3 py-3 bg-card border-b border-border"
        style={{ paddingTop: `${statusBarHeight + 12}px`, paddingRight: `${capsuleRightPadding}px` }}
      >
        <View
          onClick={() => {
            handleHiddenClick();
            logDbg('[chat] 点击页面内返回按钮,执行 navigateBack');
            Taro.navigateBack();
          }}
        >
          <View className="i-lucide-chevron-left w-6 h-6 text-foreground" />
        </View>
        {/* 名称区：外层只负责占位与裁剪，**不挂任何事件**，故名称右侧的顶栏空白不可触发返回。
            ⚠️ 热区必须「按名字实测宽度定宽」：只把事件挂在名字块上还不够——名字块是块级元素，
               在 flex 行里会被拉伸到整行宽，于是名字右侧的空白照样能点出返回（用户实测反馈过）。
               故用 nameTextWidth 给名字块显式定宽（量到之前用 fit-content 兜底），
               热区宽度 = 名字宽度，圆点用 left: nameTextWidth 贴在名字右上角。
            「最近在线/离线」文案放名称下方一行，口径与会话列表完全一致（@/lib/online-status）。 */}
        <View className="flex-1 overflow-hidden flex items-center">
          <View className="relative" style={{ maxWidth: '100%' }}>
            <View
              onClick={handleNameTripleClick}
              onLongPress={handleConversationMenu}
              className="relative"
              style={
                nameTextWidth > 0
                  ? { width: `${nameTextWidth}px`, maxWidth: '100%' }
                  : { width: 'fit-content', maxWidth: '100%' }
              }
            >
              <Text id="chat-peer-name" className="text-lg font-bold text-foreground truncate">{displayPeerName}</Text>
              {(() => {
                void onlineTick;
                const ps = resolvePresence(
                  peerProfile?.presence_state,
                  peerProfile?.presence_at,
                  peerProfile?.last_active_at,
                  peerProfile?.hide_presence,
                );
                // 功能⑥：「正在输入…」优先于在场状态——瞬时信号比三态更贴近用户当下意图
                // 配色统一走 presenceDotColor（三态真源）：在线=亮绿、不在当前=琥珀、离线=中灰。
                // ⚠️ 离线现在**也画点**（用户要求三态区分更明显）：旧版离线不画点，
                //    与「老账号无数据」在视觉上无法区分，看起来像渲染缺失。
                const dotColor = peerTyping ? PRESENCE_DOT_COLORS.online : presenceDotColor(ps);
                if (!dotColor) return null;
                // 量到宽度前（首帧）用 inline 让位紧跟文字，量到后按 px 精确贴名字右缘
                return (
                  <View
                    className="absolute top-0 w-2 h-2 rounded-full"
                    style={
                      nameTextWidth > 0
                        ? { backgroundColor: dotColor, left: `${nameTextWidth}px`, marginLeft: '4px' }
                        : { backgroundColor: dotColor, left: '100%', marginLeft: '4px' }
                    }
                  />
                );
              })()}
            </View>
            {/* 状态文案行（「正在输入…」/「在线」/「最近在线…」/「已在线」/登录统计）：
                放在名称块**外面**——它不参与 3 连点热区，也不影响圆点定位；
                宽度跟随名称块（外层 maxWidth 100%），故长文案仍会 truncate 而不是撑破顶栏。 */}
            <View className="relative" style={{ maxWidth: '100%' }}>
              {(() => {
                void onlineTick;
                const ps = resolvePresence(
                  peerProfile?.presence_state,
                  peerProfile?.presence_at,
                  peerProfile?.last_active_at,
                  peerProfile?.hide_presence,
                );
                // 功能⑥：对方正在输入时顶栏文案直接替换（隐藏状态下不显示，见 on 回调门控）
                if (peerTyping) {
                  return (
                    <Text className="text-primary text-xs truncate block leading-none mt-1">{TYPING_LABEL}</Text>
                  );
                }
                // where 暗号等待状态：优先级高于在场状态文案——它是「我刚发起的动作」的即时反馈，
                // 比「对方在线/最近在线」更贴近用户此刻的注意力。
                // ⚠️ 文案与判定都来自 @/lib/where-status，此处只负责渲染，不写 if 分支。
                const whereLabel = whereStatusLabel(whereWaitStatus);
                if (whereLabel) {
                  return (
                    <Text
                      className={`text-xs truncate block leading-none mt-1 ${whereWaitStatus === 'timeout' ? 'text-muted-foreground' : 'text-primary'}`}
                    >
                      {whereLabel}
                    </Text>
                  );
                }
                // 功能⑦：隐藏态必须单独短路，绝不能落到下面的 formatLastSeen——
                // 那会把登录/心跳时间又算出来，等于绕开对方的隐私设置。
                if (ps === 'hidden') {
                  return (
                    <Text className="text-muted-foreground text-xs truncate block leading-none mt-1">
                      {formatPresenceLabel('hidden')}
                    </Text>
                  );
                }
                if (!ps) {
                  // 历史账号无在场记录：回退旧的「最近在线」文案，不给老数据编造状态
                  const seen = formatLastSeen(
                    peerProfile?.last_login_at,
                    peerProfile?.last_logout_at,
                    peerProfile?.last_active_at,
                  );
                  return seen ? (
                    <Text className="text-muted-foreground text-xs truncate block leading-none mt-1">{seen}</Text>
                  ) : null;
                }
                const label = formatPresenceLabel(ps);
                // ⚠️ 缺陷③：四个痕迹**取最新值**（谁最新显示谁），顺序不再代表优先级。
                // 旧版按优先级取第一个，presence_at 卡在陈旧退场时刻时会压过持续刷新的心跳。
                const since = formatPresenceSince(ps, [
                  peerProfile?.presence_at,
                  peerProfile?.last_logout_at,
                  peerProfile?.last_active_at,
                  peerProfile?.last_login_at,
                ]);
                return (
                  <Text className="text-muted-foreground text-xs truncate block leading-none mt-1">
                    {ps === 'online' ? '在线' : since ? `${label} · ${since}` : label}
                  </Text>
                );
              })()}
              {/* 登录统计行（三分支，优先级从上到下）：
                  ① 对方当前在线（我还没退回 ping 页期间 TA 登录了）→ 只显示「已在线」，
                     隐藏窗口次数（用户明确要求：显示在线后就不用显示登录前此用户登录多少次了）。
                  ② 否则窗口内 count>0 → 「你离开期间，TA 登录 N 次 · 最后 …」+「明细」按钮。
                  ③ count=0 → 不占行。
                  ⚠️ 「明细」按钮是独立热区：名称块已挂 onClick(3连点隐藏出口) 与
                  onLongPress(会话菜单)，不能再往名称上叠加手势，故入口只放这一小块的
                  onClick，并 stopPropagation 防止冒泡触发名称块的连点计数。 */}
              {(() => {
                void onlineTick;
                // 三态优先：对方显式上报的在场状态为准，「在线」才隐藏窗口次数；
                // 无在场记录的老账号回退旧的心跳超时判定，保证口径不打架。
                const ps = resolvePresence(
                  peerProfile?.presence_state,
                  peerProfile?.presence_at,
                  peerProfile?.last_active_at,
                  peerProfile?.hide_presence,
                );
                // 功能⑦：隐藏者不暴露「已在线」这类活跃结论，整行不渲染
                if (ps === 'hidden') return null;
                const online = ps ? ps === 'online' : isPeerOnline(
                  peerProfile?.last_login_at,
                  peerProfile?.last_logout_at,
                  peerProfile?.last_active_at,
                );
                if (online) {
                  // 需求：在线状态旁显示「对方本次已在线时长」。
                  // 起点取 presence_at（对方本次上报 online 的时刻），由 30 秒 onlineTick 驱动刷新；
                  // 老账号无 presence_at（走 isPeerOnline 回退口径）时 formatOnlineDuration 返回空串，
                  // 自动退回不带时长的「已在线」，不会出现「已在线 · 」这种残缺文案。
                  const dur = formatOnlineDuration(peerProfile?.presence_at);
                  return (
                    <Text className="text-muted-foreground text-xs truncate block leading-none mt-1">
                      {dur ? `已在线 · ${dur}` : '已在线'}
                    </Text>
                  );
                }
                if (!peerLoginStats || peerLoginStats.count <= 0) return null;
                return (
                  <View className="flex items-center gap-2 mt-1">
                    <Text selectable className="text-muted-foreground text-xs truncate leading-none">
                      {`你离开期间，TA 登录 ${peerLoginStats.count} 次${
                        peerLoginStats.lastLoggedAt ? ` · 最后 ${formatLoginDetailTime(peerLoginStats.lastLoggedAt)}` : ''
                      }`}
                    </Text>
                    <View
                      className="px-2 py-1 rounded bg-secondary shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        logDbg('[chat] 🗂 打开登录明细弹层');
                        bumpGuard(genRef.current);
                        setLoginDetailOpen(true);
                      }}
                    >
                      <Text className="text-xs text-primary leading-none">明细</Text>
                    </View>
                  </View>
                );
              })()}
            </View>
          </View>
        </View>
        {/* 步数对比入口：放在「对方名字那一栏」的右边（名称区之后、顶栏闭合之前）。
            ⚠️ 必须 shrink-0：名称区是 flex-1，不加会被挤压变形。
            ⚠️ 独立热区，不叠加到名称区上——名称区已挂 3 连点隐藏出口与长按会话菜单。 */}
        {!!peerId && !!user && (
          <View
            className="shrink-0 active:opacity-70"
            onClick={() => {
              logDbg('[chat] 👟 打开步数对比卡片');
              bumpGuard(genRef.current);
              setStepsCardOpen(true);
            }}
          >
            <View className="i-lucide-footprints w-6 h-6 text-muted-foreground" />
          </View>
        )}
      </View>

      {/* 多选删除模式工具栏(加大按钮与间距,避免误触) */}
      {selectMode && (
        <View className="flex items-center gap-2 px-4 py-3 bg-secondary border-b border-border">
          <Text className="text-sm text-foreground flex-1">已选 {selectedIds.length} 条</Text>
          <View
            onClick={handleToggleSelectAll}
            className="px-5 py-3 rounded-lg bg-card border border-border active:bg-muted"
          >
            <Text className="text-base text-primary">
              {selectedIds.length === messages.length && messages.length > 0 ? '取消全选' : '全选'}
            </Text>
          </View>
          <View
            onClick={handleDeleteSelected}
            className={`px-6 py-3 rounded-lg ${selectedIds.length > 0 ? 'bg-destructive' : 'bg-muted'}`}
          >
            <Text className={`text-base font-medium ${selectedIds.length > 0 ? 'text-white' : 'text-muted-foreground'}`}>删除</Text>
          </View>
          <View
            onClick={exitSelectMode}
            className="px-5 py-3 rounded-lg bg-card border border-border active:bg-muted"
          >
            <Text className="text-base text-muted-foreground">取消</Text>
          </View>
        </View>
      )}

      {/* 运动步数对比：已改为顶栏「脚印」图标打开的独立弹层（见文件末尾 stepsCardOpen），
          不再常驻消息区上方，避免占用聊天可视高度。 */}

      {/* 消息区 */}
      <View className="flex-1">
        {loading && !msgLoaded ? (
          <View className="flex items-center justify-center py-20">
            <Text className="text-muted-foreground text-sm">加载中...</Text>
          </View>
        ) : loadError && messages.length === 0 ? (
          <View className="flex flex-col items-center justify-center py-20">
            <View className="i-lucide-wifi-off w-14 h-14 text-muted-foreground" />
            <Text className="text-muted-foreground text-sm mt-4">消息加载失败，请检查网络</Text>
            <View
              onClick={() => {
                logDbg('[chat] 点击重试加载消息');
                if (conversationId) fetchMessages(conversationId);
              }}
              className="active:opacity-60 mt-5 px-5 py-2 rounded-full bg-secondary"
            >
              <Text className="text-primary text-sm leading-none">点击重试</Text>
            </View>
          </View>
        ) : messages.length === 0 ? (
          <View className="flex items-center justify-center py-20">
            <Text className="text-muted-foreground text-sm">暂无消息</Text>
          </View>
        ) : (
          <ScrollView
            scrollY
            scrollWithAnimation
            scrollTop={scrollTop}
            scrollIntoView={scrollIntoViewId}
            className="py-4"
            style={{
              // 键盘弹出时:视口 - 键盘高度 - 顶部导航(50px) - 底部输入区(130px)
              // 键盘未弹出:视口 - 顶部导航(50px) - 底部输入区(130px)
              // 在原始扣减值基础上加大48px(约1.5格):消息区变矮后,底部留白把最新消息
              // 从视口底缘向上顶起,自动滚到底时信息停留位置整体上移
              // 表情面板态：面板 240 + 操作栏 48 + 输入行 56 + 导航/安全区余量 98 = 442px。
              // ⚠️ 必须与 `inputAreaH`（EMOJI_PANEL_H + EMOJI_ACTION_BAR_H）同源：
              //    面板高度改了这里也要改，否则最新消息会被面板遮住。
              height: showEmojiPanel
                ? `calc(100vh - ${EMOJI_PANEL_H + EMOJI_ACTION_BAR_H + INPUT_ROW_HEIGHT + 98}px)`
                : keyboardOffset > 0
                  ? `calc(100vh - ${keyboardOffset}px - 228px)`
                  : `calc(100vh - 228px)`,
              // boxSizing:border-box 下 paddingBottom 计入高度内,不会撑破 ScrollView;
              // 键盘弹出时可视区被压缩,加大底部留白让最后一条消息可滚入键盘上方的空白区,
              // 配合滚底 effect 保证最新消息永不被输入区/键盘遮挡
              paddingBottom: keyboardOffset > 0 || showEmojiPanel ? '160px' : '140px'
            }}
            onClick={() => {
              // 长按抬手补发的click落在空白处:消费掉,不退出多选
              if (pendingLongPressRef.current) {
                logDbg('[chat] 滚动区消费长按后的误触click');
                pendingLongPressRef.current = null;
                return;
              }
              // 兜底:触摸层已处理长按标志,此处兼容旧的长按标志位
              if (longPressFiredRef.current) {
                longPressFiredRef.current = false;
                return;
              }
              if (selectMode) {
                logDbg('[chat] 多选模式:点击滚动区空白处退出');
                exitSelectMode();
                return;
              }
              logDbg('[chat] 点击消息区域,隐藏键盘');
              setInputFocus(false);
            }}
            onScroll={(e) => {
              // 贴底判定核心:区分「程序化滚底」与「用户手势滚动」。
              // 程序化 setScrollTop 同样触发本事件,若不加甄别会把每次自动滚底都误判成
              // 「用户回到底部」从而重新武装跟随,导致上翻历史仍被新消息拉回底部。
              const detail = e.detail as { scrollTop: number; scrollHeight: number };
              lastScrollInfoRef.current = { scrollTop: detail.scrollTop, scrollHeight: detail.scrollHeight };
              // ScrollView 自身有 py-4(上下各16px)+底部 paddingBottom 留白,e.detail.scrollHeight
              // 是否含 padding 在不同端实现不一致,故距底阈值放宽到一屏内均视为"接近底部",
              // 用相对量而非绝对像素判断,避免跨端误差把跟随误关。
              const distToBottom = detail.scrollHeight - detail.scrollTop - viewportH;

              if (scrollArmedRef.current) {
                // 已登记为程序滚动:命中目标位置即消费标记跳过判定;
                // 未到位则视为程序滚动进行中,同样不改跟随状态
                if (distToBottom < 80) {
                  scrollArmedRef.current = false;
                  logDbg('[chat] ScrollView滚动(程序化滚底已到位),距底:', Math.round(distToBottom));
                } else {
                  logDbg('[chat] ScrollView滚动(程序化滚底进行中),距底:', Math.round(distToBottom));
                }
                return;
              }

              // 未武装 → 视为用户手势:距底超过 1/3 可视区判定为上翻历史,暂停自动跟随;
              // 回落到阈值内则恢复跟随
              const threshold = Math.max(viewportH / 3, 160);
              const wasAtBottom = atBottomRef.current;
              atBottomRef.current = distToBottom <= threshold;
              if (wasAtBottom !== atBottomRef.current) {
                logDbg('[chat]', atBottomRef.current ? '▶️ 用户回到底部附近,恢复自动跟随' : '⏸️ 用户上滑翻阅历史,暂停自动跟随', '距底:', Math.round(distToBottom), '阈值:', Math.round(threshold));
              }
            }}
          >
            <View className="w-full px-4">
              {/* 历史分页入口：首屏只拉最近一屏，更早的消息在此按需加载。
                  放在列表最顶部（用户上翻到顶才看得见），点击后新行 prepend、
                  由 loadingOlderRef 豁免自动滚底，视线不会被拽回最新消息。 */}
              {hasMoreOlder && (
                <View className="flex justify-center py-3">
                  <View
                    onClick={handleLoadOlder}
                    className={`active:opacity-60 px-4 py-2 rounded-full bg-secondary ${loadingOlder ? 'opacity-50' : ''}`}
                  >
                    <Text className="text-muted-foreground text-xs leading-none">
                      {loadingOlder ? '加载中...' : '加载更多历史消息'}
                    </Text>
                  </View>
                </View>
              )}
              {messages.map((msg, msgIdx) => {
                // 暗号回执（where_ack）是纯信号消息：整行都不渲染。
                // ⚠️ 必须在最前面拦截——只拦 renderMessageContent 不够：气泡外壳、头像、
                //    昵称、日期分隔头仍会画出来，用户看到的就是一个「只有气泡没有内容」的空块。
                if (isWhereAck(msg)) {
                  logDbg('[chat] 🙈 跳过暗号回执的整行渲染（纯信号消息）:', msg.id);
                  return null;
                }
                const isMine = msg.sender_id === user?.id;
                // 日期分隔头：与上一条消息不同天时在本条前插入（撤回占位行同样参与判断）
                const prevMsg = msgIdx > 0 ? messages[msgIdx - 1] : null;
                const showDateHeader = !prevMsg || dateKey(prevMsg.created_at) !== dateKey(msg.created_at);
                // 发送者资料：统一从全局 store 按 id 查（同一用户只存一份，消息行不再逐条携带）
                const senderProfile = profileById[msg.sender_id] || null;
                const senderAvatar =
                  (senderProfile?.avatar_url && !avatarErrorIds.has(msg.sender_id)
                    ? senderProfile.avatar_url
                    : '') || '';
                const senderName =
                  senderProfile?.nickname || senderProfile?.username || (isMine ? '我' : '对方');
                // ⚠️ 以下布尔量必须在父组件算好再传：memo 子组件只比较原始值，
                //    直接传 messages / selectedIds / failedIds 等集合会让每行都因引用变化而重渲染。
                return (
                  <ChatMessageRow
                    key={msg.id}
                    msg={msg}
                    isMine={isMine}
                    showDateHeader={showDateHeader}
                    dateHeaderText={showDateHeader ? formatDateHeader(msg.created_at) : ''}
                    timeText={formatTime(msg.created_at)}
                    isLast={msgIdx === messages.length - 1}
                    quoteGone={!!msg.reply_to_id && !messages.some((m) => m.id === msg.reply_to_id)}
                    senderAvatar={senderAvatar}
                    senderName={senderName}
                    isFailed={failedIds.has(msg.id)}
                    isSending={sendingIds.has(msg.id)}
                    isSelected={selectedIds.includes(msg.id)}
                    isHighlighted={highlightId === msg.id}
                    selectMode={selectMode}
                    renderContent={renderMessageContent}
                    onTapInSelectMode={onMsgTapInSelectMode}
                    onTouchStart={onMsgTouchStart}
                    onTouchMove={onMsgTouchMove}
                    onTouchEnd={onMsgTouchEnd}
                    onQuoteTap={onQuoteTap}
                    onAvatarError={handleAvatarError}
                    onRetry={retrySend}
                    onDismissFailed={dismissFailed}
                  />
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>

      {/* 表情面板（微信原生做法：从底部向上展开、**盖住键盘区域**，底部固定「删除 + 发送」操作栏）。
          ⚠️⚠️ 必须 `position: fixed` 贴在输入区正上方，**不能**留在文档流里（用户反馈「点笑脸不弹表情」的根因）：
             输入区本身是 `position: fixed; bottom: keyboardOffset`，而本面板原先写在文档流末尾——
             它会被排到「整页内容高度」之后，也就是**视口下方**。`showEmojiPanel` 确实变成了 true、
             面板也确实渲染了，但用户完全看不到，表现就是「点了没反应」。
          ⚠️ 高度必须与 `inputAreaH`（EMOJI_PANEL_H + EMOJI_ACTION_BAR_H）严格同源：
             消息区 ScrollView 的 height 是按这个值扣减的，两处不一致会让最新消息被面板遮住。
          ⚠️ 层级 zIndex 取 99：低于输入区（100），高于消息区，保证面板永远在输入行下方、消息上方。
          ⚠️ 结构分两层：上层 ScrollView 只放表情（可滚动），下层操作栏**固定不滚动**——
             微信原生就是这样，用户滑到任何位置都能直接点发送，不必滚回底部。 */}
      {showEmojiPanel && (
        <View
          className="bg-card border-t border-border"
          style={{
            position: 'fixed',
            bottom: keyboardOffset + INPUT_ROW_HEIGHT,
            left: 0,
            right: 0,
            zIndex: 99,
          }}
        >
          <ScrollView scrollY className="py-3" style={{ height: `${EMOJI_PANEL_H}px` }}>
            <View className="w-full px-3">
              {/* 最近使用：固定在最顶部、不随下方列表滚动（它在 ScrollView 内首行，
                  但用户一进来看到的就是它，符合「最近用过的先出现」的预期）。
                  ⚠️ 无记录时整块不渲染（连标题都不画）：空标题会让面板顶部多出一条无意义的留白。
                  ⚠️ 用 `grid-cols-6` 与下方表情网格同列宽，保证同一列的表情上下对齐。 */}
              {recentEmojis.length > 0 && (
                <View className="mb-2">
                  <Text className="text-xs text-muted-foreground block mb-1">最近使用</Text>
                  <View className="grid grid-cols-6 gap-2">
                    {recentEmojis.map((emoji) => (
                      <View
                        key={`recent-${emoji}`}
                        onClick={() => onPickEmoji(emoji)}
                        className="flex items-center justify-center h-12 bg-muted rounded-lg active:bg-secondary"
                      >
                        <Text className="text-2xl">{emoji}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
              <View className="grid grid-cols-6 gap-2">
                {emojis.map((emoji, index) => (
                  <View
                    key={index}
                    onClick={() => onPickEmoji(emoji)}
                    className="flex items-center justify-center h-12 bg-secondary rounded-lg active:bg-muted"
                  >
                    <Text className="text-2xl">{emoji}</Text>
                  </View>
                ))}
              </View>
            </View>
          </ScrollView>

          {/* 底部操作栏（微信原生同款）：左侧「删除」退格、右侧「发送」。
              ⚠️ 必须放在 ScrollView **外面**：放里面会跟着表情列表一起滚走，
                 用户滑到中间就找不到发送键了（用户明确要求「发送按键要留出来」）。
              ⚠️ 发送按钮的可用态由 `inputValue.trim()` 决定：空输入时置灰且不响应点击，
                 与微信原生一致（避免用户点了没反应又不知道原因）。
              ⚠️ 删除按钮删的是**输入框最后一个字符**，不是表情面板里的内容——
                 微信原生也是这个语义（面板只是输入辅助，真正的文本在输入框里）。 */}
          <View
            className="flex flex-row items-center justify-between px-3 border-t border-border"
            style={{ height: `${EMOJI_ACTION_BAR_H}px` }}
          >
            <View
              onClick={(e) => {
                e.stopPropagation();
                bumpGuard(genRef.current);
                // 退格：按「字符」删而不是按 UTF-16 码元删。
                // ⚠️ 表情是代理对（surrogate pair），`slice(0, -1)` 会把它劈成半个字符变成乱码，
                //    故用 Array.from 按码点切分后再拼回。
                const chars = Array.from(inputValue);
                if (chars.length === 0) {
                  logDbg('[chat] ⌫ 表情面板退格：输入框已空，忽略');
                  return;
                }
                const next = chars.slice(0, -1).join('');
                setInputValue(next);
                setInputSelection(next.length);
                logDbg(`[chat] ⌫ 表情面板退格：${chars.length} → ${Array.from(next).length} 字符`);
              }}
              className="flex items-center justify-center w-12 h-9 rounded-lg bg-secondary active:bg-muted"
            >
              <View className="i-lucide-delete w-5 h-5 text-muted-foreground" />
            </View>

            <View
              onClick={(e) => {
                e.stopPropagation();
                if (!inputValue.trim()) {
                  logDbg('[chat] 📤 表情面板发送：输入框为空，忽略');
                  return;
                }
                bumpGuard(genRef.current);
                logDbg('[chat] 📤 表情面板发送按钮点击');
                void onSendText();
              }}
              className={`flex items-center justify-center px-5 h-9 rounded-lg ${
                inputValue.trim() ? 'bg-primary active:opacity-80' : 'bg-muted'
              }`}
            >
              <Text
                className={`text-sm leading-none ${
                  inputValue.trim() ? 'text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                发送
              </Text>
            </View>
          </View>
        </View>
      )}

      {/* H5 端图片放大查看器：全屏遮罩 + 左右滑动翻页（ScrollView horizontal），
          底部「n / 总数」指示，点任意处或右上角 × 关闭（小程序端走 previewImage 不进这里） */}
      {zoomViewer && (
        <View
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}
          onClick={() => { logDbg('[chat] 关闭图片放大查看'); setZoomViewer(null); }}
        >
          <ScrollView
            scrollX
            scrollWithAnimation
            scrollIntoView={`zoom-img-${zoomViewer.index}`}
            className="w-full"
            style={{ height: '70vh' }}
            onScroll={(e) => {
              // 滑动翻页时同步底部「n / 总数」指示；一屏宽 = windowWidth，四舍五入取当前页。
              // 程序化 scrollIntoView 也会触发本回调，但目标位置就是 index 本身，写回同值无副作用。
              const w = getWindowInfo().windowWidth || 1;
              const idx = Math.min(zoomViewer.urls.length - 1, Math.max(0, Math.round(e.detail.scrollLeft / w)));
              if (idx !== zoomViewer.index) setZoomViewer((prev) => (prev ? { ...prev, index: idx } : prev));
            }}
          >
            <View className="flex flex-row">
              {zoomViewer.urls.map((u, i) => (
                <View key={`${u}-${i}`} id={`zoom-img-${i}`} className="w-screen h-64 flex items-center justify-center shrink-0">
                  <Image src={u} mode="aspectFit" className="w-full h-full" onClick={(e) => e.stopPropagation()} />
                </View>
              ))}
            </View>
          </ScrollView>
          {zoomViewer.urls.length > 1 && (
            <Text className="text-white text-sm mt-3">
              {zoomViewer.index + 1} / {zoomViewer.urls.length}
            </Text>
          )}
          <View
            className="absolute rounded-full flex items-center justify-center"
            style={{ top: `${statusBarHeight + 16}px`, right: '20px', width: '36px', height: '36px', backgroundColor: 'rgba(255, 255, 255, 0.2)' }}
            onClick={(e) => { e.stopPropagation(); setZoomViewer(null); }}
          >
            <View className="i-lucide-x w-5 h-5 text-white" />
          </View>
        </View>
      )}

      {/* 录音状态提示 */}
      {isRecording && (
        <View style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <View className="bg-card rounded-2xl p-8 flex flex-col items-center gap-4">
            <View className="i-lucide-mic w-16 h-16 text-destructive animate-pulse" />
            <Text className="text-foreground text-lg font-bold">正在录音</Text>
            <Text className="text-muted-foreground text-2xl font-mono">
              {recordingDuration}s
            </Text>
            <View
              onClick={onStopRecording}
              className="mt-4 bg-destructive px-6 py-2 rounded-lg"
            >
              <Text className="text-destructive-foreground font-medium">点击停止</Text>
            </View>
          </View>
        </View>
      )}

      {/* 引用回复条(输入区上方) */}
      {replyTo && !selectMode && (
        <View className="flex flex-row items-center gap-2 px-3 py-2 bg-secondary border-t border-border">
          <View className="i-lucide-corner-up-left w-4 h-4 shrink-0 text-muted-foreground" />
          <Text
            className="text-xs text-muted-foreground flex-1"
            style={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 2,
              overflow: 'hidden',
            }}
          >
            回复 {quoteSummary(replyTo)}
          </Text>
          <View
            onClick={(e) => { e.stopPropagation(); setReplyTo(null); }}
            className="w-6 h-6 flex items-center justify-center shrink-0"
          >
            <View className="i-lucide-x w-4 h-4 text-muted-foreground" />
          </View>
        </View>
      )}

      {/* 【多图上传进度 + 取消入口】只在批量发送进行中显示，不占用输入区高度 */}
      {uploading && (
        <View
          className="flex flex-row items-center gap-2 px-3 py-2 bg-secondary border-t border-border"
          style={{
            position: 'fixed',
            bottom: keyboardOffset + INPUT_ROW_HEIGHT,
            left: 0,
            right: 0,
            zIndex: 99,
          }}
        >
          <Text className="text-xs text-muted-foreground leading-none flex-1">
            {uploadSummary || '上传中…'}
          </Text>
          <View
            onClick={(e) => { e.stopPropagation(); handleCancelUpload(); }}
            className="px-3 py-1 rounded-full"
            style={{ backgroundColor: 'rgba(220, 38, 38, 0.08)', borderColor: 'rgba(220, 38, 38, 0.4)', borderWidth: '1px' }}
          >
            <Text className="text-xs leading-none" style={{ color: 'var(--destructive)' }}>取消</Text>
          </View>
        </View>
      )}

      {/* 底部输入区 - 使用inline style确保H5端fixed定位生效 */}
      {/* 底部输入区背景统一走语义 token（bg-secondary + border），不再硬编码灰值 */}
      <View
        className="bg-secondary"
        style={{
          position: 'fixed',
          bottom: keyboardOffset,
          left: 0,
          right: 0,
          zIndex: 100,
          // 键盘弹出时不需要安全区域padding,否则会有额外空白
          paddingBottom: keyboardOffset > 0 ? '0' : 'env(safe-area-inset-bottom)',
        }}
      >
        {/* 输入区域 - 一行布局:语音 | 输入框 | 附件 | 位置 */}
        <Form onSubmit={onSendText}>
          <View className="flex flex-row items-center gap-2 px-3 py-2">
            {/* 语音按钮（外层 p-1 把命中区扩到约 44px，视觉圆环尺寸不变）
                ⚠️ 语音入口只保留这一个：原先输入框内还有一个麦克风图标（同样调 onSendVoice），
                   两个入口功能完全重复，已按用户要求移除。 */}
            <View
              onClick={(e) => { e.stopPropagation(); onSendVoice(); }}
              className="p-1 -mx-1 cursor-pointer"
            >
              <View className="flex items-center justify-center w-9 h-9 rounded-full border-2 border-muted-foreground">
                <View className="i-lucide-mic w-5 h-5 text-muted-foreground" />
              </View>
            </View>

            {/* 输入框容器 */}
            <View className="flex-1 bg-white rounded-lg px-3 py-2 border border-border flex flex-row items-center gap-2">
              <Input
                ref={inputRef}
                className="flex-1 bg-transparent text-foreground"
                value={inputValue}
                focus={inputFocus}
                adjustPosition={false} // 禁用系统自动上推,改为手动监听键盘高度
                onInput={(e) => {
                  const newValue = e.detail.value;
                  logDbg('[chat] 输入框内容变化:', newValue);
                  setInputValue(newValue);
                  // 记录光标位置：表情插入要插在光标处而不是永远追加到末尾
                  const sel = (e.detail as { selectionStart?: number }).selectionStart;
                  if (typeof sel === 'number') setInputSelection(sel);
                  bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
                  // 功能⑥：有内容才广播（清空输入框不算「正在输入」），内部自带节流与隐藏门控
                  if (newValue.trim()) notifyPeerTyping();
                }}
                onFocus={() => {
                  logDbg('[chat] 输入框获得焦点');
                  setInputFocus(true);
                  // 微信原生行为：点输入框弹键盘时自动收起表情面板（两者互斥，不能同时占屏）。
                  // ⚠️ 不收起的话，键盘 + 面板会同时出现，消息区被压到几乎不可见。
                  if (showEmojiPanel) {
                    logDbg('[chat] 😊 输入框获得焦点 → 自动收起表情面板');
                    setShowEmojiPanel(false);
                  }
                  bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
                }}
                onBlur={() => {
                  logDbg('[chat] 输入框失去焦点,当前键盘偏移:', keyboardOffset);
                }}
                onClick={(e) => {
                  logDbg('[chat] 输入框被点击,重置计时器');
                  e.stopPropagation();
                  bumpGuard(genRef.current); // 用户操作，重置120秒计时起点
                }}
                placeholder="输入消息"
                placeholderClass="text-muted-foreground"
                confirmType="send"
                confirmHold // 点击键盘右下角"发送"键时保持键盘不收起
                onConfirm={onSendText}
              />
            </View>

            {/* 表情按钮：点一下开合表情面板（面板本体见 showEmojiPanel 渲染块）。
                ⚠️ 按用户要求，原先「发送位置」的位置改成表情入口；位置已并入右侧加号菜单。
                ⚠️ 图标外圈已按用户要求去掉，只留图标本身。
                ⚠️ 图标用 `i-lucide-smile` 类名（与左侧语音 `i-lucide-mic`、右侧加号
                   `i-lucide-circle-plus` 同一套图标体系，视觉风格统一）。
                   历史排查记录：曾因「真机不显示」先后换成 base64 SVG、本地 PNG、文字字符「☺」，
                   但后续确认**根因是表情面板被排到视口外**（面板当时在文档流里、输入区是 fixed），
                   与图标渲染方式无关——图标类名本身在真机是正常显示的（同页 mic / circle-plus 均正常）。
                   故此处恢复为图标类名，不再保留图片/文字字符方案。 */}
            <View
              onClick={(e) => {
                e.stopPropagation();
                bumpGuard(genRef.current);
                // 开合表情面板。⚠️ 必须打日志：面板是 fixed 定位、开合不改变任何可见文案，
                // 出问题时（点了没反应 / 面板被键盘盖住）只能靠这条日志确认「点击是否真的到达」。
                const next = !showEmojiPanel;
                logDbg(`[chat] 😊 表情按钮点击 → 面板 ${next ? '展开' : '收起'}（keyboardOffset=${keyboardOffset}）`);
                // 微信原生行为：展开表情面板时**收起键盘**，面板占据键盘原来的位置。
                // ⚠️ 不收起键盘的话，面板会叠在键盘上方，可视区被压掉近一半，表情区只剩一两行。
                // ⚠️ 收起键盘靠 `setInputFocus(false)`（Input 是受控 focus），
                //    键盘高度由 useKeyboardOffset 监听 onKeyboardHeightChange 自动归零，
                //    面板的 bottom 随之从「键盘高度 + 输入行」落回「输入行」，正好贴住输入区。
                if (next) setInputFocus(false);
                setShowEmojiPanel(next);
              }}
              className="p-1 -mx-1 cursor-pointer"
            >
              <View className="flex items-center justify-center w-9 h-9">
                <View className="i-lucide-smile w-6 h-6 text-muted-foreground" />
              </View>
            </View>

            {/* 附件按钮（图片 + 文件 + 位置合并入口）：按微信的做法收进最右侧「加号带圈」，
                点击弹 ActionSheet 三选一。⚠️ 图标外圈已按用户要求去掉，只留图标本身。
                ⚠️ 图标尺寸 w-6 h-6，与左侧表情按钮同口径（原因见上方表情按钮注释）。 */}
            <View
              onClick={(e) => { e.stopPropagation(); handlePickAttachment(); }}
              className={`p-1 -mx-1 cursor-pointer ${uploading ? 'opacity-50' : ''}`}
            >
              <View className="flex items-center justify-center w-9 h-9">
                <View className="i-lucide-circle-plus w-6 h-6 text-muted-foreground" />
              </View>
            </View>
          </View>
        </Form>
      </View>

      {/* 转写复制降级弹层：剪贴板被拒（真机常见 errno 112）时打开，长按可选中文本手动复制 */}
      {transcriptCopyText !== '' && (
        <View
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 1000 }}
          onClick={() => setTranscriptCopyText('')}
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
                  {transcriptCopyText}
                </Text>
              </ScrollView>
            </View>
            <View className="mt-4 bg-primary rounded-lg py-3 flex items-center justify-center" onClick={() => setTranscriptCopyText('')}>
              <Text className="text-primary-foreground text-sm font-medium">关闭</Text>
            </View>
          </View>
        </View>
      )}

      {/* 登录明细弹层：顶栏「明细」按钮打开，逐条列出对方在我离开聊天区窗口内的历次登录时刻 */}
      {loginDetailOpen && (
        <LoginDetailSheet
          peerName={displayPeerName}
          stats={peerLoginStats}
          window={loginWindow}
          onClose={() => {
            logDbg('[chat] 关闭登录明细弹层');
            bumpGuard(genRef.current);
            setLoginDetailOpen(false);
          }}
        />
      )}

      {/* 步数对比弹层：顶栏「脚印」图标打开。外壳照抄 login-detail-sheet 的纯 View 遮罩模式
          （fixed inset-0 + z-50 + inline rgba，点遮罩关闭、面板内 stopPropagation 防误关）。
          ⚠️ 卡片传 bare：外壳由本弹层提供，否则会出现「卡片套卡片」的双层边框。
          ⚠️ 面板内滚动用 ScrollView（小程序 View 的 overflow-y-auto 不可靠）。 */}
      {stepsCardOpen && !!peerId && !!user && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
          onClick={() => {
            logDbg('[chat] 关闭步数对比弹层');
            bumpGuard(genRef.current);
            setStepsCardOpen(false);
          }}
        >
          <View
            className="w-full bg-card rounded-xl p-5"
            onClick={(e) => {
              e.stopPropagation();
              bumpGuard(genRef.current);
            }}
          >
            <Text className="text-lg font-bold text-foreground">运动步数对比</Text>
            <Text className="text-xs text-muted-foreground mt-1 leading-6">
              {`和 ${displayPeerName} 逐日对比 · 数据来自微信运动`}
            </Text>

            <ScrollView scrollY className="mt-4 max-h-96">
              <StepsCompareCard
                userId={user.id}
                peerId={peerId}
                peerName={displayPeerName}
                conversationId={conversationId}
                bare
                onInteract={() => bumpGuard(genRef.current)}
              />
            </ScrollView>

            <View
              className="mt-5 bg-secondary rounded-lg py-3 flex items-center justify-center"
              onClick={() => {
                bumpGuard(genRef.current);
                setStepsCardOpen(false);
              }}
            >
              <Text className="text-muted-foreground leading-none">关闭</Text>
            </View>
          </View>
        </View>
      )}
      </View>
    </PrivacyShield>
    </ErrorBoundary>
  );
}
