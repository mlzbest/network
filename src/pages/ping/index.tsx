import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import DiagnoseCard from '@/components/diagnose-card';
import MultiProbePanel from '@/components/multi-probe-panel';
import DiagHistoryPanel from '@/components/diag-history-panel';
import { warmupAiChat } from '@/api/ai';
import { saveBatchInput, takeDeepDiagnoseTarget } from '@/lib/batch-diag-handoff';
import { markSecretEntry } from '@/lib/secret-entry';
import { parseCredentialInput } from '@/api/auth';
import { reportLoginLocation } from '@/api/profiles';
import { useAuthStore } from '@/store/auth-store';
import {
  abortActiveRun,
  buildArpResult,
  clearDiagnoseCache,
  deriveConclusion,
  DIAGNOSE_ITEMS,
  extractPingMetrics,
  normalizeTarget,
  runLocalItem,
  runServerItem,
} from '@/api/net-diagnose';
import type { Conclusion, DiagnoseResult, ItemStatus, ServerItemKey } from '@/api/net-diagnose';
import { clearDiagHistory, getDiagHistory, saveDiagForAi, saveDiagSnapshot } from '@/lib/diag-history';
import type { DiagAiItem, DiagSnapshot } from '@/lib/diag-history';
import { getWindowInfo } from '@/lib/system-info';
import ErrorBoundary from '@/components/error-boundary';

type ResultsMap = Partial<Record<ServerItemKey, DiagnoseResult>>;

const GROUPS: Array<{ key: string; title: string }> = [
  { key: 'link', title: '① 本机与链路层' },
  { key: 'dns', title: '② 域名解析层' },
  {key: 'transport', title: '③ 传输层' },
  { key: 'app', title: '④ 应用层' },
  { key: 'throughput', title: '⑤ 吞吐层' },
];

// 各检测层级含义图例（可折叠；点击层级名滚动定位到对应分组）
const LAYER_LEGEND: Array<{ groupKey: string; name: string; desc: string }> = [
  { groupKey: 'link', name: '本机与链路层', desc: '查设备网络是否就绪、目标主机通不通、延迟多少' },
  { groupKey: 'dns', name: '域名解析层', desc: '查域名能否正确解析成IP，不同DNS结果是否一致' },
  { groupKey: 'transport', name: '传输层', desc: '查端口是否开放、中间路由路径有无中断节点' },
  { groupKey: 'app', name: '应用层', desc: '查HTTP请求端到端是否成功、TLS证书是否有效' },
  { groupKey: 'throughput', name: '吞吐层', desc: '估算实际下行带宽，判断网速是否达标' },
];

/** 「账号+密码」暗号的兜底超时：仅防底层请求彻底挂死，正常路径靠凭据 Promise 自身落地 */
const CRED_LOGIN_TIMEOUT_MS = 10000;

