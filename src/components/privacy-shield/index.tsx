import { View, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useEffect, useState, useRef, type ReactNode } from 'react';
import { armShield, disarmShield, isShieldArmed, getArmedRoute, setLastVisibleRoute, getLastVisibleRoute, isInMediaPickerGrace, isInNativePreviewGrace, consumeNativePreviewGrace } from '@/lib/shield-state';
import { logDbg } from '@/lib/logger';

  // 遮挡背景图（静心禅意主题）
const SHIELD_BG = 'https://conversation.cdn.meoo.host/conversations/350520193228980224/image/2026-09-24/1790220686099-22e9cc52e0546f2f7ebc63a2c7cfd679.jpg?auth_key=5e5bba0ddd58827b4e66049cbe07b59d3fdfe50b6833b52e2da9d149e5e36c43';

// 原生 TabBar 仅在 tabBar 页面上有效；hideTabBar/showTabBar 在非 tabBar 页
// （chat/ai-chat/ping 等）调用会以 Promise reject 报 "hideTabBar:fail fail not
// tabBar page"，try/catch 吞不住，必须显式 .catch()。与 app.config.ts tabBar.list 保持一致。
const TAB_BAR_ROUTES = ['pages/chats/index', 'pages/profile/index'];
const isTabBarRoute = (route: string) => TAB_BAR_ROUTES.some((r) => route.includes(r));

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
  // 遮罩存续期间是否已置空原生导航栏标题（cleanup 时据此恢复，避免闭包读旧值）
  const navBlankedRef = useRef(false);

  useDidShow(() => {
    const pages = Taro.getCurrentPages();
    const r = pages[pages.length - 1]?.route || '';
    logDbg('[PrivacyShield] didShow 刷新本页路由缓存:', r);
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
    // 切到后台：不立即亮罩，先做两层判定——
    // ① 豁免窗口：页面主动调起相册/相机等系统面板时，部分机型会触发一次或多次
    //    瞬时 onAppHide，落在 setMediaPickerGrace 窗口内的 hide 直接跳过；
    // ② 延时前台确认：hide 后 800ms 内若小程序已回到前台（onAppShow 取消待执行遮挡），
    //    说明只是系统面板造成的瞬时抖动而非真切后台，放弃遮挡。
    //    真实切后台/锁屏不可能 800ms 内回前台，隐私语义完整保留。
    // 归属判定仍以全局「最后可见页路由」为准——只有当时正被用户查看的
    // 那个页面实例命中 ownRoute 才亮罩，其余存活页面实例不受影响。
    let pendingTimer: any = null;

    const doArm = () => {
      pendingTimer = null;
      const pages = Taro.getCurrentPages();
      const stackTop = pages[pages.length - 1]?.route || '';
      const route = stackTop || getLastVisibleRoute() || ownRoute;
      armShield(route);
      logDbg('[PrivacyShield] onAppHide 确认为真实切后台，遮挡页面:', route, '本页:', ownRoute);
      if (route && route === ownRoute) {
        setShielded(true);
      }
    };

    const onHide = () => {
      // 原生全屏预览（previewImage）拉起的 hide：用户在系统查看器里可停留任意时长，
      // 无法用时效窗口覆盖，改由计数豁免；额度在 onAppShow 消费归零。
      if (isInNativePreviewGrace()) {
        logDbg('[PrivacyShield] onAppHide 命中原生预览豁免(查看照片中), 本次不遮挡');
        return;
      }
      if (isInMediaPickerGrace()) {
        logDbg('[PrivacyShield] onAppHide 命中系统面板豁免窗口, 本次不遮挡');
        return;
      }
      if (pendingTimer) clearTimeout(pendingTimer);
      logDbg('[PrivacyShield] onAppHide 触发, 延时 800ms 确认是否真实切后台, 本页:', ownRoute);
      pendingTimer = setTimeout(doArm, 800);
    };
    // 回到前台：若有待执行的遮挡（说明刚才只是瞬时 hide）则取消；
    // 已亮起的遮挡保持，等待用户连点 3 次解除（不自动关闭）
    const onShow = () => {
      // 从原生图片预览返回：消费预览豁免额度，本次回前台不做任何遮挡处理
      if (consumeNativePreviewGrace()) {
        logDbg('[PrivacyShield] onAppShow 自原生预览返回, 已消费预览豁免, 不遮挡');
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        return;
      }
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
        logDbg('[PrivacyShield] onAppShow 于确认窗口内到达, 判定为瞬时 hide(系统面板), 取消遮挡');
      }
      if (!isShieldArmed()) return;
      logDbg('[PrivacyShield] onAppShow 触发，维持遮挡待用户确认, 本页:', ownRoute);
    };

    Taro.onAppHide(onHide);
    Taro.onAppShow(onShow);

    return () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      Taro.offAppHide(onHide);
      Taro.offAppShow(onShow);
      // 本实例卸载时若仍持有未解除的遮挡（页面被 reLaunch/navigateBack 销毁），
      // 把遮挡归属交给此刻的栈顶可见页，由其 didShow 重新亮罩，防止状态悬挂导致
      // 「解除后仍被弹回」或「遮罩永久丢失」。
      if (isShieldArmed() && getArmedRoute() === ownRoute) {
        const pages = Taro.getCurrentPages();
        const next = pages[pages.length - 1]?.route || '';
        logDbg('[PrivacyShield] 遮挡页卸载，归属移交当前栈顶:', next);
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
      logDbg('[PrivacyShield] 连续点击3次锁，解除遮挡:', ownRoute);
      disarmShield();
      setShielded(false);
    } else {
      Taro.vibrateShort({ type: 'light' }).catch(() => {});
      logDbg(`[PrivacyShield] 点击锁 ${next}/3，继续连点以解除`);
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
    // hideTabBar 只在 tabBar 页有效；chat/ai-chat/ping 等非 tabBar 页调用会
    // 以 Promise reject（"hideTabBar:fail fail not tabBar page"），try/catch
    // 吞不住异步失败，必须先看路由再调、且补 .catch() 双保险。
    if (isTabBarRoute(ownRoute)) {
      Taro.hideTabBar().catch((e: any) => {
        logDbg('[PrivacyShield] hideTabBar 失败', e);
      });
    } else {
      logDbg('[PrivacyShield] 本页非 tabBar 页, 跳过 hideTabBar:', ownRoute);
    }
    const wxApi = (Taro as any).wx || ((globalThis as any).wx || null);
    try {
      // 0 = 禁止侧滑返回
      wxApi?.setSwipeBackMode?.({ mode: 0 });
    } catch (e) {
      logDbg('[PrivacyShield] setSwipeBackMode 不可用', e);
    }
    try {
      wxApi?.hideHomeButton?.();
    } catch (e) {
      logDbg('[PrivacyShield] hideHomeButton 不可用', e);
    }
    // 原生导航栏无法被 fixed 遮罩覆盖：把标题置空，让 chats/profile 这类
    // 默认导航栏页面的遮罩视觉上接近全屏。custom 导航栏页无原生标题可挡。
    // 注意：H5 预览态 setNavigationBarTitle 走降级 stub，对空格/空串标题会
    // 误报 "parameter.title should be String"（真机正常），故仅在微信端执行。
    const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
    if (isWeapp) {
      try {
        Taro.setNavigationBarTitle({ title: ' ' });
        navBlankedRef.current = true;
        logDbg('[PrivacyShield] 遮罩期已置空原生导航栏标题, 本页:', ownRoute);
      } catch (e) {
        logDbg('[PrivacyShield] 置空导航栏标题失败', e);
      }
    }
    return () => {
      if (navBlankedRef.current) {
        navBlankedRef.current = false;
        // 恢复为本页 app.config 声明的标题；注意 H5 路由是 hash 形态，
        // route 不含 'pages/xxx' 前缀路径段，必须用 includes 子串匹配（勿 split('/')）
        const restoreTitle = (() => {
          try {
            const pages = Taro.getCurrentPages();
            const route = pages[pages.length - 1]?.route || ownRoute || '';
            if (route.includes('ai-chat')) return 'AI 助手';
            if (route.includes('ping')) return '网络查看';
            return '';
          } catch {
            return '';
          }
        })();
        try {
          Taro.setNavigationBarTitle({ title: restoreTitle });
          logDbg('[PrivacyShield] 遮罩解除，已恢复导航栏标题:', restoreTitle || '(空串)');
        } catch (e) {
          logDbg('[PrivacyShield] 恢复导航栏标题失败', e);
        }
      }
      try {
        // 1 = 恢复允许侧滑返回
        wxApi?.setSwipeBackMode?.({ mode: 1 });
      } catch (e) {
        logDbg('[PrivacyShield] 恢复右滑手势失败', e);
      }
      // showTabBar 同样只在 tabBar 页有效，非 tabBar 页调用会 Promise reject；
      // 遮罩解除时用户可能已切到任意页，按当前栈顶路由判定后再调。
      try {
        const pages = Taro.getCurrentPages();
        const route = pages[pages.length - 1]?.route || '';
        if (isTabBarRoute(route)) {
          Taro.showTabBar().catch((e: any) => {
            logDbg('[PrivacyShield] showTabBar 失败', e);
          });
        } else {
          logDbg('[PrivacyShield] 当前页非 tabBar 页, 跳过 showTabBar:', route);
        }
      } catch (e) {
        logDbg('[PrivacyShield] showTabBar 异常', e);
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
            src={SHIELD_BG}
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
            <View className="i-lucide-lock w-16 h-16" style={{ color: '#ffffff' }} />
          </View>
        </View>
      )}
    </View>
  );
}
