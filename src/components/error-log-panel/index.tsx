import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { clearErrorLog, formatErrorEntry, readErrorLog, type ErrorLogEntry } from '@/lib/error-log';
import { logDbg } from '@/lib/logger';

/**
 * 「我的」页的错误记录面板：列出本机记录过的页面崩溃与未捕获异常。
 *
 * 为什么放在「我的」页而不是自动弹窗：崩溃提示由 ErrorBoundary 就地展示，
 * 这里只做「事后可查」——用户反馈白屏时，可以让他来这里复制详情发给我们。
 *
 * 数据源唯一：`@/lib/error-log`（与 ErrorBoundary、app.tsx 的 App 级钩子同源），
 * 本文件不维护任何副本。
 */

/** 默认只展示最近若干条，其余折叠，避免长列表挤爆页面 */
const DEFAULT_VISIBLE = 3;

function formatTime(at: number): string {
  try {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '-';
  }
}

/** 路由转成用户看得懂的页面名 */
function routeLabel(route: string): string {
  if (!route) return '未知页面';
  if (route.includes('chat/index')) return '详情页';
  if (route.includes('chats/index')) return '列表页';
  if (route.includes('profile')) return '我的';
  if (route.includes('ping')) return '网络诊断';
  if (route.includes('ai-chat')) return 'AI 助手';
  if (route.includes('batch-diag')) return '批量诊断';
  if (route.includes('login')) return '登录';
  if (route.includes('canvas-host')) return '图片处理';
  return route;
}

export default function ErrorLogPanel({ onToggle }: { onToggle?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  // 每次展开时现读，保证看到的是最新记录（崩溃可能刚发生）
  const [entries, setEntries] = useState<ErrorLogEntry[]>(() => readErrorLog());

  const toggle = () => {
    const next = !expanded;
    if (next) setEntries(readErrorLog());
    setExpanded(next);
    logDbg(`[error-log-panel] ${next ? '展开' : '收起'}错误记录，共 ${entries.length} 条`);
    onToggle?.();
  };

  const handleCopy = (entry: ErrorLogEntry) => {
    Taro.setClipboardData({ data: formatErrorEntry(entry) })
      .then(() => Taro.showToast({ title: '已复制', icon: 'none' }))
      .catch((e: unknown) => {
        // 真机常见 errno 112 = 隐私指引未声明「读取剪贴板」；此时不弹 toast，
        // 由下方 <Text selectable> 让用户长按手动复制。
        logDbg('[error-log-panel] 复制失败（可长按文本手动复制）:', e);
      });
  };

  const handleClear = async () => {
    const res = await Taro.showModal({
      title: '清空错误记录',
      content: '清空后无法恢复，确定继续吗？',
      confirmText: '清空',
      confirmColor: '#dc2626',
    });
    if (!res.confirm) return;
    clearErrorLog();
    setEntries([]);
    logDbg('[error-log-panel] 🧹 用户已清空错误记录');
    onToggle?.();
  };

  const list = expanded ? entries : entries.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = Math.max(entries.length - DEFAULT_VISIBLE, 0);

  return (
    <View className="w-full bg-card border border-border rounded-lg px-4 py-3 mt-4">
      <View className="flex flex-row items-center justify-between" onClick={toggle}>
        <View className="flex flex-row items-center flex-1 min-w-0">
          <View className="i-lucide-bug w-4 h-4 text-muted-foreground shrink-0" />
          <Text className="text-xs text-muted-foreground ml-2 leading-none">
            错误记录{entries.length > 0 ? ` · ${entries.length} 条` : ' · 无'}
          </Text>
        </View>
        <View className="flex flex-row items-center shrink-0 ml-2">
          {!expanded && hiddenCount > 0 && (
            <Text className="text-xs text-muted-foreground mr-2 leading-none">还有 {hiddenCount} 条</Text>
          )}
          <View
            className={
              expanded
                ? 'i-lucide-chevron-up w-4 h-4 text-muted-foreground'
                : 'i-lucide-chevron-down w-4 h-4 text-muted-foreground'
            }
          />
        </View>
      </View>

      {expanded && entries.length === 0 && (
        <Text className="block text-xs text-muted-foreground mt-3 leading-relaxed">
          暂无错误记录。页面出现异常时会自动记录在这里，方便排查。
        </Text>
      )}

      {entries.length > 0 && (
        <View className="mt-3 space-y-3">
          {list.map((entry) => (
            <View key={`${entry.at}-${entry.message}`} className="border-b border-border pb-3">
              <View className="flex flex-row items-center">
                <Text className="text-xs font-medium text-foreground leading-none">{routeLabel(entry.route)}</Text>
                <Text className="text-xs text-muted-foreground ml-2 leading-none">{formatTime(entry.at)}</Text>
              </View>
              <Text selectable className="block text-xs text-muted-foreground mt-1 leading-relaxed">
                {entry.message}
              </Text>
              <View onClick={() => handleCopy(entry)} className="active:opacity-60 mt-2 self-start">
                <Text className="text-primary text-xs leading-none">复制详情</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {expanded && entries.length > 0 && (
        <View onClick={handleClear} className="active:opacity-60 mt-3 flex flex-row items-center justify-center">
          <Text className="text-destructive text-xs leading-none">清空记录</Text>
        </View>
      )}
    </View>
  );
}
