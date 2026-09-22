import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useAuthStore } from '@/store/auth-store';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { useRef, useEffect, useState } from 'react';
import { setPageSwitching, getPageSwitching, resetPageSwitching, setCurrentPage, getCurrentPage } from '@/lib/inactivity-timer';
import PrivacyShield from '@/components/privacy-shield';
import { isShieldArmed, getArmedRoute } from '@/lib/shield-state';

function getDisplayName(user: { user_metadata?: { nickname?: string; username?: string } } | null): string {
  const meta = user?.user_metadata ?? {};
  return meta.nickname || meta.username || '微信用户';
}

function getInitial(name: string): string {
  return name.charAt(0) || '?';
}

export default function ProfilePage() {
  const { user, loaded, signOut } = useAuthStore();
  const inactivityTimerRef = useRef<any>(null);
  const timerStartTimeRef = useRef<number>(0); // 记录计时器启动时间戳
  const timerIdCounter = useRef<number>(0); // 计时器ID计数器,用于验证setTimeout是否是当前有效的
  const [timerStatus, setTimerStatus] = useState('未启动'); // 调试用:显示计时器状态

  // 120秒无操作自动返回网络页面
  const resetInactivityTimer = () => {
    const now = Date.now();

    // 清除旧的计时器(如果存在)
    if (inactivityTimerRef.current) {
      clearInterval(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }

    timerStartTimeRef.current = now;
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[profile] 🔥 [${timeStr}] 启动120秒计时器(setInterval模式), timerStartTimeRef=${now}`);

    // 使用setInterval每1秒检查一次
    inactivityTimerRef.current = setInterval(() => {
      const checkTime = Date.now();
      const elapsed = checkTime - timerStartTimeRef.current;

      // 检查当前页面是否仍是活跃页面
      const currentPage = getCurrentPage();
      if (currentPage !== 'profile') {
        console.log(`[profile] ⚠️ 当前活跃页面是${currentPage},不是profile,清除计时器`);
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        return;
      }

      // 检查是否超时
      if (elapsed >= 120000) {
        const timeoutTime = new Date().toLocaleTimeString();
        console.log(`[profile] ⏰ [${timeoutTime}] 确认超时(${Math.floor(elapsed / 1000)}秒),执行跳转`);
        // 先清除计时器并重置时间戳,防止重复跳转
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        timerStartTimeRef.current = 0; // 重置时间戳,防止下次tick再次触发
        Taro.reLaunch({ url: '/pages/ping/index' });
      }
    }, 1000); // 每1秒检查一次
  };

  // 检查是否已超时,如果超时就跳转
  const checkTimeout = () => {
    if (!timerStartTimeRef.current) return;
    const elapsed = Date.now() - timerStartTimeRef.current;
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[profile] 🔍 [${timeStr}] 检查超时: 已过去 ${Math.floor(elapsed / 1000)}秒`);
    if (elapsed >= 120000) {
      console.log(`[profile] ⚠️ [${timeStr}] 检测到已超时(${Math.floor(elapsed / 1000)}秒),立即跳转`);
      Taro.reLaunch({ url: '/pages/ping/index' });
    } else {
      const remaining = Math.ceil((120000 - elapsed) / 1000);
      console.log(`[profile] ℹ️ [${timeStr}] 未超时,剩余 ${remaining}秒`);
    }
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    // 兜底拦截：遮挡未解除期间落到本页，立即弹回被遮挡页
    if (isShieldArmed() && getArmedRoute() !== 'pages/profile/index') {
      console.log('[profile] 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
      Taro.reLaunch({ url: '/' + getArmedRoute() });
      return;
    }
    const timeStr = new Date().toLocaleTimeString();
    const currentPage = getCurrentPage();
    const isPageSwitch = currentPage !== '' && currentPage !== 'profile'; // 如果当前活跃页面不是自己,说明是页面切换

    // 先强制清除任何可能存在的旧计时器
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      console.log(`[profile] 🛑 [${timeStr}] 强制清除旧计时器`);
    }

    setCurrentPage('profile'); // 记录当前活跃页面

    console.log(`[profile] 📱 [${timeStr}] useDidShow 触发, currentPage=${currentPage}, isPageSwitch=${isPageSwitch}`);
    setTimerStatus('已启动');

    if (isPageSwitch) {
      // 页面切换:重置计时器
      console.log(`[profile] 🔄 [${timeStr}] 检测到页面切换(从${currentPage}切换过来),重置计时器`);
      resetInactivityTimer();
    } else if (timerStartTimeRef.current) {
      // 从后台切回:检查是否超时
      console.log(`[profile] 🔙 [${timeStr}] 从后台切回,检查是否超时`);
      checkTimeout();
    } else {
      // 首次进入页面,启动计时器
      console.log(`[profile] 🆕 [${timeStr}] 首次进入页面,启动计时器`);
      resetInactivityTimer();
    }

    if (loaded && !user) {
      redirectToLogin();
      return;
    }
  });

  // 页面隐藏时:清除计时器,标记为页面切换
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[profile] 👻 [${timeStr}] useDidHide 触发,清除计时器并标记为页面切换`);
    setTimerStatus('页面隐藏');

    // 清除计时器
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      console.log(`[profile] 🛑 [${timeStr}] 已清除旧计时器`);
    }

    setPageSwitching(true); // 标记为页面切换
    console.log(`[profile] 🏷️ [${timeStr}] 已调用setPageSwitching(true)`);
  });

  if (!loaded) {
    return (
      <View className="min-h-screen bg-background flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    );
  }

  if (!user) return null;

  const name = getDisplayName(user);

  const handleSignOut = async () => {
    const confirm = await Taro.showModal({
      title: '确认退出',
      content: '退出后需要重新登录',
      confirmText: '退出',
      cancelText: '取消',
    });
    if (confirm.confirm) {
      try {
        await signOut();
        Taro.reLaunch({ url: '/pages/chats/index' });
      } catch (e) {
        Taro.showToast({ title: (e as Error).message, icon: 'none' });
      }
    }
  };

  return (
    <PrivacyShield>
    <View className="min-h-screen bg-background flex flex-col items-center px-6" style={{ paddingTop: `${statusBarHeight + 24}px` }}>
      {/* 调试信息:显示计时器状态 */}
      {/* 计时器状态条已隐藏,功能保留 */}
      {/* <View className="fixed top-0 left-0 right-0 px-4 py-2 bg-yellow-100 border-b border-yellow-300 z-50">
        <Text className="text-xs text-yellow-800">⏱️ 计时器状态: {timerStatus}</Text>
      </View> */}
      <View className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-4">
        <Text className="text-secondary-foreground text-2xl font-bold">{getInitial(name)}</Text>
      </View>
      <Text className="text-xl font-bold text-foreground mb-2">{name}</Text>

      <View
        className="w-full bg-card border border-border rounded-lg py-3 flex items-center justify-center mt-2"
        onClick={handleSignOut}
      >
        <Text className="text-destructive font-medium">退出登录</Text>
      </View>
    </View>
    </PrivacyShield>
  );
}
