import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState } from 'react';
import * as stepsApi from '@/api/steps';
import type { StepPoint } from '@/api/steps';
import { useAuthStore } from '@/store/auth-store';
import { useMessagesStore } from '@/store/messages-store';
import { logDbg } from '@/lib/logger';

/**
 * 「每天运动步数对比」卡片（聊天详情页内嵌版）。
 *
 * 数据来源：微信 getWeRunData（加密）→ net-diagnose 云函数的步数通道解密落库 →
 * 本卡片读本人 + 聊天对象的每日步数做对比。
 *
 * 设计取舍：
 * - 对比对象**固定为当前会话的聊天好友**（peerId 由父组件传入），不再自己选人——
 *   多好友场景下「和谁比」由所在会话决定，语义最清晰；
 * - 进页先走 query（纯读已落库数据，秒出、不打微信接口），点「同步今日」才触发
 *   getWeRunData + 解密链路——避免每次进聊天页都拉一次系统隐私接口；
 * - 默认**收起**，只显一行摘要条，展开偏好存 storage（跨会话共享一个开关即可）；
 * - H5 预览态没有微信 JSAPI，syncMySteps 会抛「请在微信小程序中打开」，属预期降级，
 *   卡片照常渲染历史数据与提示，不做静默空白。
 */

const RANGE_OPTIONS = [
  { label: '7天', days: 7 },
  { label: '14天', days: 14 },
  { label: '30天', days: 30 },
];

/** 展开偏好存储 key（'1'=展开） */
const EXPAND_KEY = 'steps_card_expanded_v1';

interface Snapshot {
  mine: StepPoint[];
  peer: StepPoint[];
  peerAllowed: boolean;
  /** 对方全历史最近同步日（'' = 从未同步过） */
  peerLastDay: string;
}

/** 东八区「今天」的 YYYY-MM-DD（设备时区异常时也不跟微信回包口径打架） */
function todayKey(): string {
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

/** 把 YYYY-MM-DD 压成 MM-DD 显示（跨年时带年份） */
function shortDay(day: string): string {
  const parts = day.split('-');
  if (parts.length !== 3) return day;
  const sameYear = Number(parts[0]) === Number(todayKey().slice(0, 4));
  return sameYear ? `${parts[1]}-${parts[2]}` : day;
}

/** 两个 YYYY-MM-DD 相差的天数（b - a，按东八区自然日算） */
function daysBetween(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00+08:00`).getTime();
  const tb = new Date(`${b}T00:00:00+08:00`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/**
 * 对方数据缺失时的提示文案——必须区分两种语义完全不同的情况：
 * - 从未同步过：对方还没点过「同步今日」，需要引导 TA 去点；
 * - 同步过但近期没同步：对方以前同步过，只是最近没点，历史数据仍在。
 * 只看 peer 数组两者都是空，必须靠 peerLastDay 判定。
 */
function peerMissingHint(peerLastDay: string): string {
  if (!peerLastDay) {
    return '对方还没有同步过步数。让 TA 点一次「同步今日」，就能看到对比了。';
  }
  const gap = daysBetween(peerLastDay, todayKey());
  if (gap <= 0) return '对方今天还没同步步数，TA 同步后这里会立即更新。';
  return `对方最近一次同步是 ${shortDay(peerLastDay)}（${gap} 天前），近期没有更新步数。`;
}

/**
 * 生成以「今天」为起点的连续 N 天真实日历轴（YYYY-MM-DD，**降序：今天在最前**）。
 * ⚠️ 不能直接拿返回行排序当轴：中间某天没同步就断档、日期跳着显示，
 * 用户看到的就是「日期错误」。缺失日一律补 0。
 * ⚠️ 顺序必须是降序（今天 → 越早越靠下）：用户明确要求日期降序排列，
 *    且「今天」置顶后无需滚动就能看到当天对比，与摘要条的「今日」口径一致。
 */
function buildAxis(days: number): string[] {
  const base = new Date(`${todayKey()}T00:00:00+08:00`).getTime();
  const DAY_MS = 86400000;
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const t = base - i * DAY_MS;
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(t));
      const map: Record<string, string> = {};
      for (const p of parts) map[p.type] = p.value;
      if (map.year && map.month && map.day) {
        out.push(`${map.year}-${map.month}-${map.day}`);
        continue;
      }
    } catch {
      /* 回落本地时区 */
    }
    const d = new Date(t);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${dd}`);
  }
  return out;
}

