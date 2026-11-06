import { View, Text } from '@tarojs/components';
import { useState } from 'react';
import type { ItemStatus, ServerItemKey } from '@/api/net-diagnose';
import { DIAGNOSE_ITEMS } from '@/api/net-diagnose';
import type { DiagSnapshot, DiffEntry } from '@/lib/diag-history';
import { diffSnapshots, relTimeLabel } from '@/lib/diag-history';

interface Props {
  /** 该目标的历史快照（最新在前），至少 2 条才有对比意义 */
  history: DiagSnapshot[];
  onClear: () => void;
}

const STATUS_TEXT: Record<ItemStatus | 'none', string> = {
  pass: '通过',
  warn: '警告',
  fail: '失败',
  na: '不适用',
  pending: '检测中',
  unsupported: '不支持',
  none: '无记录',
};

function statusColor(s: ItemStatus | 'none'): string {
  if (s === 'fail') return '#dc2626';
  if (s === 'warn') return '#d97706';
  if (s === 'pass') return '#16a34a';
  return '#64748b';
}

function titleOf(key: ServerItemKey): string {
  return DIAGNOSE_ITEMS.find((i) => i.key === key)?.title ?? key;
}

/** 走势差值：正数带 + 号 */
function trendText(curr?: number, prev?: number, unit = ''): string {
  if (curr === undefined || prev === undefined) return '';
  const d = curr - prev;
  if (d === 0) return `持平${unit}`;
  return `${d > 0 ? '+' : ''}${Math.round(d)}${unit}`;
}

/** 绝对时间（HH:mm），超过一天则带日期 */
function absTimeLabel(at: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = Date.now() - at < 86400000 && new Date().getDate() === d.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 历史对比面板：默认「本次 vs 上次」，可点时间线里任意一条切换基准，
 * 变成「本次 vs 所选记录」，回答「比上周是不是变差了」。
 */
export default function DiagHistoryPanel({ history, onClear }: Props) {
  // 选中的对比基准在 history 里的下标（1 = 上次，默认；0 是本次自身，不可作基准）
  const [selIdx, setSelIdx] = useState(1);
  if (history.length === 0) return null;

  const latest = history[0];
  const idx = Math.min(selIdx, history.length - 1);
  const prev = idx >= 1 ? history[idx] : undefined;
  const diff: DiffEntry[] = prev ? diffSnapshots(latest, prev) : [];
  const badDiff = diff.filter((d) => d.to === 'fail' || d.to === 'warn');
  const improved = diff.filter((d) => d.to === 'pass' && d.from !== 'none' && d.from !== 'pass');
  const prevLabel = prev ? relTimeLabel(prev.at) : '';

  return (
    <View className="bg-card border border-border rounded-lg p-4 mt-1">
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="text-foreground text-sm font-bold">历史对比</Text>
        <View className="flex flex-row items-center px-2 py-1" onClick={onClear}>
          <View className="i-lucide-trash-2 w-3 h-3 text-muted-foreground mr-1" />
          <Text className="text-muted-foreground text-xs">清空</Text>
        </View>
      </View>

      {/* 关键指标走势（本次 vs 所选记录） */}
      <View className="flex flex-row mb-3">
        <View className="flex-1 bg-secondary rounded-lg p-3 mr-2">
          <Text className="text-muted-foreground text-xs block">平均延迟</Text>
          <Text className="text-foreground text-sm font-bold">
            {latest.avgMs !== undefined ? `${latest.avgMs}ms` : '--'}
          </Text>
          {prev && (
            <Text className="text-xs" style={{ color: (latest.avgMs ?? 0) > (prev.avgMs ?? 0) ? '#dc2626' : '#16a34a' }}>
              较{idx === 1 ? '上次' : '所选'} {trendText(latest.avgMs, prev.avgMs, 'ms')}
            </Text>
          )}
        </View>
        <View className="flex-1 bg-secondary rounded-lg p-3">
          <Text className="text-muted-foreground text-xs block">丢包率</Text>
          <Text className="text-foreground text-sm font-bold">
            {latest.lossPct !== undefined ? `${latest.lossPct}%` : '--'}
          </Text>
          {prev && (
            <Text className="text-xs" style={{ color: (latest.lossPct ?? 0) > (prev.lossPct ?? 0) ? '#dc2626' : '#16a34a' }}>
              较{idx === 1 ? '上次' : '所选'} {trendText(latest.lossPct, prev.lossPct, '%')}
            </Text>
          )}
        </View>
      </View>

      {/* 状态变化摘要：一句话点出「什么时候开始坏的」 */}
      {diff.length > 0 && (
        <View className="mb-3">
          <Text className="text-foreground text-xs font-bold mb-1 block">与{idx === 1 ? '上次' : '所选记录'}（{prevLabel}）相比的状态变化</Text>
          {badDiff.map((d) => (
            <View key={d.key} className="flex flex-row items-center mb-1">
              <View className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: statusColor(d.to) }} />
              <Text className="text-foreground text-xs flex-1 leading-relaxed">
                {titleOf(d.key)}：{STATUS_TEXT[d.from]} → {STATUS_TEXT[d.to]}
              </Text>
            </View>
          ))}
          {improved.map((d) => (
            <View key={d.key} className="flex flex-row items-center mb-1">
              <View className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: '#16a34a' }} />
              <Text className="text-foreground text-xs flex-1 leading-relaxed">
                {titleOf(d.key)}：{STATUS_TEXT[d.from]} → 已恢复
              </Text>
            </View>
          ))}
        </View>
      )}
      {diff.length === 0 && prev && (
        <Text className="text-muted-foreground text-xs block mb-3">各项状态与{idx === 1 ? '上次' : '所选记录'}一致，链路表现稳定</Text>
      )}

      {/* 最近记录时间线（最多展示 5 条；除本次外均可点击作为对比基准） */}
      <Text className="text-foreground text-xs font-bold mb-1 block">最近记录{history.length >= 2 ? '（点一条设为对比基准）' : ''}</Text>
      {history.slice(0, 5).map((h, hi) => {
        const fails = Object.values(h.items).filter((s) => s?.status === 'fail').length;
        const warns = Object.values(h.items).filter((s) => s?.status === 'warn').length;
        const isLatest = hi === 0;
        const isSel = !isLatest && hi === idx;
        return (
          <View
            key={h.at}
            className={`flex flex-row items-center mb-1 py-1 ${isSel ? 'bg-secondary rounded-md px-2' : ''}`}
            onClick={isLatest ? undefined : () => setSelIdx(hi)}
          >
            <Text className="text-muted-foreground text-xs mr-3" style={{ minWidth: '72px' }}>{relTimeLabel(h.at)}</Text>
            <Text className="text-foreground text-xs mr-3">{h.avgMs !== undefined ? `${h.avgMs}ms` : '--'}</Text>
            <Text className="text-xs" style={{ color: fails > 0 ? '#dc2626' : warns > 0 ? '#d97706' : '#16a34a' }}>
              {fails > 0 ? `${fails} 项失败` : warns > 0 ? `${warns} 项告警` : '全部正常'}
            </Text>
            {isLatest ? (
              <Text className="text-primary text-xs ml-2">本次</Text>
            ) : (
              <Text className={`text-xs ml-2 ${isSel ? 'text-primary' : 'text-muted-foreground'}`}>
                {isSel ? `基准 · ${absTimeLabel(h.at)}` : '对比它'}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
