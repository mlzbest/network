import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import {
  CHANGELOG,
  RELEASE_VERSION,
  buildChangelogList,
  formatVersionLabel,
  normalizeVersion,
  type ChangelogListItem,
} from '@/lib/app-release';
import { logDbg } from '@/lib/logger';

/**
 * 「我的」页关于卡片下方的可展开更新日志。
 *
 * 条目数据统一取自 `@/lib/app-release`（与「关于」行显示的版本号同源），不在本文件内维护副本。
 *
 * ⚠️ 缺陷⑮（用户报「更新日志有跳版本，比如 V73--V64-V63」）：
 *   旧实现直接渲染 CHANGELOG 数组，而 CHANGELOG 只记录「有内容可写」的版本，
 *   发布号序列天然有空档；页面又把「关于」行的真实发布号硬覆盖到顶部条目上，
 *   于是渲染成 73 → 64 → 63，看起来像漏了版本、也不是降幂连续。
 *   现在改为渲染 `buildChangelogList()` 的产物：**只显示有改动说明的版本**（用户明确要求，
 *   无说明文案的发布号不占列表），按发布号降幂排序，日期取发布记录里的真实发布日期。
 *
 * ⚠️ 缺陷⑯（用户要求「核对 66~73 的发布日期是否准确」→「把估算去掉，后继版本日期以代码提交日期为准」）：
 *   微信后台的发布号与发布日期**只存在于微信服务器**，应用内拿不到（`getAccountInfoSync()`
 *   只回发布号、不回日期），所以「V66~V72 各自哪天发布」在本地无法核实。用户已确认：
 *   **后继版本的日期一律以代码提交日期为准，界面上不做「估算」之类的额外标注**——
 *   列表里所有日期口径统一，不再区分「真实发布日」与「代码提交日」。
 */

/** 默认只展示最近若干条，其余折叠，避免长列表挤爆页面 */
const DEFAULT_VISIBLE = 2;

/** 展开状态记忆 key：下次进页保持用户上次的选择（按账号隔离，防换号串偏好） */
const EXPAND_CACHE_KEY = 'profile_changelog_expanded_v1';

function readExpandPref(): boolean {
  try {
    return Taro.getStorageSync(EXPAND_CACHE_KEY) === true;
  } catch (e) {
    console.warn('[changelog] 读取展开偏好失败，按默认收起:', e);
    return false;
  }
}

/**
 * 「当前版本」比对基准。优先用页面传入的值（正式版是微信回包的真实版本号，比构建常量更准），
 * 未传时回落到 `RELEASE_VERSION`（由 CHANGELOG 顶部条目派生）。
 */
function matchCurrent(currentVersion: string | undefined): string {
  return normalizeVersion(currentVersion) || normalizeVersion(RELEASE_VERSION);
}

export default function ChangelogList({
  currentVersion,
  entries,
  onToggle,
}: {
  currentVersion?: string;
  /**
   * 条目数据。默认由 `buildChangelogList()` 合并「发布记录 + 更新日志」得到
   * （每个真实发布号都在列表里、按发布号降幂排序）；页面可传入自己的副本。
   */
  entries?: ChangelogListItem[];
  onToggle?: () => void;
}) {
  const [expanded, setExpanded] = useState(readExpandPref);
  const data = entries && entries.length > 0 ? entries : buildChangelogList();
  const hiddenCount = Math.max(data.length - DEFAULT_VISIBLE, 0);
  const current = matchCurrent(currentVersion);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try {
      Taro.setStorageSync(EXPAND_CACHE_KEY, next);
    } catch (e) {
      console.warn('[changelog] 写入展开偏好失败（不影响使用）:', e);
    }
    logDbg(`[changelog] 🧾 ${next ? '展开' : '收起'}更新日志，共 ${data.length} 条`);
    // 视为用户操作：由页面重置 120 秒自动退场计时
    onToggle?.();
  };

  const list = expanded ? data : data.slice(0, DEFAULT_VISIBLE);

  return (
    <View className="w-full bg-card border border-border rounded-lg px-4 py-3 mt-4">
      <View className="flex flex-row items-center justify-between" onClick={toggle}>
        <View className="flex flex-row items-center flex-1 min-w-0">
          <View className="i-lucide-history w-4 h-4 text-muted-foreground shrink-0" />
          <Text className="text-xs text-muted-foreground ml-2 leading-none">更新日志</Text>
        </View>
        <View className="flex flex-row items-center shrink-0 ml-2">
          {!expanded && hiddenCount > 0 && (
            <Text className="text-xs text-muted-foreground mr-2 leading-none">还有 {hiddenCount} 条</Text>
          )}
          <View
            className={expanded ? 'i-lucide-chevron-up w-4 h-4 text-muted-foreground' : 'i-lucide-chevron-down w-4 h-4 text-muted-foreground'}
          />
        </View>
      </View>

      <View className="mt-3 space-y-3">
        {list.map((entry) => (
          <View key={entry.version} className="border-b border-border pb-3">
            <View className="flex flex-row items-center">
              <Text className="text-xs font-medium text-foreground leading-none">{formatVersionLabel(entry.version)}</Text>
              {current === normalizeVersion(entry.version) && (
                <View className="ml-2 px-2 py-1 rounded" style={{ backgroundColor: 'rgba(14, 165, 233, 0.10)' }}>
                  <Text className="text-primary text-xs leading-none">当前版本</Text>
                </View>
              )}
              <Text className="text-xs text-muted-foreground ml-2 leading-none">{entry.date}</Text>
            </View>
            {/* 列表只含有改动说明的版本，title/items 必然存在；仍做兜底防数据异常时渲染空白 */}
            {entry.title ? (
              <>
                <Text className="text-foreground text-xs mt-1 leading-relaxed">{entry.title}</Text>
                <View className="mt-1 space-y-1">
                  {(entry.items ?? []).map((it) => (
                    <View key={it} className="flex flex-row items-start">
                      <Text className="text-muted-foreground text-xs mr-1 leading-relaxed">·</Text>
                      <Text className="text-muted-foreground text-xs flex-1 leading-relaxed">{it}</Text>
                    </View>
                  ))}
                </View>
              </>
            ) : (
              /* 占位条目：由 withCurrentVersionPlaceholder 用「关于」行的真实发布号补在顶部。
                 它没有改动说明（微信不提供历史发布记录接口，文案无法自动获取），
                 必须给一句轻量说明，否则用户会以为这条是界面坏了、内容丢了。 */
              <Text className="block text-muted-foreground text-xs mt-1 leading-relaxed">
                本次发布未记录改动说明。
              </Text>
            )}
          </View>
        ))}
      </View>

      {expanded && (
        <Text className="text-xs text-muted-foreground mt-3 leading-relaxed">
          以上按发布号从新到旧排列，每次发布都会列出；「当前版本」标记对应上方「关于」显示的版本。
        </Text>
      )}
    </View>
  );
}
