import { View, Text, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import DiagnoseCard from '@/components/diagnose-card';
import MultiProbePanel from '@/components/multi-probe-panel';
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
import { getDiagHistory, saveDiagSnapshot } from '@/lib/diag-history';
import { logDbg } from '@/lib/logger';

type ResultsMap = Partial<Record<ServerItemKey, DiagnoseResult>>;

const GROUPS: Array<{ key: string; title: string }> = [
  { key: 'link', title: '① 本机与链路层' },
  { key: 'dns', title: '② 域名解析层' },
  { key: 'transport', title: '③ 传输层' },
  { key: 'app', title: '④ 应用层' },
  { key: 'throughput', title: '⑤ 吞吐层' },
];

interface Props {
  /** 诊断目标（host[:port]，内部会再做一次归一化兜底） */
  target: string;
  /** 关闭面板（返回批量结果列表） */
  onClose: () => void;
}

/**
 * 单目标全量分层诊断面板：跑齐 ping 页的全部检测项（DNS/Ping/多DNS比对/端口/
 * 路由/HTTP/TLS/多点拨测/吞吐 + 本机与 ARP 两个本地项），并给出规则引擎结论。
 * 供批量诊断独立页下钻使用——批量列表只测 dns+ping 轻量两项，这里补齐后面几步。
 * 探测链路与 ping 页同源（runServerItem 60s 缓存、代次令牌中止），不重复请求。
 */
export default function FullDiagPanel({ target, onClose }: Props) {
  const [results, setResults] = useState<ResultsMap>({});
  const [pendingItems, setPendingItems] = useState<Set<ServerItemKey>>(new Set());
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  // 代次令牌：与 ping 页 handleStop 同思路，Taro.request 不可取消、只丢弃回包
  const runIdRef = useRef(0);
  const hostRef = useRef('');

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

  const startFullDiagnose = async (force = false) => {
    const host = normalizeTarget(target) ?? target.trim();
    if (!host) {
      Taro.showToast({ title: '诊断目标无效', icon: 'none' });
      return;
    }
    if (force) clearDiagnoseCache();
    hostRef.current = host;
    const myRun = ++runIdRef.current;
    setRunning(true);
    setStarted(true);
    setResults({});
    setPendingItems(new Set(DIAGNOSE_ITEMS.map((i) => i.key)));
    logDbg(`[full-diag] 🚀 全量诊断 ${host}（${DIAGNOSE_ITEMS.length} 项${force ? '，强制重测' : ''}）`);

    const collected: ResultsMap = {};
    await Promise.allSettled(
      DIAGNOSE_ITEMS.map(async (meta) => {
        const r = meta.serverSide
          ? await runServerItem(host, meta.key, force)
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
    if (runIdRef.current !== myRun) return;
    setRunning(false);
    try {
      // 与 ping 页共用同一份历史留存，回到 ping 页也能看到该目标的走势对比
      saveDiagSnapshot(host, collected, extractPingMetrics(collected.ping));
    } catch (e) {
      console.warn('[full-diag] 历史留存异常:', e);
    }
  };

  // 进入面板即自动开始一轮全量诊断（复用 runServerItem 缓存，刚测过的 dns/ping 秒回）。
  // ⚠️ 不在 cleanup 里递增 runIdRef：组件被重挂载时 cleanup 会先于新 effect 执行，
  // 若在此作废代次会把刚发起的首轮诊断误杀（表现为「只有 ping 结果、后续各项永不出现」）。
  useEffect(() => {
    logDbg('[full-diag] 📌 面板挂载，自动发起全量诊断, target:', target);
    void startFullDiagnose(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!hostRef.current) return;
    const meta = DIAGNOSE_ITEMS.find((i) => i.key === key);
    if (!meta) return;
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
    const r = await runServerItem(hostRef.current, key, true);
    putResult(key, r);
    setItemPending(key, false);
  };

  const conclusion: Conclusion | null = started ? deriveConclusion(results) : null;
  const doneCount = DIAGNOSE_ITEMS.length - pendingItems.size;
  const historyCount = hostRef.current ? getDiagHistory(hostRef.current).length : 0;

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
    <View className="bg-card border border-border rounded-lg p-4 mb-4">
      {/* 顶部固定区：返回批量结果 + 目标名 + 说明 + 按钮组 */}
      <View className="flex flex-row items-center mb-2">
        <View className="flex flex-row items-center mr-2 py-1" onClick={onClose}>
          <View className="i-lucide-chevron-left w-4 h-4 text-primary mr-1" />
          <Text className="text-primary text-xs">批量结果</Text>
        </View>
        <Text className="text-foreground text-sm font-bold flex-1" style={{ wordBreak: 'break-all' }}>{target}</Text>
      </View>
      <Text className="text-muted-foreground text-xs mb-3 leading-relaxed">
        全量分层诊断：在批量的 DNS + Ping 之外，补齐多DNS比对、端口、路由、HTTP、TLS、多点拨测、吞吐等后续各项。
      </Text>
      <View className="flex flex-row mb-3">
        {running ? (
          <View
            className="flex-1 rounded-lg py-3 flex items-center justify-center mr-2 border"
            style={{ borderColor: 'rgba(220, 38, 38, 0.4)', backgroundColor: 'rgba(220, 38, 38, 0.08)' }}
            onClick={handleStop}
          >
            <Text className="text-sm font-medium leading-none" style={{ color: '#dc2626' }}>
              停止（已完成 {doneCount}/{DIAGNOSE_ITEMS.length}）
            </Text>
          </View>
        ) : (
          <View className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center mr-2" onClick={() => void startFullDiagnose(false)}>
            <Text className="text-primary-foreground font-medium text-sm leading-none">重新全量诊断</Text>
          </View>
        )}
        <View
          className={`px-4 rounded-lg flex items-center justify-center border border-border ${running ? 'opacity-50' : ''}`}
          style={{ backgroundColor: 'rgba(14, 165, 233, 0.08)' }}
          onClick={() => !running && void startFullDiagnose(true)}
        >
          <Text className="text-primary text-sm leading-none">强制重测</Text>
        </View>
      </View>

      {/* 结果区：11 项卡片 + 结论卡总高远超一屏，必须放 ScrollView 内滚动查看。
          根 View 无固定高度时页面本身不滚（外层 flex 容器），内容会被直接截断——
          这正是此前用户反馈「还是只有 ping 的结果」的根因。 */}
      <ScrollView scrollY style={{ height: '62vh' }}>
        <View>
          {/* 概览条 */}
          {started && (
        <View className="rounded-lg px-3 py-2 mb-3 flex flex-row items-center border border-border" style={{ backgroundColor: 'rgba(14, 165, 233, 0.04)' }}>
          <View className="flex flex-row items-center mr-3">
            <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#16a34a' }} />
            <Text className="text-xs text-muted-foreground">通过 {statusCounts.pass ?? 0}</Text>
          </View>
          <View className="flex flex-row items-center mr-3">
            <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#d97706' }} />
            <Text className="text-xs text-muted-foreground">警告 {statusCounts.warn ?? 0}</Text>
          </View>
          <View className="flex flex-row items-center mr-3">
            <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#dc2626' }} />
            <Text className="text-xs text-muted-foreground">失败 {statusCounts.fail ?? 0}</Text>
          </View>
          <View className="flex flex-row items-center">
            <View className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: '#64748b' }} />
            <Text className="text-xs text-muted-foreground">其他 {(statusCounts.na ?? 0) + (statusCounts.unsupported ?? 0)}</Text>
          </View>
        </View>
      )}

      {/* 分组卡片（与 ping 页同款层级展示） */}
      {started &&
        GROUPS.map((g) => {
          const items = DIAGNOSE_ITEMS.filter((i) => i.group === g.key);
          if (items.length === 0) return null;
          return (
            <View key={g.key}>
              <Text className="text-foreground text-sm font-bold mb-2 mt-1">{g.title}</Text>
              {items.map((meta) => (
                <View key={meta.key}>
                  <DiagnoseCard
                    meta={meta}
                    result={results[meta.key]}
                    loading={pendingItems.has(meta.key)}
                    onRetry={() => void handleRetryItem(meta.key)}
                  />
                  {meta.key === 'multiprobe' && results[meta.key] && !pendingItems.has(meta.key) && (
                    <MultiProbePanel result={results[meta.key] as DiagnoseResult} />
                  )}
                </View>
              ))}
            </View>
          );
        })}

      {/* 诊断结论 */}
      {started && !running && (
        <View
          className="bg-card border rounded-lg p-4 mt-1"
          style={{ borderColor: conclusion ? 'rgba(217, 119, 6, 0.4)' : 'rgba(22, 163, 74, 0.4)' }}
        >
          <Text className="text-foreground text-sm font-bold mb-2 block">诊断结论</Text>
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
              <Text className="text-muted-foreground text-xs leading-relaxed">
                若访问仍有异常感受，可点击「强制重测」刷新缓存结果{historyCount > 1 ? '，或回到首页查看该目标的历史走势对比' : ''}。
              </Text>
            </View>
          )}
        </View>
      )}
        </View>
      </ScrollView>
    </View>
  );
}
