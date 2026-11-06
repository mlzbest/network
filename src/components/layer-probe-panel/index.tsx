import { View, Text } from '@tarojs/components';
import DiagnoseCard from '@/components/diagnose-card';
import { DIAGNOSE_ITEMS } from '@/api/net-diagnose';
import type { DiagnoseResult, ServerItemKey } from '@/api/net-diagnose';

interface Props {
  /** 本次单步测试的指令（决定渲染哪张检测项卡片） */
  commandKey: ServerItemKey;
  /** 归一化后的目标 host[:port] */
  target: string;
  /** 该指令的结果（未返回时 undefined） */
  result?: DiagnoseResult;
  /** 是否仍在执行中 */
  pending: boolean;
  /** 重试（强制绕过 60s 缓存） */
  onRetry: () => void;
}

/**
 * 单条指令结果面板：只渲染**一条指令**对应的检测项卡片。
 *
 * 【为什么不复用 full-diag-panel】全量面板自带「自动跑全部 11 项 + 结论卡 + 历史留存」，
 * 复用会把 11 项全跑一遍，既慢又违背「单步」的初衷。两者共用 DiagnoseCard 渲染单项，
 * 差异只在编排层。
 */
export default function LayerProbePanel({ commandKey, target, result, pending, onRetry }: Props) {
  const meta = DIAGNOSE_ITEMS.find((i) => i.key === commandKey);
  if (!meta) return null;

  return (
    <View className="mt-3">
      <View className="flex flex-row items-center justify-between mb-2">
        <Text className="text-foreground text-sm font-bold">{meta.title}</Text>
        <Text className="text-muted-foreground text-xs">{pending ? '执行中…' : '已完成'}</Text>
      </View>
      <Text className="text-muted-foreground text-xs block mb-3 leading-relaxed" style={{ wordBreak: 'break-all' }}>
        目标 {target}
      </Text>
      <DiagnoseCard meta={meta} result={result} loading={pending} onRetry={onRetry} />
    </View>
  );
}
