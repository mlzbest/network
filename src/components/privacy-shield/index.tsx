import { View, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useEffect, useState, useRef, type ReactNode } from 'react';
import { armShield, disarmShield, isShieldArmed, getArmedRoute, setLastVisibleRoute, getLastVisibleRoute } from '@/lib/shield-state';
import bgLotus from '@/assets/backgrounds/bg-lotus.jpg';

// 遮挡背景图（静心禅意主题）

/**
 * 隐私遮罩壳(PrivacyShield)
 *
 * 用途：在聊天列表、聊天详情、我的等含敏感信息的页面上包一层壳。
 * 当小程序切换到后台(Taro.onAppHide)时，仅给「切后台那一刻处于前台」的页面
 * 标记为需遮挡；回到前台后该页面保持不透明遮罩，必须用户主动点击才解除。
 * 其他页面（如从被遮挡页返回/跳转过去的页面）不会被遮挡。
 *
 * 实现要点：
 * - onAppHide/onAppShow 是 App 级事件，仅在小程序整体切前后台时触发，页面间跳转不会触发；
 * - 每个接入页面各挂一个 PrivacyShield 实例，onAppHide 会同时广播到所有存活实例，
 *   因此用模块级 lastVisibleRoute（由各实例在 useDidShow 时上报）判定遮挡归属，
 *   只有当时正被用户查看的那个页面实例亮遮罩；
 * - 路由一律使用 getCurrentPages() 栈顶的原始 route（不带前导斜杠），避免归一化不一致；
 * - 组件卸载时若本实例正处于遮挡状态，把遮挡归属交给当前栈顶可见页，防止状态悬挂；
 * - 解锁方式：遮罩期间只有连续点击中央锁图标 3 次（每次间隔 <1.2 秒）才解除，
 *   点其他任何位置均无反应，进一步降低误触泄露概率。
 */