/** 按真实日历轴合并两人数据，缺失日按 0 计（未授权/未同步的日子确实没有步数记录） */
function mergeDays(mine: StepPoint[], peer: StepPoint[], days: number): Array<{ day: string; me: number; ta: number }> {
  const meMap = new Map<string, number>();
  const taMap = new Map<string, number>();
  for (const p of mine) meMap.set(p.day, p.steps);
  for (const p of peer) taMap.set(p.day, p.steps);
  // buildAxis 已按降序（今天在最前）产出，这里保持原序，不再二次排序
  return buildAxis(days).map((day) => ({ day, me: meMap.get(day) ?? 0, ta: taMap.get(day) ?? 0 }));
}

export default function StepsCompareCard(props: {
  userId: string;
  /** 对比对象：当前会话的聊天好友 uid（chat 页传入） */
  peerId: string;
  /** 对比对象昵称：用于标题与「TA」列展示 */
  peerName?: string;
  /** 当前会话 id：用于「提醒对方同步」直接发消息（chat 页传入） */
  conversationId: string;
  /**
   * 是否由外部容器（弹层）提供外壳。
   * true 时组件不再画自己的卡片边框/背景/圆角，只输出内容——
   * 否则弹层里会出现「卡片套卡片」的双层边框。
   */
  bare?: boolean;
  onInteract: () => void;
}) {
  const { userId, peerId, peerName, conversationId, bare = false, onInteract } = props;
  const [days, setDays] = useState(7);
  const [snap, setSnap] = useState<Snapshot>({ mine: [], peer: [], peerAllowed: false, peerLastDay: '' });
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [error, setError] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState('');
  const [expanded, setExpanded] = useState(() => (props.bare ? true : Taro.getStorageSync(EXPAND_KEY) === '1'));

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    Taro.setStorageSync(EXPAND_KEY, next ? '1' : '0');
    onInteract();
  };

  // peerId（切换会话）或登录账号变化时重新读取；只读库、不触发微信接口
  useEffect(() => {
    let alive = true;
    if (!userId || !peerId) {
      setSnap({ mine: [], peer: [], peerAllowed: false, peerLastDay: '' });
      return;
    }
    (async () => {
      setLoading(true);
      setError('');
      try {
        const r = await stepsApi.fetchStepsCompare(peerId, days);
        if (!alive) return;
        setSnap({ mine: r.mine, peer: r.peer, peerAllowed: r.peerAllowed, peerLastDay: r.peerLastDay });
        logDbg(`[steps-card] 📊 首屏读取：本人${r.mine.length}天 / 对方${r.peer.length}天 / 允许对比=${r.peerAllowed} / 对方最近同步=${r.peerLastDay || '从未'} `);
      } catch (e) {
        console.warn('[steps-card] ⚠️ 首屏读取步数失败:', e);
        if (alive) setError((e as Error).message || '步数数据读取失败');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, peerId]);

  /** 切换天数窗口：同样只读库 */
  const switchRange = async (d: number) => {
    setDays(d);
    setError('');
    onInteract();
    try {
      const r = await stepsApi.fetchStepsCompare(peerId, d);
      setSnap({ mine: r.mine, peer: r.peer, peerAllowed: r.peerAllowed, peerLastDay: r.peerLastDay });
    } catch (e) {
      console.warn('[steps-card] ⚠️ 切换天数后查询失败:', e);
      setError((e as Error).message || '查询失败');
    }
  };

  /** 主动同步：走微信 getWeRunData + 服务端解密落库 */
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError('');
    onInteract();
    try {
      const r = await stepsApi.syncMySteps(peerId, days);
      setSnap({ mine: r.mine, peer: r.peer, peerAllowed: r.peerAllowed, peerLastDay: r.peerLastDay });
      setLastSyncAt(new Date().toLocaleTimeString());
      Taro.showToast({ title: `今日 ${r.today} 步`, icon: 'none' });
    } catch (e) {
      const msg = (e as Error).message || '步数同步失败';
      console.warn('[steps-card] ⚠️ 同步失败:', msg);
      setError(msg);
      if (/隐私保护指引/.test(msg)) {
        Taro.showModal({
          title: '微信隐私权限未开通',
          content:
            '小程序尚未在微信公众平台《用户隐私保护指引》中声明「微信运动步数」这项信息，微信因此拦截了读取。请前往：微信公众平台 → 设置 → 服务内容声明 → 用户隐私保护指引 → 添加信息类型「微信运动步数」并填写用途，保存后重新生成预览码即可。此项只能在后台开通，代码无法绕过。',
          confirmText: '知道了',
          showCancel: false,
        });
      } else {
        Taro.showToast({ title: msg, icon: 'none' });
      }
    } finally {
      setSyncing(false);
      onInteract();
    }
  };

  /**
   * 提醒对方同步：直接往当前会话发一条提醒消息。
   * ⚠️ 不复用 chat 页的 onSendText——它依赖页面输入框 state（inputValue/replyTo），
   *    卡片里没有这些状态；直接调 store 的 sendMessage 才是干净接入点。
   * ⚠️ 发送前必须门控 auth 过渡态：bootstrapped 时无 access token，请求必被 RLS 挡掉。
   */
  const handleRemind = async () => {
    if (reminding) return;
    if (!conversationId) {
      Taro.showToast({ title: '数据尚未就绪，请稍候重试', icon: 'none' });
      return;
    }
    setReminding(true);
    onInteract();
    try {
      const authState = useAuthStore.getState();
      if (authState.bootstrapped) {
        throw new Error('登录状态尚未就绪，请稍候重试');
      }
      const text = peerLastDayForRemind
        ? `记得同步一下今天的步数～（你上次同步是 ${shortDay(peerLastDayForRemind)}）`
        : '记得同步一下今天的步数～点「同步今日」就能看到我们的对比啦';
      await useMessagesStore.getState().sendMessage(conversationId, text, 'text');
      Taro.showToast({ title: '已发送提醒', icon: 'success' });
    } catch (e) {
      const msg = (e as Error).message || '发送提醒失败';
      console.warn('[steps-card] ⚠️ 发送提醒失败:', msg);
      Taro.showToast({ title: msg, icon: 'none' });
    } finally {
      setReminding(false);
      onInteract();
    }
  };

  const rows = mergeDays(snap.mine, snap.peer, days);
  const maxSteps = Math.max(1, ...rows.map((r) => Math.max(r.me, r.ta)));
  const myTotal = rows.reduce((s, r) => s + r.me, 0);
  const peerTotal = rows.reduce((s, r) => s + r.ta, 0);
  const tk = todayKey();
  /** 对方数据缺失（从未同步 / 今天没同步 / 近期没同步）——此时才给「提醒对方同步」入口 */
  const peerMissing = snap.peerAllowed && (peerTotal === 0 || snap.peerLastDay !== tk);
  const peerLastDayForRemind = snap.peerLastDay;
  const todayRow = rows.find((r) => r.day === tk);
  const todayMine = todayRow?.me ?? 0;
  const todayPeer = todayRow?.ta ?? 0;
  const diff = todayMine - todayPeer;
  const taLabel = peerName || 'TA';

  return (
    <View className={bare ? 'w-full' : 'w-full bg-card border border-border rounded-lg px-4 py-3'}>
      {/* 摘要条：收起态也可见，点击整行展开/收起 */}
      <View className="flex flex-row items-center justify-between" onClick={toggleExpanded}>
        <View className="flex flex-row items-center">
          <View className="i-lucide-footprints w-4 h-4 text-muted-foreground mr-2" />
          <Text className="text-xs text-muted-foreground leading-none">运动步数对比 · {taLabel}</Text>
        </View>
        <View className="flex flex-row items-center">
          {!loading && (
            <Text className="text-xs text-muted-foreground leading-none mr-2">
              今日 {todayMine}/{todayPeer}
            </Text>
          )}
          {/* bare 模式下由弹层提供关闭按钮，收起箭头会与「关闭」语义打架，故不渲染 */}
          {!bare && (
            <View className={expanded ? 'i-lucide-chevron-up w-4 h-4 text-muted-foreground' : 'i-lucide-chevron-down w-4 h-4 text-muted-foreground'} />
          )}
        </View>
      </View>

      {expanded && (
        <View>
          {/* 操作行：同步今日 */}
          <View className="flex flex-row items-center justify-between mt-3">
            <Text className="text-xs text-muted-foreground leading-none">和 {taLabel} 逐日对比（数据来自微信运动）</Text>
            <View
              className={
                syncing
                  ? 'flex flex-row items-center opacity-60'
                  : 'flex flex-row items-center active:opacity-70'
              }
              onClick={handleSync}
            >
              {/* ⚠️ 图标类名必须字面量：动态拼接 Tailwind 扫不到、不会打包进 CSS（表现为空白） */}
              {syncing ? (
                <View className="i-lucide-loader-2 w-4 h-4 text-primary mr-1" />
              ) : (
                <View className="i-lucide-refresh-cw w-4 h-4 text-primary mr-1" />
              )}
              <Text className="text-xs text-primary leading-none">{syncing ? '同步中' : '同步今日'}</Text>
            </View>
          </View>

          {/* 天数窗口 */}
          <View className="flex flex-row items-center mt-3">
            {RANGE_OPTIONS.map((o) => (
              <View
                key={o.days}
                className="px-3 py-2 rounded-md mr-2 active:opacity-80"
                style={
                  o.days === days
                    ? { backgroundColor: 'rgba(37, 99, 235, 0.12)' }
                    : { backgroundColor: 'rgba(120, 120, 128, 0.08)' }
                }
                onClick={() => switchRange(o.days)}
              >
                <Text className={o.days === days ? 'text-xs text-primary leading-none' : 'text-xs text-muted-foreground leading-none'}>
                  {o.label}
                </Text>
              </View>
            ))}
          </View>

          {loading && (
            <Text className="block text-xs text-muted-foreground mt-3 leading-relaxed">正在读取步数数据...</Text>
          )}

          {!loading && error !== '' && (
            <Text className="block text-xs text-destructive mt-3 leading-relaxed">{error}</Text>
          )}

          {!loading && error === '' && myTotal === 0 && peerTotal === 0 && (
            <Text className="block text-xs text-muted-foreground mt-3 leading-relaxed">
              暂无步数记录。点右上角「同步今日」读取本机微信运动数据（需已在公众平台声明「微信运动步数」）。
            </Text>
          )}

          {/* 今日对比结论 + 逐日双柱 */}
          {!loading && (myTotal > 0 || peerTotal > 0) && (
            <View className="mt-3">
              <View className="flex flex-row items-end justify-between">
                <View className="flex flex-col">
                  <Text className="text-xs text-muted-foreground leading-none">今日 · 我</Text>
                  <Text className="text-foreground mt-1">{todayMine.toLocaleString()}</Text>
                </View>
                <View className="flex flex-col items-center">
                  <Text
                    className={
                      diff > 0 ? 'text-xs text-primary leading-none' : diff < 0 ? 'text-xs text-destructive leading-none' : 'text-xs text-muted-foreground leading-none'
                    }
                  >
                    {diff === 0 ? '持平' : diff > 0 ? `领先 ${diff.toLocaleString()}` : `落后 ${Math.abs(diff).toLocaleString()}`}
                  </Text>
                </View>
                <View className="flex flex-col items-end">
                  <Text className="text-xs text-muted-foreground leading-none">今日 · {taLabel}</Text>
                  <Text className="text-foreground mt-1">{todayPeer.toLocaleString()}</Text>
                </View>
              </View>

              <View className="mt-3">
                {rows.map((r) => (
                  <View key={r.day} className="mb-2">
                    <View className="flex flex-row items-center justify-between">
                      <Text className="text-xs text-muted-foreground leading-none">
                        {r.day === tk ? '今天' : shortDay(r.day)}
                      </Text>
                      <Text className="text-xs text-muted-foreground leading-none">
                        {r.me.toLocaleString()} / {r.ta.toLocaleString()}
                      </Text>
                    </View>
                    <View className="mt-1">
                      <View
                        className="h-2 rounded-sm"
                        style={{ width: `${Math.max(2, Math.round((r.me / maxSteps) * 100))}%`, backgroundColor: '#2563eb' }}
                      />
                    </View>
                    <View className="mt-1">
                      <View
                        className="h-2 rounded-sm"
                        style={{ width: `${Math.max(2, Math.round((r.ta / maxSteps) * 100))}%`, backgroundColor: 'rgba(120, 120, 128, 0.45)' }}
                      />
                    </View>
                  </View>
                ))}
              </View>

              <View className="flex flex-row items-center mt-1">
                <View className="w-3 h-2 rounded-sm mr-2" style={{ backgroundColor: '#2563eb' }} />
                <Text className="text-xs text-muted-foreground leading-none mr-3">我 · 合计 {myTotal.toLocaleString()}</Text>
                <View className="w-3 h-2 rounded-sm mr-2" style={{ backgroundColor: 'rgba(120, 120, 128, 0.45)' }} />
                <Text className="text-xs text-muted-foreground leading-none">{taLabel} · 合计 {peerTotal.toLocaleString()}</Text>
              </View>

              {!snap.peerAllowed && (
                <Text className="block text-xs text-muted-foreground mt-2 leading-relaxed">
                  你们之间还没有有效记录，暂时看不到 TA 的数据。
                </Text>
              )}
              {/* 对方数据缺失提示：必须区分「从未同步」与「近期没同步」两种语义，
                  两者在 peer 数组里都表现为空，只能靠 peerLastDay 判定 */}
              {snap.peerAllowed && peerTotal === 0 && (
                <Text className="block text-xs text-muted-foreground mt-2 leading-relaxed">
                  {peerMissingHint(snap.peerLastDay)}
                </Text>
              )}
              {snap.peerAllowed && peerTotal > 0 && snap.peerLastDay !== '' && snap.peerLastDay !== tk && (
                <Text className="block text-xs text-muted-foreground mt-2 leading-relaxed">
                  {peerMissingHint(snap.peerLastDay)}
                </Text>
              )}
              {lastSyncAt !== '' && (
                <Text className="block text-xs text-muted-foreground mt-2 leading-relaxed">最近同步：{lastSyncAt}</Text>
              )}

              {/* 提醒对方同步：仅在对方数据缺失时出现（对方今天已同步就没必要提醒） */}
              {peerMissing && (
                <View
                  className={
                    reminding
                      ? 'flex flex-row items-center justify-center mt-3 py-2 rounded-md opacity-60'
                      : 'flex flex-row items-center justify-center mt-3 py-2 rounded-md active:opacity-70'
                  }
                  style={{ backgroundColor: 'rgba(37, 99, 235, 0.12)' }}
                  onClick={handleRemind}
                >
                  {reminding ? (
                    <View className="i-lucide-loader-2 w-4 h-4 text-primary mr-1" />
                  ) : (
                    <View className="i-lucide-bell-ring w-4 h-4 text-primary mr-1" />
                  )}
                  <Text className="text-xs text-primary leading-none">
                    {reminding ? '发送中' : `提醒 ${taLabel} 同步`}
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
