import { View, Text } from '@tarojs/components';
import { useState } from 'react';
import type { DiagnoseResult, ItemMeta, ItemStatus } from '@/api/net-diagnose';

interface Props {
  meta: ItemMeta;
  result?: DiagnoseResult;
  loading: boolean;
  onRetry: () => void;
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  pass: '通过',
  warn: '警告',
  fail: '失败',
  na: '不适用',
  pending: '检测中',
  unsupported: '不支持',
};

/** 状态徽标配色（小程序下半透明背景需 inline rgba，不能用 bg-token/透明度类） */
function badgeStyle(status: ItemStatus): { backgroundColor: string; color: string } {
  switch (status) {
    case 'pass':
      return { backgroundColor: 'rgba(22, 163, 74, 0.12)', color: '#16a34a' };
    case 'warn':
      return { backgroundColor: 'rgba(217, 119, 6, 0.12)', color: '#d97706' };
    case 'fail':
      return { backgroundColor: 'rgba(220, 38, 38, 0.12)', color: '#dc2626' };
    case 'unsupported':
      return { backgroundColor: 'rgba(100, 116, 139, 0.12)', color: '#64748b' };
    default:
      return { backgroundColor: 'rgba(14, 165, 233, 0.12)', color: '#0ea5e9' };
  }
}

/** 明细行：把 detail 对象拍平成 key/value 文本对（数组/对象转 JSON 预览） */
function flattenDetail(detail: Record<string, unknown>): Array<{ k: string; v: string }> {
  const rows: Array<{ k: string; v: string }> = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null) continue;
    let text: string;
    if (Array.isArray(v)) {
      text = v.length === 0 ? '(空)' : v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('、');
    } else if (typeof v === 'object') {
      text = JSON.stringify(v);
    } else {
      text = String(v);
    }
    if (text.length > 300) text = `${text.slice(0, 300)}…`;
    rows.push({ k, v: text });
  }
  return rows;
}

export default function DiagnoseCard({ meta, result, loading, onRetry }: Props) {
  const [expanded, setExpanded] = useState(false);

  const status: ItemStatus = loading ? 'pending' : result?.status ?? 'pending';
  const badge = badgeStyle(status);
  const summary = loading ? '正在执行检测…' : result?.summary ?? '等待诊断';
  const rows = result && expanded ? flattenDetail(result.detail) : [];

  return (
    <View className="bg-card border border-border rounded-lg mb-3 overflow-hidden">
      {/* 标题行 */}
      <View className="flex flex-row items-center px-4 py-3">
        <View className="flex flex-col flex-1">
          <View className="flex flex-row items-center">
            <Text className="text-foreground text-sm font-medium">{meta.title}</Text>
            <View className="ml-2 px-2 py-1 rounded" style={{ backgroundColor: badge.backgroundColor }}>
              <Text className="text-xs font-medium" style={{ color: badge.color }}>
                {STATUS_LABEL[status]}
              </Text>
            </View>
          </View>
          <Text className="text-muted-foreground text-xs mt-1">{meta.command}</Text>
        </View>
        <View className="flex flex-row items-center">
          {!loading && result && (
            <View
              className="px-3 py-2 rounded-md mr-2"
              style={{ backgroundColor: 'rgba(14, 165, 233, 0.08)' }}
              onClick={(e) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              <Text className="text-primary text-xs">重试</Text>
            </View>
          )}
          {result && Object.keys(result.detail).length > 0 && (
            <Text className="text-muted-foreground text-xs" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起 ▲' : '明细 ▼'}
            </Text>
          )}
        </View>
      </View>

      {/* 结论行 */}
      <View className="px-4 pb-3">
        <Text className={`text-xs ${status === 'fail' ? 'text-destructive' : status === 'warn' ? 'text-amber-600' : 'text-muted-foreground'}`}>
          {summary}
        </Text>
        {result && !loading && result.durationMs > 0 && (
          <Text className="text-muted-foreground text-xs ml-2">{result.durationMs}ms</Text>
        )}
      </View>

      {/* 明细展开区 */}
      {rows.length > 0 && (
        <View className="px-4 pb-3 space-y-1">
          {rows.map((row) => (
            <View key={row.k} className="flex flex-row justify-between">
              <Text className="text-muted-foreground text-xs mr-2">{row.k}</Text>
              <Text className="text-foreground text-xs flex-1 text-right" style={{ wordBreak: 'break-all' }}>
                {row.v}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
