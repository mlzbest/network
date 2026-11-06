import { View, Text, ScrollView } from '@tarojs/components';
import type { LoginWindow, PeerLoginStats } from '@/api/profiles';
import { formatLoginDetailTime, formatLoginRange } from '@/lib/login-time';
import { logDbg } from '@/lib/logger';

interface Props {
  /** 对方昵称，用于标题「TA」的具体化 */
  peerName: string;
  stats: PeerLoginStats | null;
  /** 统计窗口：上次离开聊天页 → 本次进入聊天页；任一端为空表示该侧不设边界 */
  window: LoginWindow;
  onClose: () => void;
}

/**
 * 「登录明细」弹层：逐条列出对方在我离开聊天区窗口内的历次登录时间点。
 * 外壳照抄 forgot-password-sheet 的纯 View 遮罩模式（小程序端 Modal 样式不可控）：
 * fixed inset-0 + z-50 + inline rgba 遮罩（bg-black/50 这类透明度简写被 eslint 禁用），
 * 点遮罩关闭、面板内 stopPropagation 防误关。
 */
export default function LoginDetailSheet({ peerName, stats, window: win, onClose }: Props) {
  const items = stats?.loggedAts ?? [];
  // ⚠️ 缺陷⑭：序号口径必须与顶栏「TA 登录 N 次」严格一致。
  //   旧实现写 `第 ${items.length - i} 次`，但 items 是**倒序**（首条最新）——
  //   于是最新那条显示「第 N 次」、最旧那条显示「第 1 次」，看起来像「按时间正序编号」，
  //   而用户读列表是从上往下（最新→最旧），序号却是从大到小，与直觉相反、也与
  //   「最近」标签的语义打架。改为**按时间正序编号**：最旧=第 1 次、最新=第 N 次，
  //   与「TA 登录 N 次」的累计语义一致（第 N 次就是最近这次）。
  const total = items.length;
  // 关键证据日志：明细条数必须与顶栏「TA 登录 N 次」的 count 一致（同源 stats）。
  // 排查「登录次数/明细不对」时，把这一行与 chat 页的「📊 登录统计窗口」日志对照即可定位。
  logDbg(
    `[login-detail-sheet] 🗂 打开明细: 共 ${total} 条, 区间=${formatLoginRange(win.fromAt, win.toAt)}, 最新=${items[0] ? formatLoginDetailTime(items[0]) : '-'}`,
  );
  return (
    <View
      className="fixed inset-0 z-50 flex items-center justify-center px-8"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
        <Text className="text-lg font-bold text-foreground">{peerName} 的登录记录</Text>
        <Text className="text-xs text-muted-foreground mt-1 leading-6">
          {`统计区间：${formatLoginRange(win.fromAt, win.toAt)}`}
        </Text>
        {total > 0 && (
          <Text className="text-xs text-muted-foreground mt-1 leading-6">
            {`共 ${total} 次（按时间从新到旧排列）`}
          </Text>
        )}

        {items.length === 0 ? (
          <View className="mt-6 mb-2 flex items-center justify-center">
            <Text className="text-sm text-muted-foreground">这段时间 TA 没有登录过</Text>
          </View>
        ) : (
          <ScrollView scrollY className="mt-4 max-h-72">
            {items.map((iso, i) => (
              <View
                key={`${iso}-${i}`}
                className={`flex items-center gap-3 py-3 ${i === 0 ? '' : 'border-t border-border'}`}
              >
                <View
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: i === 0 ? '#22c55e' : '#9ca3af' }}
                />
                <Text className="text-sm text-foreground flex-1">{formatLoginDetailTime(iso)}</Text>
                {i === 0 && (
                  <View className="px-2 py-1 rounded bg-secondary">
                    <Text className="text-xs text-muted-foreground leading-none">最近</Text>
                  </View>
                )}
                <Text className="text-xs text-muted-foreground w-12 text-right leading-none">
                  {`第 ${total - i} 次`}
                </Text>
              </View>
            ))}
          </ScrollView>
        )}

        <View
          className="mt-5 bg-secondary rounded-lg py-3 flex items-center justify-center"
          onClick={onClose}
        >
          <Text className="text-muted-foreground leading-none">关闭</Text>
        </View>
      </View>
    </View>
  );
}
