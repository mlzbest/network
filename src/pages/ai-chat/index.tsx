import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, useRouter } from '@tarojs/taro';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import PrivacyShield from '@/components/privacy-shield';
import MarkdownText from '@/components/markdown-text';
import { fetchModelCatalog, requestLLMStream } from '@/api/ai';
import { isAbortError, isTimeoutError } from '@/lib/sse';
import { buildDiagPrompt } from '@/api/net-diagnose';
import { takeDiagForAi } from '@/lib/diag-history';
import {
  DEFAULT_MODEL,
  FALLBACK_CATALOG,
  genId,
  loadActiveModel,
  loadCatalogCache,
  loadCustomModels,
  loadSessions,
  newSession,
  saveActiveModel,
  saveCatalogCache,
  saveCustomModels,
  saveSessions,
} from '@/lib/ai-store';
import type { AiSession, ChatMessage, CustomModel } from '@/lib/ai-store';
import { getWindowInfo } from '@/lib/system-info';
import { logDbg } from '@/lib/logger';
import { disarmShield, getArmedRoute, isShieldArmed } from '@/lib/shield-state';
import { markChatExit } from '@/lib/secret-entry';
import { reportPresence } from '@/lib/presence';
import {
  abandonGuard,
  bumpGuard,
  claimFreshEntry,
  clearBackgroundNote,
  elapsedSinceStart,
  noteBackground,
  notePageHidden,
  resolveEntryMode,
  retainGeneration,
  resumeGuard,
  startGuard,
  stopGuard,
  getLatestGeneration,
} from '@/lib/inactivity-guard';
import { useKeyboardOffset } from '@/lib/hooks/use-keyboard-offset';
import ErrorBoundary from '@/components/error-boundary';

const PAGE_ROUTE = 'pages/ai-chat/index';
/** 每次发送时动态拼接当前日期，让模型能回答“今天几号/星期几” */
const SYSTEM_PROMPT_BASE = '你是嵌入在一款网络诊断小程序里的 AI 助手，回答简洁、友好、使用中文。当用户询问日期、星期或时间时，直接依据下面给出的“当前日期”回答，不要说自己无法获取时间。';

/** 生成带当前日期的系统提示（按本地时区，含星期） */
function buildSystemPrompt(): string {
  const now = new Date();
  const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `${SYSTEM_PROMPT_BASE}\n当前日期：${dateStr}（${week}），时区以用户设备本地时间为准。`;
}

const PRESET_PROVIDERS: { name: string; baseUrl: string; modelId: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelId: 'deepseek-chat' },
  { name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', modelId: 'moonshot-v1-8k' },
  { name: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen-plus' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-4-flash' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelId: 'deepseek/deepseek-chat' },
  { name: 'Agnes AI', baseUrl: 'https://api.agnes-ai.cn/v1', modelId: 'agnes-2.5-flash' },
];

/** 选中项：平台模型（customId 为空）或自定义模型 */
interface ModelChoice {
  label: string;
  customId?: string;
}

function choiceKey(c: ModelChoice): string {
  return c.customId ? `c:${c.customId}` : `p:${c.label}`;
}

/**
 * 遮挡罩临时停用期间的稳定透传壳（模块级定义，引用恒定）。
 * ⚠️ 绝不可在组件函数体内内联新建此壳——内联箭头函数每次 render 都是新组件类型，
 * 任何 setState 都会让整棵子树 unmount/remount，Taro Input 原生聚焦被丢弃 → 真机键盘弹不出。
 * 恢复遮罩时把 JSX 里的 <PassthroughShell> 换回 <PrivacyShield> 即可。
 */
function PassthroughShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export default function AiChatPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<AiSession[]>([]);
  const [activeId, setActiveId] = useState('');
  const [catalog, setCatalog] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<CustomModel[]>([]);
  const [choice, setChoice] = useState<ModelChoice>({ label: DEFAULT_MODEL });
  const [inputValue, setInputValue] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formKey, setFormKey] = useState('');
  const [formModel, setFormModel] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [inputFocus, setInputFocus] = useState(false);
  const keyboardOffset = useKeyboardOffset();

  // 键盘收起时同步复位受控 focus（否则 focus 卡在 true，下次点击不再触发聚焦）
  useEffect(() => {
    if (keyboardOffset === 0) {
      logDbg('[ai-chat] 键盘已收起, 复位 inputFocus');
      setInputFocus(false);
    }
  }, [keyboardOffset]);

  // 隐藏出口：连点标题「AI 助手」3 次（间隔 <1.2s）单向返回 ping 页，机制同遮挡解锁
  const [titleTapCount, setTitleTapCount] = useState(0);
  const titleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (titleTapTimerRef.current) clearTimeout(titleTapTimerRef.current);
    };
  }, []);

  const handleTitleTap = () => {
    if (titleTapTimerRef.current) clearTimeout(titleTapTimerRef.current);
    titleTapTimerRef.current = setTimeout(() => {
      titleTapTimerRef.current = null;
      setTitleTapCount(0);
    }, 1200);
    const next = titleTapCount + 1;
    if (next >= 3) {
      if (titleTapTimerRef.current) {
        clearTimeout(titleTapTimerRef.current);
        titleTapTimerRef.current = null;
      }
      setTitleTapCount(0);
      // 走统一出口：代次校验 + abandonGuard 清起点 + 解除悬挂遮罩
      exitToPing('EXIT_TITLE_TAP');
    } else {
      setTitleTapCount(next);
    }
  };

  const sessionsRef = useRef<AiSession[]>([]);
  const activeIdRef = useRef('');
  const choiceRef = useRef<ModelChoice>({ label: DEFAULT_MODEL });
  const customRef = useRef<CustomModel[]>([]);
  const streamAbortRef = useRef<{ abort: () => void } | null>(null);
  const mountedRef = useRef(true);
  // 120秒无操作自动返回 ping 页：状态统一由模块级 inactivity-guard 管理
  // （代次令牌 + 纯时间判定 + 页面栈前台校验），组件内不再持有 timer/起点 ref。
  const genRef = useRef(0);
  const lastStreamScrollRef = useRef(0);

  /** 所有「离开 AI 页」出口的统一收口：只有最新代次实例才允许发起跳转 */
  const exitToPing = (tag: string) => {
    if (genRef.current !== getLatestGeneration()) {
      logDbg(`[ai-chat] 🛑 [GUARD_STALE] ${tag} 但本实例代次(${genRef.current})已过期, 忽略跳转`);
      return;
    }
    logDbg(`[ai-chat] 🚪 [${tag}] 废弃计时, reLaunch 回 ping 页`);
    abandonGuard();
    // AI 页遮罩处于停用期，顺手解除可能悬挂的遮挡状态，防止遮罩兜底误弹下次进入
    if (isShieldArmed()) disarmShield();
    // 此前遗漏的退场出口：与 chat/chats/profile 三页对齐——打退场点 + 上报「不在线」
    markChatExit();
    reportPresence('offline');
    Taro.reLaunch({ url: '/pages/ping/index' });
  };

  // App 级前后台事件：仅用于记录「切后台时刻」，供 didShow 区分导航进入 vs 后台切回。
  // ⚠️ 绝不在这里做超时判定或跳转——微信切后台会冻结 JS 定时器，事件恢复时序不可靠。
  useEffect(() => {
    const onAppHide = () => noteBackground();
    Taro.onAppHide(onAppHide);
    return () => {
      try {
        Taro.offAppHide(onAppHide);
      } catch (e) {
        logDbg('[ai-chat] offAppHide 不可用, 忽略');
      }
    };
  }, []);

  // navigationStyle custom：状态栏避让 + 胶囊右留白（仅微信端取 rect，H5 回退 96px）
  const sysInfo = getWindowInfo();
  const statusBarHeight = sysInfo.statusBarHeight ?? 20;
  const isWeappEnv = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  const [capsuleRightPadding, setCapsuleRightPadding] = useState(96);
  useEffect(() => {
    if (!isWeappEnv) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect();
      const winW = sysInfo.windowWidth;
      if (rect && typeof rect.left === 'number' && rect.left > 0 && winW > 0) {
        setCapsuleRightPadding(Math.round(winW - rect.left + 8));
      }
    } catch (e) {
      logDbg('[ai-chat] getMenuButtonBoundingClientRect 异常，回退固定留白');
    }
  }, [isWeappEnv, sysInfo]);

  /** AI 解读自动发送：新建诊断会话 → 预填结构化 prompt → 立即触发流式发送。
   * 在 init useEffect 末尾调用；此时 sessionsRef/choiceRef 均已同步就绪，
   * sendContent 通过 overrideSession 显式接收会话对象，不依赖未生效的 setState。
   * ⚠️ 不可再 setTimeout 延迟——用户感知是「点了按钮半天没反应」；
   * user 消息随 persistSessions 同步上屏，首帧即有内容，无需等渲染稳定。 */
  const startDiagSession = (target: string, prompt: string) => {
    const s = newSession(choiceKey(choiceRef.current));
    s.title = `诊断 ${target}`.slice(0, 24);
    activeIdRef.current = s.id;
    logDbg('[ai-chat] 🤖 检测到 AI 解读中转, 已建会话:', s.title);
    sendContent(prompt, s);
    // sendContent 内部的 setActiveId 在本渲染周期不会生效，需显式切到诊断会话；
    // 放在发送之后执行，保证最终 state 是「含 user 消息 + 空气泡」的最新版
    setActiveId(s.id);
  };

  // ===== 初始化：本机会话 / 模型选择 / 目录缓存秒开 + 异步刷新 =====
  useEffect(() => {
    mountedRef.current = true;
    const stored = loadSessions();
    const cached = loadCatalogCache();
    setCatalog(cached || FALLBACK_CATALOG);
    const customs = loadCustomModels();
    setCustomModels(customs);
    customRef.current = customs;

    let list = stored;
    if (list.length === 0) {
      const s = newSession(DEFAULT_MODEL);
      list = [s];
      saveSessions(list);
    } else {
      // 修复历史存储中缺失 messages 数组的脏数据，避免渲染期 .length 崩溃
      const dirty = list.filter((s) => !Array.isArray(s.messages));
      if (dirty.length > 0) {
        logDbg('[ai-chat] 初始化发现', dirty.length, '条会话缺失 messages 数组，已修复并回写');
        list = list.map((s) => (Array.isArray(s.messages) ? s : { ...s, messages: [] }));
        saveSessions(list);
      }
    }
    sessionsRef.current = list;
    setSessions(list);
    const first = list[0];
    activeIdRef.current = first.id;
    setActiveId(first.id);

    // 恢复上次选择；自定义模型需确认配置仍存在，否则回退默认
    const saved = loadActiveModel();
    if (saved.startsWith('c:')) {
      const cm = customs.find((m) => `c:${m.id}` === saved);
      if (cm) {
        const c = { label: cm.name, customId: cm.id };
        choiceRef.current = c;
        setChoice(c);
      } else {
        choiceRef.current = { label: DEFAULT_MODEL };
        setChoice({ label: DEFAULT_MODEL });
      }
    } else if (saved) {
      choiceRef.current = { label: saved.replace(/^p:/, '') };
      setChoice({ label: saved.replace(/^p:/, '') });
    }

    // 目录异步刷新（2s 内），失败保留当前列表，不阻塞聊天
    void fetchModelCatalog().then((models) => {
      if (!mountedRef.current || !models) return;
      setCatalog(models);
      saveCatalogCache(models);
      logDbg('[ai-chat] 模型目录刷新成功:', models.length);
    });

    // AI 解读入口：ping 页「AI 解读」→ reLaunch(?fromDiag=1) + Storage 一次性中转。
    // takeDiagForAi 读后即焚；取不到（普通暗号进入/数据残留失效）静默走原逻辑。
    if ((router.params?.fromDiag ?? '') === '1') {
      const payload = takeDiagForAi();
      if (payload) {
        startDiagSession(payload.target, buildDiagPrompt(payload));
      } else {
        logDbg('[ai-chat] fromDiag=1 但无有效中转数据, 回退普通会话');
      }
    }

    return () => {
      mountedRef.current = false;
      // 卸载时中断在飞的流式请求：不中断的话请求会继续跑，微信底层回收页面后
      // 回 `request:fail interrupted`，冒成「请求失败」的未捕获错误（用户实测报过）。
      if (streamAbortRef.current) {
        logDbg('[ai-chat] 页面卸载, 主动中断在飞的流式请求');
        streamAbortRef.current.abort();
        streamAbortRef.current = null;
      }
      // 组件卸载只停表；起点保留给「后台切回」补判（claim 换代时才作废陈旧起点）
      stopGuard();
    };
  }, []);

  // 键盘弹出时：滚到底，保证最新一条不被键盘遮挡（参照聊天详情页机制）；
  // 键盘收起后布局回弹，补一次滚动确保落点仍是最新消息
  useEffect(() => {
    if (keyboardOffset > 0) {
      logDbg('[ai-chat] 键盘弹出, offset:', keyboardOffset, '触发滚动到底');
      setTimeout(() => setScrollTop(999999 + (Date.now() % 100000)), 250);
    } else {
      logDbg('[ai-chat] 键盘收起, 布局回弹后补滚到底');
      setTimeout(() => setScrollTop(999999 + (Date.now() % 100000)), 150);
    }
  }, [keyboardOffset]);

  // 进入页面/切换会话时默认刷新到最新消息
  const scrollToLatest = () => {
    setTimeout(() => setScrollTop(999999 + (Date.now() % 100000)), 100);
  };

  useDidShow(() => {
    // 进入页面时默认刷新到最新消息
    logDbg('[ai-chat] didShow 滚动到最新, 消息数:', sessionsRef.current.find((s) => s.id === activeIdRef.current)?.messages?.length ?? 0);
    scrollToLatest();
    // ①+② resolveEntryMode 一次性完成「前台校验 + hide/onAppHide 配对判定」：
    //    stale  → 栈顶非本页(旧实例补触发)，忽略本次生命周期；
    //    resume → 上次 didHide 由切后台引起且起点仍在 → 后台切回，**保留计时起点**
    //             （前台10s+后台30s→回前台识别为已流逝40s，续跑剩80s，满足用户语义）；
    //    fresh  → 真导航离开过/首次进入 → claimFreshEntry 领新代次+作废旧起点，全新起表 120s
    //             （保住「超时返回 ping 后再进不闪退」——陈旧起点物理上不可能再被误补判）。
    const entry = resolveEntryMode(PAGE_ROUTE);
    if (entry.mode === 'stale') {
      logDbg('[ai-chat] 👻 [GUARD_STALE] didShow 但栈顶非本页(旧实例补触发), 忽略本次生命周期');
      return;
    }
    const returning = entry.mode === 'resume';
    genRef.current = returning ? retainGeneration() : claimFreshEntry();
    clearBackgroundNote();
    // ③ 遮挡兜底（收紧版）：仅当「遮罩已武装 + 归属页非本页 + 归属页仍在页面栈中」才弹回。
    //    AI 页经 reLaunch 进入时栈已被清空重建，悬挂的 armedRoute 不可能在栈里 →
    //    不再把刚进入的 AI 页弹走；同时顺手解除悬挂状态，防止后续页面继续误判。
    if (isShieldArmed() && getArmedRoute() !== PAGE_ROUTE) {
      const armedInStack = Taro.getCurrentPages().some((p) => p.route === getArmedRoute());
      if (armedInStack) {
        logDbg('[ai-chat] 🛡️ [EXIT_SHIELD] didShow 检测到遮挡归属其他页且在栈中, reLaunch 回:', getArmedRoute());
        abandonGuard();
        Taro.reLaunch({ url: `/${getArmedRoute()}` });
        return;
      }
      logDbg('[ai-chat] 🛡️ 遮挡状态悬挂(归属页不在栈中), 主动解除而不弹回:', getArmedRoute());
      disarmShield();
    }
    // ④ 计时决策：resume 按已流逝时长补判/续跑；fresh 全新起表 120s
    const elapsed = entry.elapsedMs;
    logDbg('[ai-chat] 🧭 didShow 判定 — mode:', entry.mode, '| 按后台切回处理?', returning, '| 已流逝(s):', Math.floor(elapsed / 1000), '| 代次:', genRef.current);
    if (returning) {
      if (elapsed >= 120000) {
        logDbg('[ai-chat] 🔙 后台切回补判已超时(', Math.floor(elapsed / 1000), '秒)');
        exitToPing('EXIT_RESUME');
      } else {
        resumeGuard(genRef.current);
      }
    } else {
      startGuard({ generation: genRef.current, onTimeout: () => exitToPing('EXIT_TICK') });
    }
  });

  useDidHide(() => {
    logDbg('[ai-chat] 👻 didHide 触发, 记录 hide 时刻 + 仅停表(保留计时起点供切回补判)');
    // 记录 hide 时刻：与随后的 App onAppHide 配对，供下次 didShow 区分
    // 「切后台导致的 hide」(保留起点) vs 「导航离开导致的 hide」(作废旧起点)。
    notePageHidden();
    // 只清 interval，绝不清起点——切后台期间微信冻结 JS 定时器，tick 不推进；
    // 回前台 didShow 用「当前时间 - 起点」补判是否已超 120 秒。
    stopGuard();
  });

  // 防御：本机存储的旧会话可能缺失 messages 数组（历史版本写入/存储损坏），
  // 直接 .length 会在渲染期抛 TypeError 导致整页崩溃
  const activeSession = sessions.find((s) => s.id === activeId) || null;
  const activeMessages: ChatMessage[] = (() => {
    const msgs = activeSession?.messages;
    if (Array.isArray(msgs)) return msgs;
    if (activeSession) {
      logDbg('[ai-chat] 检测到会话 messages 非数组，已降级为空列表渲染, sessionId:', activeSession.id);
    }
    return [];
  })();

  const persistSessions = (next: AiSession[]) => {
    const sanitized = next.map((s) =>
      Array.isArray(s.messages) ? s : { ...s, messages: [] as ChatMessage[] },
    );
    sessionsRef.current = sanitized;
    setSessions(sanitized);
    saveSessions(sanitized);
  };

  const patchSession = (id: string, patch: Partial<AiSession>, touch = true) => {
    const next = sessionsRef.current.map((s) =>
      s.id === id ? { ...s, ...patch, ...(touch ? { updatedAt: Date.now() } : {}) } : s,
    );
    persistSessions(next);
  };

  /** 解析当前生效的模型与通道 */
  const resolveModel = (): { model: string; custom?: CustomModel } => {
    if (choice.customId) {
      const cm = customRef.current.find((m) => m.id === choice.customId);
      if (cm) return { model: cm.modelId, custom: cm };
      return { model: DEFAULT_MODEL };
    }
    return { model: choice.label };
  };

  /**
   * 参数化发送：手动输入与 AI 解读自动发送共用此链路。
   * overrideSession 用于 fromDiag 分支——init useEffect 里的 setState 尚未在
   * 本次渲染周期生效，必须显式传入刚建好的诊断会话而非依赖 activeIdRef。
   */
  const sendContent = (raw: string, overrideSession?: AiSession) => {
    const content = raw.trim();
    if (!content) return;
    if (streaming) {
      Taro.showToast({ title: 'AI 正在回复中', icon: 'none' });
      return;
    }
    let session = overrideSession ?? sessionsRef.current.find((s) => s.id === activeIdRef.current);
    if (session && !Array.isArray(session.messages)) {
      logDbg('[ai-chat] 发送前修复缺失的 messages 数组, sessionId:', session.id);
      session = { ...session, messages: [] };
    }
    if (!session) {
      session = newSession(choiceKey(choice));
      persistSessions([session, ...sessionsRef.current]);
      activeIdRef.current = session.id;
      setActiveId(session.id);
    }
    const userMsg: ChatMessage = { role: 'user', content };
    const history = [...session.messages, userMsg].slice(-20);
    const withUser = { ...session, messages: [...session.messages, userMsg], updatedAt: Date.now() };
    if (withUser.title === '新对话') {
      withUser.title = content.slice(0, 18);
    }
    const nextList = [withUser, ...sessionsRef.current.filter((s) => s.id !== withUser.id)];
    persistSessions(nextList);
    setInputValue('');
    bumpGuard(genRef.current); // 发送消息视为用户操作，重置120秒计时起点

    const { model, custom } = resolveModel();
    const assistantBase: ChatMessage[] = [...history, { role: 'assistant', content: '' }];
    let acc = '';
    setStreaming(true);
    logDbg('[ai-chat] 发起流式请求, 通道:', custom ? `relay(${custom.name})` : 'platform', '模型:', model);

    const stream = requestLLMStream(
      [{ role: 'system', content: buildSystemPrompt() }, ...assistantBase],
      model,
      (chunk) => {
        acc += chunk;
        const msgs = [...history, { role: 'assistant' as const, content: acc }];
        patchSession(withUser.id, { messages: msgs });
        // 流式回复持续跟随滚动到底（300ms 节流，避免每个 chunk 都触发滚动动画）
        const now = Date.now();
        if (now - lastStreamScrollRef.current > 300) {
          lastStreamScrollRef.current = now;
          setScrollTop(999999 + (now % 100000));
        }
      },
      { custom },
    );
    // ⚠️ 必须把 handle 存进 ref：`handleStop` 与卸载 cleanup 都靠它中断底层请求。
    //    早期这里没接收返回值，`streamAbortRef.current` 恒为 null → 停止按钮是空操作、
    //    切页后请求仍在飞，微信底层中断时回 `request:fail interrupted` 冒成失败 toast。
    streamAbortRef.current = stream;
    logDbg('[ai-chat] 流式句柄已挂载, 可随时中断');
    stream.done
      .then(() => {
        if (!mountedRef.current) return;
        logDbg('[ai-chat] 流式完成, 长度:', acc.length);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        const e = err as { message?: string; errMsg?: string };
        const msg = e?.message || e?.errMsg || '请求失败';
        // 主动中断（点停止 / 切页 / 连续发送）不是失败：保留已收内容，不弹错误 toast。
        // ⚠️ 微信中断回的是 `{ errMsg: 'request:fail interrupted' }`，必须走 isAbortError，
        //    只判 `aborted` 会漏掉「底层先中断、aborted 尚未置位」的竞态。
        if (msg === '__ABORTED__' || isAbortError(err)) {
          logDbg('[ai-chat] 流式已中断(预期行为), 已收长度:', acc.length);
          if (!acc) patchSession(withUser.id, { messages: history });
          else
            patchSession(withUser.id, {
              messages: [...history, { role: 'assistant', content: `${acc}\n\n（已停止）` }],
            });
          return;
        }
        // 超时：不是「失败」，是「上游太慢」。已收内容必须保留，提示语要说清是超时，
        // 否则用户会以为网络断了而反复重发（服务端日志会同时出现
        // `stream failed: The stream controller cannot close or enqueue`，那是客户端
        // 断开后服务端仍在写，属同一事件的另一端，不是独立故障）。
        if (msg === '__TIMEOUT__' || isTimeoutError(err)) {
          logDbg('[ai-chat] 流式超时, 已收长度:', acc.length);
          if (!acc) {
            patchSession(withUser.id, { messages: history });
            Taro.showToast({ title: '响应超时，请重试', icon: 'none' });
          } else {
            patchSession(withUser.id, {
              messages: [...history, { role: 'assistant', content: `${acc}\n\n（响应超时，内容可能不完整）` }],
            });
            Taro.showToast({ title: '响应超时，已保留部分内容', icon: 'none' });
          }
          return;
        }
        logDbg('[ai-chat] 流式失败:', msg);
        if (!acc) {
          // 未收到任何内容：移除空气泡并提示
          patchSession(withUser.id, { messages: history });
          Taro.showToast({ title: msg.length > 24 ? `${msg.slice(0, 24)}…` : msg, icon: 'none' });
        } else {
          // 中途断流：保留已收内容
          patchSession(withUser.id, {
            messages: [...history, { role: 'assistant', content: `${acc}\n\n（回复中断，可重新发送）` }],
          });
          Taro.showToast({ title: '回复中断，可重发', icon: 'none' });
        }
      })
      .finally(() => {
        // 只清理「本次请求」的句柄，避免把后续请求的句柄误清
        if (streamAbortRef.current === stream) streamAbortRef.current = null;
        if (mountedRef.current) setStreaming(false);
        setTimeout(() => setScrollTop(999999 + (Date.now() % 1000)), 50);
      });
  };

  /** 手动发送：读取输入框内容 */
  const handleSend = () => {
    sendContent(inputValue);
  };

  const handleStop = () => {
    if (!streamAbortRef.current) {
      logDbg('[ai-chat] 停止按钮点击但无进行中的请求句柄, 忽略');
      return;
    }
    logDbg('[ai-chat] 用户点击停止, 主动中断流式请求');
    streamAbortRef.current.abort();
    streamAbortRef.current = null;
  };

  // ===== 模型选择 =====
  const pickPlatformModel = (m: string) => {
    const c = { label: m };
    setChoice(c);
    choiceRef.current = c;
    saveActiveModel(`p:${m}`);
    setModelSheetOpen(false);
    Taro.showToast({ title: `已切换：${m}`, icon: 'none' });
  };

  const pickCustomModel = (cm: CustomModel) => {
    const c = { label: cm.name, customId: cm.id };
    setChoice(c);
    choiceRef.current = c;
    saveActiveModel(`c:${cm.id}`);
    setModelSheetOpen(false);
    Taro.showToast({ title: `已切换：${cm.name}`, icon: 'none' });
  };

  const saveCustomModel = () => {
    const name = formName.trim();
    const url = formUrl.trim();
    const key = formKey.trim();
    const modelId = formModel.trim();
    // Agnes 域名允许留空 Key，由服务端 Secret 兜底注入
    const isAgnes = url.includes('agnes-ai');
    if (!name || !url || (!key && !isAgnes) || !modelId) {
      Taro.showToast({ title: isAgnes ? '名称、地址、模型需填写' : '四项都需填写', icon: 'none' });
      return;
    }
    if (!url.startsWith('https://')) {
      Taro.showToast({ title: '接口地址需以 https:// 开头', icon: 'none' });
      return;
    }
    const cm: CustomModel = { id: genId(), name, baseUrl: url.replace(/\/+$/, ''), apiKey: key, modelId };
    logDbg('[ai-chat] 保存自定义模型校验通过:', name, modelId, 'Key留空(Agnes服务端兜底):', !key);
    const next = [cm, ...customRef.current];
    customRef.current = next;
    setCustomModels(next);
    saveCustomModels(next);
    setFormOpen(false);
    setFormName('');
    setFormUrl('');
    setFormKey('');
    setFormModel('');
    logDbg('[ai-chat] 已添加自定义模型:', name, modelId);
    Taro.showToast({ title: '已添加，可直接选用', icon: 'success' });
  };

  const removeCustomModel = (cm: CustomModel) => {
    Taro.showModal({
      title: '删除自定义模型',
      content: `确定删除「${cm.name}」吗？其 API Key 将从本机移除。`,
      success: (res) => {
        if (!res.confirm) return;
        const next = customRef.current.filter((m) => m.id !== cm.id);
        customRef.current = next;
        setCustomModels(next);
        saveCustomModels(next);
        if (choiceRef.current.customId === cm.id) {
          const c = { label: DEFAULT_MODEL };
          choiceRef.current = c;
          setChoice(c);
          saveActiveModel(`p:${DEFAULT_MODEL}`);
        }
      },
    });
  };

  // ===== 会话管理 =====
  const handleNewSession = () => {
    const s = newSession(choiceKey(choice));
    persistSessions([s, ...sessionsRef.current]);
    activeIdRef.current = s.id;
    setActiveId(s.id);
    setDrawerOpen(false);
  };

  const handleSwitchSession = (id: string) => {
    activeIdRef.current = id;
    setActiveId(id);
    setDrawerOpen(false);
    logDbg('[ai-chat] 切换会话, 滚动到最新, sessionId:', id);
    scrollToLatest();
  };

  // ===== 会话重命名（抽屉长按会话项触发）=====
  const [renameTarget, setRenameTarget] = useState<AiSession | null>(null);
  const [renameInput, setRenameInput] = useState('');

  const handleSessionLongPress = (s: AiSession) => {
    bumpGuard(genRef.current);
    Taro.showActionSheet({
      itemList: ['重命名', '删除会话'],
      success: (res) => {
        bumpGuard(genRef.current);
        if (res.tapIndex === 0) {
          setRenameInput(s.title);
          setRenameTarget(s);
        } else if (res.tapIndex === 1) {
          handleDeleteSession(s.id);
        }
      },
    });
  };

  const handleRenameConfirm = () => {
    const t = renameInput.trim();
    if (!t) {
      Taro.showToast({ title: '标题不能为空', icon: 'none' });
      return;
    }
    if (t.length > 20) {
      Taro.showToast({ title: '标题最多 20 个字', icon: 'none' });
      return;
    }
    if (renameTarget) {
      patchSession(renameTarget.id, { title: t.slice(0, 20) });
      logDbg('[ai-chat] ✏️ 会话已重命名:', renameTarget.id, '→', t);
      Taro.showToast({ title: '已重命名', icon: 'success' });
    }
    setRenameTarget(null);
    bumpGuard(genRef.current);
  };

  const handleDeleteSession = (id: string) => {
    Taro.showModal({
      title: '删除会话',
      content: '删除后本机不可恢复，确定吗？',
      success: (res) => {
        if (!res.confirm) return;
        const next = sessionsRef.current.filter((s) => s.id !== id);
        if (next.length === 0) {
          const fresh = newSession(DEFAULT_MODEL);
          persistSessions([fresh]);
          activeIdRef.current = fresh.id;
          setActiveId(fresh.id);
        } else {
          persistSessions(next);
          if (activeIdRef.current === id) {
            activeIdRef.current = next[0].id;
            setActiveId(next[0].id);
          }
        }
      },
    });
  };

  const currentModelLabel = choice.customId ? `${choice.label}·自定义` : choice.label;

  // ===== 长按消息复制（user/assistant 通用）=====
  // 剪贴板被拒时降级为页面内可选中文本弹层（与 ping 页/批量面板同款兜底，真机常见 errno 112）
  const [copyFallbackText, setCopyFallbackText] = useState('');
  const handleMsgLongPress = (content: string) => {
    if (!content || streaming) return;
    bumpGuard(genRef.current);
    Taro.showActionSheet({
      itemList: ['复制内容'],
      success: (res) => {
        if (res.tapIndex !== 0) return;
        bumpGuard(genRef.current);
        Taro.setClipboardData({
          data: content,
          success: () => Taro.showToast({ title: '已复制', icon: 'success' }),
          fail: (err) => {
            logDbg('[ai-chat] setClipboardData fail:', err, '→ 打开可选中文本降级弹层');
            setCopyFallbackText(content);
          },
        });
      },
    });
  };

  // AI 页遮挡罩临时停用（SHIELD_ENABLED=false，恢复时改回 true 并换回 <PrivacyShield> 包裹即可，遮罩逻辑与兜底判断全部保留）。
  // ⚠️ 教训：此前在组件函数体内写 `const PageShell = SHIELD_ENABLED ? PrivacyShield : ({children})=><>{children}</>`，
  // 内联箭头函数每次 render 都是新组件类型，任何 setState 都会让整棵子树 unmount/remount，
  // Taro Input 原生聚焦被丢弃 → 真机点输入框键盘弹不出。壳组件必须定义在模块级保持引用稳定。
  logDbg('[ai-chat] 渲染(PassthroughShell稳定壳), keyboardOffset:', keyboardOffset, 'inputFocus:', inputFocus);

  return (
    <ErrorBoundary route="pages/ai-chat/index">
    <PassthroughShell>
      <View className="h-screen bg-background flex flex-col" style={{ paddingTop: `${statusBarHeight + 8}px` }}>
        {/* 顶栏 */}
        <View className="flex flex-row items-center justify-between px-4 pb-3">
          <View className="flex flex-row items-center py-2 pr-3" onClick={() => setDrawerOpen(true)}>
            <View className="i-lucide-message-square w-4 h-4 text-primary mr-1" />
            <Text className="text-primary text-xs">记录</Text>
          </View>
          <Text className="text-2xl font-bold text-foreground" onClick={handleTitleTap}>AI 助手</Text>
          <View
            className="flex flex-row items-center px-2 py-2 rounded-lg border border-border"
            style={{ marginRight: `${capsuleRightPadding - 24}px`, backgroundColor: 'rgba(14, 165, 233, 0.08)' }}
            onClick={() => setModelSheetOpen(true)}
          >
            <View className="i-lucide-sparkles w-3 h-3 text-primary mr-1" />
            <Text className="text-primary text-xs" style={{ maxWidth: '120px', overflow: 'hidden' }}>
              {currentModelLabel.length > 14 ? `${currentModelLabel.slice(0, 14)}…` : currentModelLabel}
            </Text>
          </View>
        </View>

        {/* 消息区：flex-1 + minHeight:0 在固定高度容器内正确收缩；
            键盘弹出时通过 paddingBottom 让出「输入区+键盘」的高度，内容可滚入该底部留白区，
            配合 scrollTop 滚到底即可保证最新消息不被键盘遮挡（不改 ScrollView 自身高度，避免破坏布局） */}
        <ScrollView scrollY scrollTop={scrollTop} scrollWithAnimation className="flex-1" style={{ minHeight: 0, paddingBottom: keyboardOffset > 0 ? `${keyboardOffset + 80}px` : '64px', boxSizing: 'border-box' }}>
          <View className="w-full px-4 pb-4">
            {!activeSession || activeMessages.length === 0 ? (
              <View className="flex flex-col items-center justify-center pt-24">
                <View className="i-lucide-bot w-14 h-14 text-muted-foreground mb-4" />
                <Text className="text-muted-foreground text-sm mb-1">有什么可以帮你？</Text>
                <Text className="text-muted-foreground text-xs text-center leading-relaxed">
                  对话记录仅保存在本机{'\n'}在右上角可切换平台模型或添加自定义模型
                </Text>
              </View>
            ) : (
              activeMessages.map((m, idx) =>
                m.role === 'user' ? (
                  <View key={`u-${idx}`} className="flex flex-row justify-end mb-3">
                    <View
                      className="bg-primary rounded-xl px-3 py-2"
                      style={{ maxWidth: '76%', width: 'fit-content' }}
                      onLongPress={() => handleMsgLongPress(m.content)}
                    >
                      <Text className="text-primary-foreground text-sm leading-relaxed">{m.content}</Text>
                    </View>
                  </View>
                ) : m.role === 'assistant' ? (
                  <View key={`a-${idx}`} className="flex flex-row justify-start mb-3">
                    <View
                      className="bg-card border border-border rounded-xl px-3 py-2"
                      style={{ maxWidth: '86%', width: 'fit-content' }}
                      onLongPress={() => handleMsgLongPress(m.content)}
                    >
                      {m.content ? (
                        <MarkdownText content={m.content} />
                      ) : (
                        <Text className="text-foreground text-sm leading-relaxed">…</Text>
                      )}
                    </View>
                  </View>
                ) : null,
              )
            )}
            {streaming && (
              <View className="flex flex-row items-center mb-2">
                <View className="i-lucide-loader-circle w-3 h-3 text-primary mr-2 animate-spin" />
                <Text className="text-muted-foreground text-xs">AI 正在回复…</Text>
              </View>
            )}
            {/* 底部占位由 ScrollView 的 paddingBottom 承担（键盘弹出时动态增大），此处不再重复占位 */}
          </View>
        </ScrollView>

        {/* 输入区：fixed 定位贴底，键盘弹出时上移（与聊天详情页一致）。
            此前用 position:relative + bottom 在 flex 列内位移，真机上会导致焦点/键盘异常 */}
        <View
          className="px-4 bg-background border-t border-border"
          style={{ position: 'fixed', left: 0, right: 0, bottom: keyboardOffset, paddingBottom: keyboardOffset > 0 ? '8px' : 'calc(env(safe-area-inset-bottom) + 8px)', zIndex: 50 }}
        >
          <View className="flex flex-row items-center pt-2">
            <View className="flex-1 bg-secondary rounded-xl px-3 py-2 mr-2">
              <Input
                className="w-full bg-transparent text-foreground text-sm"
                value={inputValue}
                onInput={(e) => {
                  setInputValue(e.detail.value);
                  bumpGuard(genRef.current); // 输入视为用户操作，重置120秒计时起点
                }}
                placeholder="发消息给 AI…"
                placeholderClass="text-muted-foreground"
                confirmType="send"
                confirmHold
                adjustPosition={false}
                focus={inputFocus}
                onFocus={() => {
                  logDbg('[ai-chat] 输入框获得焦点');
                  setInputFocus(true);
                }}
                onBlur={() => {
                  logDbg('[ai-chat] 输入框失去焦点, keyboardOffset:', keyboardOffset);
                  setInputFocus(false);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  logDbg('[ai-chat] 输入框被点击');
                }}
                onConfirm={handleSend}
              />
            </View>
            {streaming ? (
              <View className="bg-destructive rounded-xl px-4 py-3" onClick={handleStop}>
                <Text className="text-white text-xs font-medium">停止</Text>
              </View>
            ) : (
              <View
                className={`rounded-xl px-4 py-3 ${inputValue.trim() ? 'bg-primary' : 'bg-secondary'}`}
                onClick={handleSend}
              >
                <Text className={`text-xs font-medium ${inputValue.trim() ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                  发送
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* 会话抽屉遮罩 */}
        {drawerOpen && (
          <View
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 900 }}
            onClick={() => setDrawerOpen(false)}
          >
            <View
              className="bg-card h-full flex flex-col pt-16"
              style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '78%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <View className="px-4 mb-2 flex flex-row items-center justify-between">
                <Text className="text-foreground text-sm font-bold">历史记录</Text>
                <View className="flex flex-row items-center px-2 py-1" onClick={handleNewSession}>
                  <View className="i-lucide-plus w-4 h-4 text-primary mr-1" />
                  <Text className="text-primary text-xs">新建</Text>
                </View>
              </View>
              <ScrollView scrollY className="flex-1">
                <View className="w-full px-2 pb-8">
                  {sessions.map((s) => (
                    <View
                      key={s.id}
                      className={`flex flex-row items-center justify-between px-3 py-3 rounded-lg mb-1 ${s.id === activeId ? 'bg-secondary' : ''}`}
                      onClick={() => handleSwitchSession(s.id)}
                      onLongPress={() => handleSessionLongPress(s)}
                    >
                      <View className="flex-1 mr-2">
                        <Text className="text-foreground text-xs block" style={{ overflow: 'hidden' }}>{s.title}</Text>
                        <Text className="text-muted-foreground text-xs">{new Date(s.updatedAt).toLocaleDateString()}</Text>
                      </View>
                      <View className="p-2" catchMove onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}>
                        <View className="i-lucide-trash-2 w-4 h-4 text-muted-foreground" />
                      </View>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
          </View>
        )}

        {/* 模型选择弹层 */}
        {modelSheetOpen && (
          <View
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 950 }}
            onClick={() => setModelSheetOpen(false)}
          >
            <View
              className="bg-card rounded-t-2xl px-4 pt-4"
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '72vh' }}
              onClick={(e) => e.stopPropagation()}
            >
              <View className="flex flex-row items-center justify-between mb-3">
                <Text className="text-foreground text-sm font-bold">选择模型</Text>
                {/* 关闭按钮：外层 p-2 + 图标 w-5 把命中区扩到约 36px 以上 */}
                <View className="p-2 -m-2 cursor-pointer" onClick={() => setModelSheetOpen(false)}>
                  <View className="i-lucide-x w-5 h-5 text-muted-foreground" />
                </View>
              </View>
              <ScrollView scrollY style={{ maxHeight: '56vh' }}>
                {customModels.length > 0 && (
                  <View className="mb-3">
                    <Text className="text-muted-foreground text-xs mb-2 block">我的模型</Text>
                    {customModels.map((cm) => (
                      <View
                        key={cm.id}
                        className={`flex flex-row items-center justify-between px-3 py-3 rounded-lg mb-1 border ${choiceKey(choice) === `c:${cm.id}` ? 'border-primary bg-secondary' : 'border-border'}`}
                        onClick={() => pickCustomModel(cm)}
                      >
                        <View className="flex-1 mr-2">
                          <Text className="text-foreground text-xs block">{cm.name || '(未命名)'}</Text>
                          <Text className="text-muted-foreground text-xs block">{cm.modelId || '-'}</Text>
                        </View>
                        <View className="p-2" catchMove onClick={(e) => { e.stopPropagation(); removeCustomModel(cm); }}>
                          <View className="i-lucide-trash-2 w-4 h-4 text-muted-foreground" />
                        </View>
                      </View>
                    ))}
                  </View>
                )}
                <Text className="text-muted-foreground text-xs mb-2 block">平台模型</Text>
                {catalog.map((m) => (
                  <View
                    key={m}
                    className={`px-3 py-3 rounded-lg mb-1 border ${choiceKey(choice) === `p:${m}` ? 'border-primary bg-secondary' : 'border-border'}`}
                    onClick={() => pickPlatformModel(m)}
                  >
                    <Text className="text-foreground text-xs">{m}</Text>
                  </View>
                ))}
                <View
                  className="mt-2 mb-8 border border-dashed border-primary rounded-lg py-3 flex items-center justify-center"
                  onClick={() => {
                    setModelSheetOpen(false);
                    setFormOpen(true);
                  }}
                >
                  <View className="i-lucide-plus w-4 h-4 text-primary mr-1" />
                  <Text className="text-primary text-xs">添加自定义模型（第三方接口）</Text>
                </View>
              </ScrollView>
            </View>
          </View>
        )}

        {/* 自定义模型表单 */}
        {formOpen && (
          <View
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 960 }}
            onClick={() => setFormOpen(false)}
          >
            <View
              className="bg-card rounded-t-2xl px-4 pt-4"
              style={{ position: 'absolute', left: 0, right: 0, bottom: keyboardOffset > 0 ? `${keyboardOffset}px` : 0, paddingBottom: keyboardOffset > 0 ? '8px' : 'calc(env(safe-area-inset-bottom) + 32px)', transition: keyboardOffset > 0 ? 'bottom 0.2s ease-out' : undefined }}
              onClick={(e) => e.stopPropagation()}
            >
              <Text className="text-foreground text-sm font-bold block mb-1">添加自定义模型</Text>
              <Text className="text-muted-foreground text-xs block mb-2 leading-relaxed">
                支持任意 OpenAI 兼容接口（如 DeepSeek、Kimi、通义）。配置与 Key 仅保存在本机，调用经服务端中转转发。
              </Text>
              <Text className="text-muted-foreground text-xs block mb-2">快速选择服务商（自动填地址和模型）：</Text>
              <View className="flex flex-row flex-wrap mb-3">
                {PRESET_PROVIDERS.map((p) => (
                  <View
                    key={p.name}
                    className={`px-3 py-2 rounded-lg mr-2 mb-2 border ${formUrl === p.baseUrl ? 'border-primary bg-secondary' : 'border-border'}`}
                    onClick={() => {
                      setFormName(p.name);
                      setFormUrl(p.baseUrl);
                      setFormModel(p.modelId);
                      logDbg('[ai-chat] 预填服务商:', p.name, p.baseUrl, p.modelId);
                    }}
                  >
                    <Text className={`text-xs ${formUrl === p.baseUrl ? 'text-primary' : 'text-foreground'}`}>{p.name}</Text>
                  </View>
                ))}
              </View>
              <View className="bg-secondary rounded-lg px-3 py-2 mb-2">
                <Input className="w-full bg-transparent text-foreground text-sm" value={formName} onInput={(e) => setFormName(e.detail.value)} placeholder="名称（如 DeepSeek）" placeholderClass="text-muted-foreground" adjustPosition={false} />
              </View>
              <View className="bg-secondary rounded-lg px-3 py-2 mb-2">
                <Input className="w-full bg-transparent text-foreground text-sm" value={formUrl} onInput={(e) => setFormUrl(e.detail.value)} placeholder="接口地址 https://…/v1" placeholderClass="text-muted-foreground" adjustPosition={false} />
              </View>
              <View className="flex flex-row items-center bg-secondary rounded-lg px-3 py-2 mb-2">
                <Input className="flex-1 bg-transparent text-foreground text-sm" value={formKey} onInput={(e) => setFormKey(e.detail.value)} placeholder="API Key（Agnes 可留空）" placeholderClass="text-muted-foreground" password adjustPosition={false} />
                <View className="pl-3 border-l border-border" onClick={() => {
                  Taro.getClipboardData({
                    success: (res) => {
                      const v = (res.data || '').trim();
                      if (!v) { Taro.showToast({ title: '剪贴板为空', icon: 'none' }); return; }
                      setFormKey(v);
                      logDbg('[ai-chat] 已从剪贴板填入 API Key, 长度:', v.length);
                      Taro.showToast({ title: '已粘贴', icon: 'success' });
                    },
                    fail: (err) => {
                      logDbg('[ai-chat] 读取剪贴板失败:', err?.errMsg);
                      Taro.showToast({ title: '读取剪贴板失败，请手动输入', icon: 'none' });
                    },
                  })
                }}
                >
                  <Text className="text-primary text-sm">粘贴</Text>
                </View>
              </View>
              <View className="bg-secondary rounded-lg px-3 py-2 mb-3">
                <Input className="w-full bg-transparent text-foreground text-sm" value={formModel} onInput={(e) => setFormModel(e.detail.value)} placeholder="模型 ID（如 deepseek-chat）" placeholderClass="text-muted-foreground" adjustPosition={false} />
              </View>
              <Text className="text-muted-foreground text-xs block mb-3 leading-relaxed">Agnes AI 可不填 Key（服务端已配置）。真机无法长按粘贴时，先复制 Key 再点上方「粘贴」按钮。</Text>
              <View className="flex flex-row">
                <View className="flex-1 border border-border rounded-lg py-3 flex items-center justify-center mr-2" onClick={() => setFormOpen(false)}>
                  <Text className="text-muted-foreground text-sm">取消</Text>
                </View>
                <View className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center" onClick={saveCustomModel}>
                  <Text className="text-primary-foreground text-sm font-medium">保存</Text>
                </View>
              </View>
            </View>
          </View>
        )}
      </View>

      {/* 会话重命名弹层（抽屉长按会话项 →「重命名」触发） */}
      {renameTarget !== null && (
        <View
          className="flex items-center justify-center px-8"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 970 }}
          onClick={() => setRenameTarget(null)}
        >
          <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-lg font-bold text-foreground mb-1">重命名记录</Text>
            <Text className="block text-xs text-muted-foreground mb-5">标题展示在历史记录列表中，最多 20 个字</Text>
            <View className="bg-secondary rounded-lg px-4 py-3 mb-6">
              <Input
                className="w-full bg-transparent text-foreground"
                value={renameInput}
                maxlength={20}
                placeholder="输入新标题"
                placeholderClass="text-muted-foreground"
                adjustPosition={false}
                onInput={(e) => {
                  setRenameInput(e.detail.value);
                  bumpGuard(genRef.current);
                }}
              />
            </View>
            <View className="flex flex-row">
              <View
                className="flex-1 border border-border rounded-lg py-3 flex items-center justify-center mr-2"
                onClick={() => {
                  setRenameTarget(null);
                  bumpGuard(genRef.current);
                }}
              >
                <Text className="text-muted-foreground">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={handleRenameConfirm}
              >
                <Text className="text-primary-foreground font-medium">保存</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* 剪贴板被拒时的降级弹层：页面内可选中文本，长按复制（与 ping 页同款兜底） */}
      {copyFallbackText !== '' && (
        <View
          className="flex items-center justify-center px-8"
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 990 }}
          onClick={() => setCopyFallbackText('')}
        >
          <View className="w-full bg-card rounded-xl p-4" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-foreground text-sm font-bold mb-1">复制内容</Text>
            <Text className="block text-muted-foreground text-xs mb-3">
              剪贴板权限被拒绝，请长按下方文本手动选择复制
            </Text>
            <ScrollView scrollY style={{ maxHeight: '40vh' }}>
              <Text className="text-foreground text-sm leading-relaxed" userSelect selectable>
                {copyFallbackText}
              </Text>
            </ScrollView>
            <View
              className="mt-4 bg-secondary rounded-lg py-2 flex items-center justify-center"
              onClick={() => setCopyFallbackText('')}
            >
              <Text className="text-secondary-foreground text-sm">关闭</Text>
            </View>
          </View>
        </View>
      )}
    </PassthroughShell>
    </ErrorBoundary>
  );
}