export default function PingPage() {
  const [inputValue, setInputValue] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultsMap>({});
  const [pendingItems, setPendingItems] = useState<Set<ServerItemKey>>(new Set());
  const [started, setStarted] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [scrollTarget, setScrollTarget] = useState({ top: 0, tick: 0 });
  // 剪贴板 API 被拒时的降级通道：页面内可长按选中的报告全文弹层
  const [copyFallbackText, setCopyFallbackText] = useState('');
  const [history, setHistory] = useState<DiagSnapshot[]>([]);
  // 「账号+密码」暗号登录中的页面内状态（不用 Taro.showLoading，见 signInAndEnterChats 注释）
  const [credBusy, setCredBusy] = useState(false);
  // ref 版闸门：async 闭包里读 state 会拿到旧值，故用 ref 做真正的防重入判定
  const credBusyRef = useRef(false);
  // 代次令牌：迟到的校验回调（尤其跳转后的 finally）不得再改 UI，否则预览页切回会残留「正在校验」
  const credRunIdRef = useRef(0);
  // 批量诊断已单开独立页（pages/batch-diag），本页只留入口行
  const runIdRef = useRef(0);

  /**
   * 「账号+密码」暗号：凭据**完全正确**才用这组账号完成一次真实登录并进聊天列表。
   * 关键点是「不管之前是否在本设备登录过都能进」——必须拿到目标账号自己的 access token，
   * 不能只做界面跳转或沿用本机旧身份（否则看到的是别人的会话、且请求会被 RLS 当匿名挡掉）。
   * ⚠️ 返回 false 表示「这次没进去」，调用方要把输入交回普通诊断流程处理；因此这里
   * **不给任何失败提示**（不弹 toast），由诊断分支统一提示，避免同一个输入出现两条反馈。
   * ⚠️ 不用 Taro.showLoading：H5 端它与 showToast 共用同一原生提示层，hideLoading 后
   * 立刻弹 toast 会被未销毁干净的 loading 吞掉（实测「错误密码一直显示登录中」的根因）。
   * ⚠️【已踩坑】绝不能用 `Promise.race([登录, 短超时])` 判定成败：supabase 登录本身要 1~2s，
   * 再叠加 store 等待就必然顶穿 race，导致「密码明明正确也进不去」。正确做法是**只等凭据
   * Promise 自己落地**（成功 resolve / 失败 reject），另配一个很长的兜底定时器纯防挂死。
   * ⚠️ 所有改 UI 的回调都必须先过代次令牌 `credRunIdRef`：页面已 reLaunch 离开时，迟到的
   * finally 不能再 setCredBusy——预览页切回会保留组件状态，一旦写回就把「正在校验账号…」
   * 重新渲染出来（用户实测「不管对错都提示正在校验」的根因）。
   */
  const signInAndEnterChats = async (username: string, password: string): Promise<boolean> => {
    // 闸门：防重复触发（键盘「前往」与按钮可能各调一次 handleDiagnose）
    if (credBusyRef.current) {
      console.log('[ping] 🔒 账号暗号校验进行中，忽略重复触发');
      return true;
    }
    const myRun = ++credRunIdRef.current;
    credBusyRef.current = true;
    setCredBusy(true);
    console.log(`[ping] 🔑 账号暗号开始校验 username=${username}`);
    // 兜底超时：仅防底层请求彻底挂死（正常路径不会走到这里）
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      console.warn('[ping] ⏱️ 账号暗号兜底超时，按普通输入处理');
      if (myRun === credRunIdRef.current) {
        credBusyRef.current = false;
        setCredBusy(false);
      }
    }, CRED_LOGIN_TIMEOUT_MS);
    try {
      // ⚠️⚠️ 暗号打点必须排在 switchAccountTo **之前**（用户报「健康🎊 今早发过消息但上线次数是 0」的根因）：
      //   signInWithPassword 成功后 supabase-js 会**同步**触发 onAuthStateChange('SIGNED_IN')
      //   → handleRealUser → recordLastLogin → takeSecretEntry()。若打点放在 await 之后，
      //   那一刻额度还是空的（bySecret=false），于是只刷 last_login_at、不写 login_events，
      //   表现为「账号密码登录永远不计上线次数」（实测该账号 last_seen_boundary_at 恒为 null，
      //   而 6666 暗号因为「先打点再跳转」一直正常）。
      //   打点提前后，即使登录失败也只是留下一个 5 分钟就过期的额度，不会误计数。
      markSecretEntry();
      await useAuthStore.getState().switchAccountTo(username, password);
      if (timedOut) return false;
      // 登录地点上报：让「登录地点」真正对应每次登录。
      // ⚠️ 不 await：定位慢（真机首次 3~8 秒），不能拖住 reLaunch。
      // ⚠️ 现读 store 拿 uid：`switchAccountTo` 内部已 await 完登录，
      //    此刻 store 的 user 才是本次登录的账号（闭包里的旧值可能是上一个账号）。
      const loginUid = useAuthStore.getState().user?.id;
      if (loginUid) {
        void reportLoginLocation(loginUid);
      } else {
        console.warn('[ping] 账号暗号登录成功但 store 尚无 user，跳过登录定位上报');
      }
      // 与 6666 暗号同语义：主动进入聊天区才计入登录统计
      console.log(`[ping] 🔑 账号暗号登录成功(${username})，reLaunch 到 chats（已打暗号进入点）`);
      setInputValue(''); // 不在输入框里残留明文密码
      // 跳转即视为本次校验结束：先把闸门放开并让 busy 落地，再 reLaunch，
      // 这样后续 finally 不会再对已离开的页面写 state。
      clearTimeout(timer);
      credRunIdRef.current += 1; // 作废本次运行，finally 不再触碰 UI
      credBusyRef.current = false;
      setCredBusy(false);
      Taro.reLaunch({ url: '/pages/chats/index' });
      return true;
    } catch (e) {
      console.warn('[ping] ❌ 账号暗号校验未通过:', (e as Error).message);
      if (timedOut) return false;
      return false;
    } finally {
      clearTimeout(timer);
      // 只有仍是最新代次才允许改 UI，避免迟到回调把「正在校验」写回已卸载/已跳转的页面
      if (myRun === credRunIdRef.current) {
        credBusyRef.current = false;
        setCredBusy(false);
      } else {
        console.log('[ping] 🧹 账号暗号校验回调已过期，跳过 UI 状态写回');
      }
    }
  };

  /** 打开批量诊断独立页：把主输入框当前值作为初始内容一次性交接过去 */
  const handleOpenBatchDiag = () => {
    const seed = inputValue.trim();
    saveBatchInput(seed);
    console.log('[ping] 📦 打开批量诊断页，交接初始输入长度:', seed.length);
    Taro.navigateTo({ url: '/pages/batch-diag/index' }).catch((e) => {
      console.error('[ping] ❌ 跳转批量诊断页失败:', e);
      Taro.showToast({ title: '打开批量诊断失败', icon: 'none' });
    });
  };

  // navigationStyle custom 后需自绘顶部：状态栏避让 + 胶囊右留白。
  // 胶囊右留白 = 屏宽 - 胶囊左缘 + 8px，保证标题永不被胶囊压住。
  // getMenuButtonBoundingClientRect 在 H5 预览会 reject Promise（errMsg:
  // 暂时不支持 API），同步 try-catch 捕不到 → 泄漏成 "Uncaught Object"；
  // 故仅在微信端调用，H5 直接回退 96px 固定留白
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
      console.log('[ping] getMenuButtonBoundingClientRect 异常，回退固定留白');
    }
  }, [isWeappEnv, sysInfo]);
  console.log('[ping] custom 导航栏生效，状态栏高度:', statusBarHeight, '胶囊右留白:', capsuleRightPadding);

  const targetHost = useRef('');

  const setItemPending = (key: ServerItemKey, on: boolean) => {
    setPendingItems((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  };

  const putResult = (key: ServerItemKey, r: DiagnoseResult) => {
    setResults((prev) => ({ ...prev, [key]: r }));
  };

  /** 单项执行（服务端项走函数；local/arp 本地处理） */
  const execItem = async (key: ServerItemKey, host: string, force: boolean) => {
    if (key === 'arp') {
      putResult(key, buildArpResult());
      return;
    }
    if (key === 'local') {
      setItemPending(key, true);
      const r = await runLocalItem();
      putResult(key, r);
      setItemPending(key, false);
      return;
    }
    setItemPending(key, true);
    const r = await runServerItem(host, key, force);
    putResult(key, r);
    setItemPending(key, false);
  };

  const handleDiagnose = async (force = false) => {
    const raw = inputValue.trim();
    if (!raw) {
      Taro.showToast({ title: '请输入域名或IP', icon: 'none' });
      return;
    }
    // 特殊暗号：输入6666跳转到聊天页
    if (raw === '6666') {
      // ⚠️ 登录次数只在这里打点：auth 事件（冷启动恢复会话、token 刷新、切后台回前台）
      // 一律不计数，只有用户主动用暗号进入聊天区才算一次登录（recordLastLogin 消费额度）。
      markSecretEntry();
      console.log('[ping] 暗号进入聊天列表, reLaunch 到 chats（已打暗号进入点，本次计入登录统计）');
      Taro.reLaunch({ url: '/pages/chats/index' });
      return;
    }
    // 特殊暗号：「账号+密码」→ 凭据完全正确才进聊天列表；不正确一律交回诊断流程。
    // ⚠️ 必须先看 normalizeTarget：含 `+` 的串永远通不过 HOSTNAME_RE，所以「像凭据但登录失败」
    // 的输入会自然落到下面的 toast「仅支持域名/IP/网址」，不会把用户困在聊天入口里。
    const target = normalizeTarget(raw);
    if (!target) {
      const cred = parseCredentialInput(raw);
      if (cred) {
        const ok = await signInAndEnterChats(cred.username, cred.password);
        if (ok) return;
        console.log('[ping] 账号暗号未通过校验，按普通诊断输入处理');
      }
      Taro.showToast({ title: '仅支持域名/IP/网址，可带端口', icon: 'none' });
      return;
    }
    // 特殊暗号：输入 ai（大小写任意组合）单向进入隐藏的 AI 助手页
    if (raw.toLowerCase() === 'ai') {
      // AI 助手页不属于聊天区，不计登录次数——不打暗号点。
      console.log('[ping] 暗号进入 AI 助手页, reLaunch 到 ai-chat（非聊天区，不计登录）');
      Taro.reLaunch({ url: '/pages/ai-chat/index' });
      return;
    }
    if (target !== raw) {
      setInputValue(target);
      console.log('[ping] 输入已归一化:', raw, '→', target);
    }

    if (force) clearDiagnoseCache();
    targetHost.current = target;
    setHistory(getDiagHistory(target)); // 先取「本次之前」的历史，供结束后对比
    const myRun = ++runIdRef.current;
    setRunning(true);
    setStarted(true);
    setResults({});
    setPendingItems(new Set(DIAGNOSE_ITEMS.map((i) => i.key)));

    // 全部并行发起、独立返回；collected 在写入 state 的同时聚合一份，
    // 供结束后留存历史（避免在 setState 更新函数内做副作用）。
    const collected: ResultsMap = {};
    await Promise.allSettled(
      DIAGNOSE_ITEMS.map(async (meta) => {
        const r = meta.serverSide
          ? await runServerItem(target, meta.key, force)
          : meta.key === 'local'
            ? await runLocalItem()
            : buildArpResult();
        if (runIdRef.current !== myRun) return; // 已被新一轮诊断取代或已中止
        collected[meta.key] = r;
        putResult(meta.key, r);
        setPendingItems((prev) => {
          const next = new Set(prev);
          next.delete(meta.key);
          return next;
        });
      }),
    );
    if (runIdRef.current !== myRun) return; // 中途被停止：不覆盖 running 状态、不留存
    setRunning(false);

    try {
      saveDiagSnapshot(target, collected, extractPingMetrics(collected.ping));
      setHistory(getDiagHistory(target));
    } catch (e) {
      console.warn('[ping] 历史留存异常:', e);
    }
  };

  // 从批量诊断页返回：若带回了「下钻全量诊断」目标（take 后即焚），
  // 回填主输入框，用户点「开始全量诊断」即可复测。首次进入本页时无 key，不触发。
  useDidShow(() => {
    const target = takeDeepDiagnoseTarget();
    if (!target) return;
    console.log('[ping] 🎯 接收批量页下钻目标，回填主输入框（不自动发起诊断）:', target);
    setInputValue(target);
  });

  /** 停止当前诊断：递增代次令牌，在途结果回来后一律丢弃 */
  const handleStop = () => {
    if (!running) return;
    runIdRef.current += 1;
    abortActiveRun();
    setRunning(false);
    setPendingItems(new Set());
    Taro.showToast({ title: '已停止本次诊断', icon: 'none' });
  };

  /** 单项重试 */
  const handleRetryItem = async (key: ServerItemKey) => {
    if (!targetHost.current) return;
    await execItem(key, targetHost.current, true);
  };

  /** 图例锚点导航：滚动到对应分组。
   * 【真机根因】本页外层 View 是 min-h-screen，ScrollView(flex-1) 在微信端并未形成
   * 固定高度的内部滚动容器——真正滚动的是**页面**。因此对 ScrollView 设 scrollTop
   * 或读它的 scrollOffset 都拿不到有效值，表现为「只收起图例、页面不动」。
   * 正确做法：用 selectorQuery 测目标节点相对视口的偏移，叠加页面当前滚动量
   * （H5 取 window.scrollY，微信端取 viewport 的 top 负偏移），再走
   * Taro.pageScrollTo 驱动页面滚动；H5 额外直接 scrollTo 真实可滚容器兜底。 */
  const legendNavTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleLegendNav = (groupKey: string) => {
    console.log('[ping] 图例点击跳转, 目标分组:', groupKey, 'started:', started);
    setLegendOpen(false);
    if (!started) {
      Taro.showToast({ title: '开始诊断后可跳转查看该项结果', icon: 'none' });
      return;
    }
    if (legendNavTimer.current) clearTimeout(legendNavTimer.current);
    // 等图例收起引起的布局变化稳定后再测量,避免高度塌陷导致落点偏移
    legendNavTimer.current = setTimeout(() => {
      try {
        const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
        // H5：找到真正可滚动的容器（可能是外层 ScrollView 内子元素，也可能是 document）
        const getScroller = (): HTMLElement | null => {
          try {
            const outer = document.getElementById('diag-scroll');
            if (outer) {
              for (const child of Array.from(outer.children) as HTMLElement[]) {
                if (child.scrollHeight - child.clientHeight > 4) return child;
              }
            }
            const doc = document.scrollingElement || document.documentElement;
            return doc as HTMLElement;
          } catch {
            return null;
          }
        };
        const applyScroll = (v: number) => {
          const val = Math.max(0, Math.round(v));
          console.log('[ping] 应用滚动: scrollTop=', val);
          // 优先走 Taro 页面级滚动（两端一致）
          try {
            Taro.pageScrollTo({ scrollTop: val, duration: 300 });
          } catch (e) {
            console.log('[ping] pageScrollTo异常:', e);
          }
          if (!isWeapp) {
            const el = getScroller();
            if (el) {
              try {
                el.scrollTo({ top: val, behavior: 'smooth' });
              } catch {
                el.scrollTop = val;
              }
            }
          }
          // state 同步一份，保证受控 ScrollView 在能内部滚动的设备上仍生效
          setScrollTarget({ top: val, tick: scrollTarget.tick + 1 });
        };
        const q = Taro.createSelectorQuery();
        q.select('#diag-scroll').boundingClientRect();
        q.select(`#group-${groupKey}`).boundingClientRect();
        q.exec((res: any) => {
          const viewRect = Array.isArray(res) ? res[0] : null;
          const targetRect = Array.isArray(res) ? res[1] : null;
          if (!targetRect) {
            console.log('[ping] 锚点测量失败(目标未命中),降级为向下滚动一屏:', !!viewRect);
            const fh = viewRect?.height ?? 600;
            const cur = !isWeapp ? (window.scrollY || getScroller()?.scrollTop || 0) : 0;
            applyScroll(cur + fh * 0.8);
            return;
          }
          // 目标顶部落到视口顶部：新 scrollTop = 当前页面滚动量 + 目标相对视口偏移
          const offset = targetRect.top - (viewRect?.top ?? 0);
          const current = !isWeapp
            ? window.scrollY || getScroller()?.scrollTop || 0
            : Math.max(0, -(viewRect?.top ?? 0));
          const next = current + offset - 4;
          console.log('[ping] 跳转计算: 当前滚动量=', Math.round(current), '目标偏移=', Math.round(offset), '→ 新scrollTop=', Math.round(next));
          applyScroll(next);
        });
      } catch (e) {
        console.log('[ping] 锚点导航异常:', e);
      }
    }, 150);
  };

  /** AI 解读：把本次诊断结果打包暂存 Storage → reLaunch 到 AI 助手页自动发送。
   * reLaunch 会销毁页面栈且 URL query 有约 2KB 限制，故走一次性中转（take 后即焚）。 */
  const handleAiInterpret = (conc: Conclusion | null) => {
    const items: DiagAiItem[] = [];
    for (const meta of DIAGNOSE_ITEMS) {
      const r = results[meta.key];
      if (!r || r.status === 'pending') continue;
      items.push({ title: meta.title, status: r.status, summary: r.summary });
    }
    if (items.length === 0) {
      Taro.showToast({ title: '暂无有效诊断结果', icon: 'none' });
      return;
    }
    const metrics = extractPingMetrics(results.ping);
    saveDiagForAi({
      target: targetHost.current,
      at: Date.now(),
      items,
      avgMs: metrics.avgMs,
      lossPct: metrics.lossPct,
      rootCause: conc?.rootCause,
      suggestion: conc?.suggestion,
      passedNotes: conc?.passedNotes,
    });
    console.log(`[ping] 🤖 AI 解读跳转: ${targetHost.current}（${items.length} 项）`);
    // 预热 ai-chat 函数实例：让冷启动开销与页面切换重叠，AI 页首条回复更快到达
    warmupAiChat();
    // 小程序 reLaunch 本身有页面栈销毁+新页首帧开销，先给即时反馈避免「点了没反应」
    Taro.showLoading({ title: 'AI 正在解读…', mask: true });
    Taro.reLaunch({
      url: '/pages/ai-chat/index?fromDiag=1',
      complete: () => Taro.hideLoading(),
    });
  };

  /** 一键复制结论文本，方便分享 */
  const handleCopyConclusion = () => {
    const lines: string[] = [`【网络诊断报告】目标：${targetHost.current}`];
    if (conclusion) {
      lines.push(conclusion.rootCause, '');
      conclusion.issues.forEach((iss, idx) => {
        lines.push(`${idx + 1}. [${iss.status === 'fail' ? '失败' : '告警'}] ${iss.label}：${iss.summary}`, `   建议：${iss.suggestion}`);
      });
      if (conclusion.passedNotes.length > 0) {
        lines.push('', '已排除的层级：', ...conclusion.passedNotes.map((n) => `✓ ${n}`));
      }
    } else {
      lines.push('全部检测项未发现失败或告警，目标网络链路整体正常');
    }
    const text = lines.join('\n');
    console.log('[ping] 复制结论，文本长度:', text.length);
    Taro.setClipboardData({
      data: text,
      success: () => {
        console.log('[ping] setClipboardData success');
        Taro.showToast({ title: '结论已复制', icon: 'success' });
      },
      fail: (err) => {
        console.log('[ping] setClipboardData fail:', err, '→ 打开可选中文本降级弹层');
        // 真机常见 errno 112：mp 后台「用户隐私保护指引」未声明「读取剪贴板」。
        // showModal 原生弹窗文字不可长按选中，故降级为页面内 <Text selectable> 弹层。
        setCopyFallbackText(text);
      },
    });
  };

  const conclusion = started ? deriveConclusion(results) : null;
  const doneCount = DIAGNOSE_ITEMS.length - pendingItems.size;
  const statusCounts = DIAGNOSE_ITEMS.reduce(
    (acc, meta) => {
      const r = results[meta.key];
      const s: ItemStatus = pendingItems.has(meta.key) ? 'pending' : r?.status ?? 'pending';
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<ItemStatus, number>>,
  );

  return (
    <ErrorBoundary route="pages/ping/index">
    <View className="min-h-screen bg-background flex flex-col px-4 py-6" style={{ paddingTop: `${statusBarHeight + 16}px` }}>
      {/* 标题（custom 导航栏下自绘；标题短，直接全屏居中，无需按胶囊留白） */}
      <Text className="text-2xl font-bold text-foreground mb-1 text-center">网络诊断台</Text>
      <Text className="text-muted-foreground text-xs mb-5 text-center leading-relaxed">
        输入域名或IP，点击「开始全量诊断」，逐项检测并汇总根因与建议。
      </Text>

      {/* 输入区 */}
      <View className="bg-card border border-border rounded-lg p-4 mb-3">
        <Input
          className="w-full bg-transparent text-foreground"
          value={inputValue}
          onInput={(e) => setInputValue(e.detail.value)}
          placeholder="输入域名或IP地址（可带端口）"
          placeholderClass="text-muted-foreground"
          confirmType="go"
          onConfirm={() => handleDiagnose(false)}
        />
        {/* 「账号+密码」暗号校验中的页面内提示（取代 Taro.showLoading，避免与 toast 抢同一原生层） */}
        {credBusy && (
          <View className="flex flex-row items-center mt-3">
            <View className="i-lucide-loader-circle w-4 h-4 text-primary mr-2" />
            <Text className="text-muted-foreground text-xs leading-none">正在校验账号…</Text>
          </View>
        )}
        {/* 「批量诊断」入口只在下方按钮组里保留一处，此处不再重复放引导行 */}
      </View>

      {/* 按钮组：主按钮「开始全量诊断」+ 右侧「批量诊断」入口。
          ⚠️ 原「强制重测」按钮已移除——它与主按钮走的是同一个 handleDiagnose，
          唯一区别是 force=true 绕过 60s 缓存，语义太隐晦（用户不知道缓存的存在），
          且占掉了右侧这个更该给「批量诊断」的位置。需要重测时再点一次主按钮即可，
          缓存过期后自然重跑。
          ⚠️ 两个按钮都是「图标 + 文字」结构，风格统一；图标类名必须字面量，
          动态拼接扫描不到不会打包。 */}
      <View className="flex flex-row mb-4">
        {running ? (
          <View
            className="flex-1 rounded-lg py-3 flex flex-row items-center justify-center mr-2 border"
            style={{ borderColor: 'rgba(220, 38, 38, 0.4)', backgroundColor: 'rgba(220, 38, 38, 0.08)' }}
            onClick={handleStop}
          >
            <View className="i-lucide-square w-4 h-4 mr-1" style={{ color: '#dc2626' }} />
            <Text className="text-sm font-medium leading-none" style={{ color: '#dc2626' }}>
              停止诊断（已完成 {doneCount}/{DIAGNOSE_ITEMS.length}）
            </Text>
          </View>
        ) : (
          <View
            className="flex-1 bg-primary rounded-lg py-3 flex flex-row items-center justify-center mr-2"
            onClick={() => handleDiagnose(false)}
          >
            <View className="i-lucide-play w-4 h-4 text-primary-foreground mr-1" />
            <Text className="text-primary-foreground font-medium text-sm leading-none">开始全量诊断</Text>
          </View>
        )}
        {/* 批量诊断按钮：浅色描边块，与主按钮的实心块形成主次层级 */}
        <View
          className={`px-4 rounded-lg flex flex-row items-center justify-center border border-border ${running ? 'opacity-50' : ''}`}
          style={{ backgroundColor: 'rgba(14, 165, 233, 0.08)' }}
          onClick={() => !running && handleOpenBatchDiag()}
        >
          <View className="i-lucide-list-checks w-4 h-4 text-primary mr-1" />
          <Text className="text-primary text-sm leading-none">批量诊断</Text>
        </View>
      </View>

      {/* 检测层级图例（可折叠；点击层级名锚点跳转到对应分组） */}
      <View className="bg-card border border-border rounded-lg mb-4">
        <View
          className="flex flex-row items-center justify-between px-4 py-3"
          onClick={() => setLegendOpen(!legendOpen)}
        >
          <Text className="text-foreground text-xs font-bold">检测层级说明</Text>
          <View className="flex flex-row items-center">
            <Text className="text-muted-foreground text-xs mr-1">{legendOpen ? '收起' : '展开'}</Text>
            <View className={`i-lucide-chevron-down w-4 h-4 text-muted-foreground ${legendOpen ? 'rotate-180' : ''}`} />
          </View>
        </View>
        {legendOpen && (
          <View className="px-4 pb-4 space-y-2">
            {LAYER_LEGEND.map((l) => (
              <View key={l.name} className="flex flex-row items-start py-2" onClick={() => handleLegendNav(l.groupKey)}>
                <Text className="text-primary text-xs mr-2" style={{ minWidth: '72px' }}>{l.name} ›</Text>
                <Text className="text-muted-foreground text-xs flex-1 leading-relaxed">{l.desc}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <ScrollView
        scrollY
        scrollTop={scrollTarget.top}
        scrollWithAnimation
        id="diag-scroll"
        className="flex-1"
      >
        {/* 概览条 */}
        {started && (
          <View className="bg-card border border-border rounded-lg px-4 py-3 mb-4 flex flex-row items-center">
            <View className="flex flex-row items-center mr-4">
              <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#16a34a' }} />
              <Text className="text-xs text-muted-foreground">通过 {statusCounts.pass ?? 0}</Text>
            </View>
            <View className="flex flex-row items-center mr-4">
              <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#d97706' }} />
              <Text className="text-xs text-muted-foreground">警告 {statusCounts.warn ?? 0}</Text>
            </View>
            <View className="flex flex-row items-center mr-4">
              <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#dc2626' }} />
              <Text className="text-xs text-muted-foreground">失败 {statusCounts.fail ?? 0}</Text>
            </View>
            <View className="flex flex-row items-center">
              <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#64748b' }} />
              <Text className="text-xs text-muted-foreground">其他 {(statusCounts.na ?? 0) + (statusCounts.unsupported ?? 0)}</Text>
            </View>
          </View>
        )}

        {/* 分组卡片 */}
        {started &&
          GROUPS.map((g) => {
            const items = DIAGNOSE_ITEMS.filter((i) => i.group === g.key);
            if (items.length === 0) return null;
            return (
              <View key={g.key} id={`group-${g.key}`}>
                <Text className="text-foreground text-sm font-bold mb-2 mt-1">{g.title}</Text>
                {items.map((meta) => (
                  <View key={meta.key}>
                    <DiagnoseCard
                      meta={meta}
                      result={results[meta.key]}
                      loading={pendingItems.has(meta.key)}
                      onRetry={() => handleRetryItem(meta.key)}
                    />
                    {/* 多点拨测项：在通用卡片下方追加节点视角对比面板 */}
                    {meta.key === 'multiprobe' && results[meta.key] && !pendingItems.has(meta.key) && (
                      <MultiProbePanel result={results[meta.key] as DiagnoseResult} />
                    )}
                  </View>
                ))}
              </View>
            );
          })}

        {/* 结论与建议 */}
        {started && !running && (
          /* 边框色为状态语义色（告警橙/成功绿），非中性边框，刻意保留 inline rgba（小程序不支持 bg/border 透明度简写） */
          <View
            className="bg-card border border-border rounded-lg p-4 mt-1"
            style={{ borderColor: conclusion ? 'rgba(217, 119, 6, 0.4)' : 'rgba(22, 163, 74, 0.4)' }}
          >
            <View className="flex flex-row items-center justify-between mb-2">
              <Text className="text-foreground text-sm font-bold">诊断结论</Text>
              <View className="flex flex-row items-center">
                <View className="flex flex-row items-center px-3 py-2 mr-1" catchMove onClick={() => handleAiInterpret(conclusion)}>
                  <View className="i-lucide-sparkles w-3 h-3 text-primary mr-1" />
                  <Text className="text-primary text-xs">AI 解读</Text>
                </View>
                <View className="flex flex-row items-center px-3 py-2" catchMove onClick={handleCopyConclusion}>
                  <View className="i-lucide-copy w-3 h-3 text-muted-foreground mr-1" />
                  <Text className="text-muted-foreground text-xs">复制结论</Text>
                </View>
              </View>
            </View>
            {conclusion ? (
              <View>
                <View className="flex flex-row mb-3">
                  <Text className="text-muted-foreground text-xs mr-2" style={{ minWidth: '56px' }}>根因候选</Text>
                  <Text className="text-foreground text-xs flex-1 leading-relaxed">{conclusion.rootCause}</Text>
                </View>
                <Text className="text-foreground text-xs font-bold mb-2 block">异常项明细</Text>
                <View className="space-y-3 mb-3">
                  {conclusion.issues.map((iss) => (
                    <View key={iss.label} className="border border-border rounded-lg p-3">
                      <View className="flex flex-row items-center mb-1">
                        <View
                          className="w-2 h-2 rounded-full mr-2"
                          style={{ backgroundColor: iss.status === 'fail' ? '#dc2626' : '#d97706' }}
                        />
                        <Text className="text-foreground text-xs font-bold mr-2">{iss.label}</Text>
                        <Text className="text-xs" style={{ color: iss.status === 'fail' ? '#dc2626' : '#d97706' }}>
                          {iss.status === 'fail' ? '失败' : '告警'}
                        </Text>
                      </View>
                      <Text className="text-muted-foreground text-xs block leading-relaxed mb-1">{iss.summary}</Text>
                      <View className="flex flex-row">
                        <Text className="text-primary text-xs mr-1">建议：</Text>
                        <Text className="text-foreground text-xs flex-1 leading-relaxed">{iss.suggestion}</Text>
                      </View>
                    </View>
                  ))}
                </View>
                {conclusion.passedNotes.length > 0 && (
                  <View>
                    <Text className="text-foreground text-xs font-bold mb-1 block">已排除的层级</Text>
                    {conclusion.passedNotes.map((n) => (
                      <View key={n} className="flex flex-row items-start mb-1">
                        <Text className="mr-2 text-xs" style={{ color: '#16a34a' }}>✓</Text>
                        <Text className="text-muted-foreground text-xs flex-1 leading-relaxed">{n}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ) : (
              <View>
                <Text className="text-xs mb-2 block" style={{ color: '#16a34a' }}>
                  全部检测项未发现失败或告警，目标网络链路整体正常
                </Text>
                {conclusion === null && started && (
                  <Text className="text-muted-foreground text-xs leading-relaxed">
                    若访问仍有异常感受，可再点一次「开始全量诊断」重新跑一遍，或稍后再试以排除临时波动。
                  </Text>
                )}
              </View>
            )}
          </View>
        )}

        {/* 历史对比面板（该目标有历史记录时展示；面板内可自选对比基准） */}
        {started && !running && history.length > 0 && (
          <DiagHistoryPanel
            history={history}
            onClear={() => {
              clearDiagHistory(targetHost.current);
              setHistory([]);
              Taro.showToast({ title: '历史已清空', icon: 'none' });
            }}
          />
        )}

        {/* 空态提示 */}
        {!started && (
          <View className="flex flex-col items-center justify-center py-12">
            <View className="i-lucide-network w-16 h-16 text-muted-foreground mb-4" />
            <Text className="text-muted-foreground text-sm text-center">
              填写目标后开始诊断，结果将按层级逐项展示{'\n'}可直接粘贴完整网址，支持中文域名与 IPv6
            </Text>
          </View>
        )}
      </ScrollView>

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
    </ErrorBoundary>
  );
}