export default function PrivacyShield({ children }: { children: ReactNode }) {
  // 本实例最近一次「页面显示」时的路由（onAppHide 时以此判定遮挡归属）
  const [ownRoute, setOwnRoute] = useState('');
  // 本实例是否处于遮挡状态
  const [shielded, setShielded] = useState(false);

  useDidShow(() => {
    const pages = Taro.getCurrentPages();
    const r = pages[pages.length - 1]?.route || '';
    console.log('[PrivacyShield] didShow 刷新本页路由缓存:', r);
    if (r) {
      setLastVisibleRoute(r);
      setOwnRoute(r);
      // 遮挡未解除且归属就是本页（如遮挡期间页面被销毁重建）→ 恢复遮罩
      if (isShieldArmed() && getArmedRoute() === r) {
        setShielded(true);
      }
    }
  });

  useEffect(() => {
    // 切到后台：以全局「最后可见页路由」判定归属——只有当时正被用户查看的
    // 那个页面实例命中 ownRoute 才亮罩，其余存活页面实例不受影响。
    const onHide = () => {
      const pages = Taro.getCurrentPages();
      const stackTop = pages[pages.length - 1]?.route || '';
      const route = stackTop || getLastVisibleRoute() || ownRoute;
      armShield(route);
      console.log('[PrivacyShield] onAppHide 触发，遮挡页面:', route, '本页:', ownRoute);
      if (route && route === ownRoute) {
        setShielded(true);
      }
    };
    // 回到前台：保持遮挡，等待用户点击解除（不自动关闭）
    const onShow = () => {
      if (!isShieldArmed()) return;
      console.log('[PrivacyShield] onAppShow 触发，维持遮挡待用户确认, 本页:', ownRoute);
    };

    Taro.onAppHide(onHide);
    Taro.onAppShow(onShow);

    return () => {
      Taro.offAppHide(onHide);
      Taro.offAppShow(onShow);
      // 本实例卸载时若仍持有未解除的遮挡（页面被 reLaunch/navigateBack 销毁），
      // 把遮挡归属交给此刻的栈顶可见页，由其 didShow 重新亮罩，防止状态悬挂导致
      // 「解除后仍被弹回」或「遮罩永久丢失」。
      if (isShieldArmed() && getArmedRoute() === ownRoute) {
        const pages = Taro.getCurrentPages();
        const next = pages[pages.length - 1]?.route || '';
        console.log('[PrivacyShield] 遮挡页卸载，归属移交当前栈顶:', next);
        if (next) armShield(next);
      }
    };
  }, [ownRoute]);

  // 连续点击解锁计数：需连点 3 次锁才解除遮挡
  const [tapCount, setTapCount] = useState(0);
  const tapTimerRef = useRef<any>(null);

  // 遮罩收起/组件卸载时复位计数，避免下次亮罩残留进度
  useEffect(() => {
    if (!shielded) {
      setTapCount(0);
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
    }
    return () => {
      if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    };
  }, [shielded]);

  const handleLockTap = () => {
    // 1.2 秒内视为「连续」，超时重新计数
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => {
      tapTimerRef.current = null;
      setTapCount(0);
    }, 1200);
    const next = tapCount + 1;
    if (next >= 3) {
      if (tapTimerRef.current) {
        clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      setTapCount(0);
      console.log('[PrivacyShield] 连续点击3次锁，解除遮挡:', ownRoute);
      disarmShield();
      setShielded(false);
    } else {
      Taro.vibrateShort({ type: 'light' }).catch(() => {});
      console.log(`[PrivacyShield] 点击锁 ${next}/3，继续连点以解除`);
      setTapCount(next);
    }
  };

  // 遮罩存续期间的导航封锁：
  // 1) 隐藏原生 TabBar（会话/我的），避免底部栏泄露所在页面；
  // 2) 禁用 iOS 侧滑返回手势（wx.setSwipeBackMode，低版本自动忽略）；
  // 3) 隐藏返回首页按钮（wx.hideHomeButton）。
  // 注意：fixed 遮罩盖不住原生导航栏的返回键，返回键绕过由「禁手势 + 各页
  // useDidShow 兜底拦截（检测到遮挡未解除即 reLaunch 回被遮挡页）」双重封堵。
  useEffect(() => {
    if (!shielded) return;
    try {
      Taro.hideTabBar();
    } catch (e) {
      console.log('[PrivacyShield] hideTabBar 失败(可能非 tabBar 页面)', e);
    }
    const wxApi = (Taro as any).wx || ((globalThis as any).wx || null);
    try {
      // 0 = 禁止侧滑返回
      wxApi?.setSwipeBackMode?.({ mode: 0 });
    } catch (e) {
      console.log('[PrivacyShield] setSwipeBackMode 不可用', e);
    }
    try {
      wxApi?.hideHomeButton?.();
    } catch (e) {
      console.log('[PrivacyShield] hideHomeButton 不可用', e);
    }
    return () => {
      try {
        // 1 = 恢复允许侧滑返回
        wxApi?.setSwipeBackMode?.({ mode: 1 });
      } catch (e) {
        console.log('[PrivacyShield] 恢复右滑手势失败', e);
      }
      try {
        const pages = Taro.getCurrentPages();
        const route = pages[pages.length - 1]?.route || '';
        if (route.includes('pages/chats/index') || route.includes('pages/profile/index')) {
          Taro.showTabBar();
        }
      } catch (e) {
        console.log('[PrivacyShield] showTabBar 失败', e);
      }
    };
  }, [shielded]);

  return (
    <View className="relative">
      {children}

      {/* 不透明遮罩壳：覆盖整个视口，以静荷图为背景，隐藏真实内容。
          全屏层只负责拦截点击(防止点穿到下层页面)，解除只能点中间的锁图标 */}
      {shielded && (
        <View
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 9999,
          }}
          className="flex flex-col items-center justify-end pb-24"
        >
          {/* 背景图铺满全屏 */}
          <Image
            src={bgLotus}
            mode="aspectFill"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
            }}
          />
          {/* 解锁热区：连续点击3次锁才解除；点其他位置无反应 */}
          <View
            className="relative flex items-center justify-center"
            style={{ zIndex: 1 }}
            onClick={handleLockTap}
          >
            <View className="i-lucide-lock w-16 h-16" style={{ color: '#3f3f46' }} />
          </View>
        </View>
      )}
    </View>
  );
}
