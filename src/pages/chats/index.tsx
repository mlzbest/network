import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, usePullDownRefresh } from '@tarojs/taro';
import { useChatsStore } from '@/store/chats-store';
import { useAuthStore } from '@/store/auth-store';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { useState, useRef, useEffect } from 'react';

import { setPageSwitching, getPageSwitching, resetPageSwitching, setCurrentPage, getCurrentPage } from '@/lib/inactivity-timer';
import { supabase } from '@/supabase/client';
import PrivacyShield from '@/components/privacy-shield';
import { isShieldArmed, getArmedRoute, disarmShield } from '@/lib/shield-state';

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function getDisplayName(nickname: string | null, username: string | null): string {
  return nickname || username || '微信用户';
}

const ChatsPage = () => {
  console.log('[chats] 🚀 ChatsPage 组件初始化');
  const { conversations, loading, loaded, fetchConversations, fetchProfiles, profiles, startChat, deleteConversation } = useChatsStore();
  const { user, loaded: authLoaded } = useAuthStore();
  const inactivityTimerRef = useRef<any>(null);
  const pollingTimerRef = useRef<any>(null);
  const lastMessageAtMapRef = useRef<Map<string, string>>(new Map());
  const timerStartTimeRef = useRef<number>(0);
  const exitClickCountRef = useRef(0);
  const exitClickTimerRef = useRef<any>(null);

  // 自定义导航栏：顶部需留出状态栏高度，避免内容被刘海/状态栏遮挡
  const statusBarHeight = Taro.getSystemInfoSync().statusBarHeight || 0;

  // 120秒无操作自动返回网络页面
  const resetInactivityTimer = () => {
    const now = Date.now();

    if (inactivityTimerRef.current) {
      clearInterval(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }

    timerStartTimeRef.current = now;
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[chats] 🔥 [${timeStr}] 启动120秒计时器(setInterval模式), timerStartTimeRef=${now}`);

    inactivityTimerRef.current = setInterval(() => {
      const checkTime = Date.now();
      const elapsed = checkTime - timerStartTimeRef.current;

      const currentPage = getCurrentPage();
      if (currentPage !== 'chats') {
        console.log(`[chats] ⚠️ 当前活跃页面是${currentPage},不是chats,清除计时器`);
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        return;
      }

      if (elapsed >= 120000) {
        const timeoutTime = new Date().toLocaleTimeString();
        console.log(`[chats] ⏰ [${timeoutTime}] 确认超时(${Math.floor(elapsed / 1000)}秒),执行跳转`);
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        timerStartTimeRef.current = 0;
        Taro.reLaunch({ url: '/pages/ping/index' });
      }
    }, 1000);
  };

  // 检查是否已超时,如果超时就跳转
  const checkTimeout = () => {
    if (!timerStartTimeRef.current) return;
    const elapsed = Date.now() - timerStartTimeRef.current;
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[chats] 🔍 [${timeStr}] 检查超时: 已过去 ${Math.floor(elapsed / 1000)}秒`);
    if (elapsed >= 120000) {
      console.log(`[chats] ⚠️ [${timeStr}] 检测到已超时(${Math.floor(elapsed / 1000)}秒),立即跳转`);
      Taro.reLaunch({ url: '/pages/ping/index' });
    } else {
      const remaining = Math.ceil((120000 - elapsed) / 1000);
      console.log(`[chats] ℹ️ [${timeStr}] 未超时,剩余 ${remaining}秒`);
    }
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    if (isShieldArmed() && getArmedRoute() !== 'pages/chats/index') {
      const armedInStack = Taro.getCurrentPages().some((p) => p.route === getArmedRoute());
      if (armedInStack) {
        console.log('[chats] 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
        Taro.reLaunch({ url: '/' + getArmedRoute() });
        return;
      }
      console.log('[chats] 遮挡归属页已不在页面栈, 解除遮挡并停留本页');
      disarmShield();
    }
    const timeStr = new Date().toLocaleTimeString();
    const currentPage = getCurrentPage();
    const reallyLeft = currentPage !== '' && currentPage !== 'chats';

    if (inactivityTimerRef.current) {
      clearInterval(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      console.log(`[chats] 🛑 [${timeStr}] 强制清除旧计时器`);
    }

    setCurrentPage('chats');

    console.log(`[chats] 📱 [${timeStr}] useDidShow 触发, currentPage=${currentPage}, reallyLeft=${reallyLeft}`);

    if (!reallyLeft && timerStartTimeRef.current > 0) {
      console.log(`[chats] 🔙 [${timeStr}] 回到本页(未切往其他页),检查是否超时`);
      checkTimeout();
    } else {
      console.log(`[chats] 🆕 [${timeStr}] 新进入页面,重置计时器`);
      resetInactivityTimer();
    }

    if (!authLoaded) return;
    if (!user) {
      redirectToLogin();
      return;
    }
    fetchConversations();
    fetchProfiles();
    startPolling();
  });

  // 监听conversations变化,更新时间戳映射
  useEffect(() => {
    if (conversations && conversations.length > 0) {
      const newMap = new Map<string, string>();
      for (const conv of conversations) {
        if (conv.last_message_at) {
          newMap.set(conv.id, conv.last_message_at);
        }
      }
      lastMessageAtMapRef.current = newMap;
      console.log('[chats] 📊 已更新', newMap.size, '个会话的时间戳映射');
    }
  }, [conversations]);

  // 页面隐藏时:清除计时器,标记为页面切换
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[chats]  [${timeStr}] useDidHide 触发,清除计时器并标记为页面切换`);

    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      console.log(`[chats] 🛑 [${timeStr}] 已清除旧计时器`);
    }

    setPageSwitching(true);
    console.log(`[chats] 🏷️ [${timeStr}] 已调用setPageSwitching(true)`);

    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  });

  // 智能轮询函数:只在有未读消息时才刷新完整数据
  const startPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
    }
    console.log('[chats] 🔄 启动智能轮询模式,每10秒检查一次是否有新消息');
    pollingTimerRef.current = setInterval(async () => {
      try {
        const currentUser = useAuthStore.getState().user;
        if (!currentUser) return;

        const { data: latestConversations, error } = await supabase
          .from('conversations')
          .select('id, last_message_at')
          .or(`user1_id.eq.${currentUser.id},user2_id.eq.${currentUser.id}`)
          .order('last_message_at', { ascending: false, nullsFirst: false });

        if (error) {
          console.error('[chats] 轮询查询失败:', error);
          return;
        }

        if (!latestConversations || latestConversations.length === 0) {
          console.log('[chats] 轮询: 没有会话');
          return;
        }

        let hasChanges = false;
        const currentMap = new Map<string, string>();

        for (const conv of latestConversations) {
          const lastTime = conv.last_message_at || '';
          currentMap.set(conv.id, lastTime);

          const oldTime = lastMessageAtMapRef.current.get(conv.id) || '';
          if (lastTime !== oldTime) {
            hasChanges = true;
            console.log(`[chats] 检测到会话 ${conv.id.substring(0,8)}... 有新消息: ${oldTime} → ${lastTime}`);
          }
        }

        if (hasChanges) {
          console.log('[chats] 📥 检测到新消息,刷新完整会话列表');
          await fetchConversations();
          lastMessageAtMapRef.current = currentMap;
        } else {
          console.log('[chats] ⏸️ 无新消息,跳过刷新');
        }
      } catch (e) {
        console.error('[chats] 轮询失败:', e);
      }
    }, 10000);
  };

  // 长按菜单
  const handleLongPress = (item: { id: string; peer: { nickname: string | null; username: string | null } }) => {
    const name = getDisplayName(item.peer.nickname, item.peer.username);
    Taro.showActionSheet({
      itemList: ['删除聊天记录'],
      success: async (res) => {
        if (res.tapIndex === 0) {
          console.log('[chats] 准备删除会话:', item.id, '对方:', name);
          Taro.showModal({
            title: '确认删除',
            content: `确定要删除与"${name}"的聊天记录吗?`,
            success: async (modalRes) => {
              if (modalRes.confirm) {
                try {
                  await deleteConversation(item.id);
                  resetInactivityTimer();
                  Taro.showToast({ title: '已删除', icon: 'success', duration: 1500 });
                } catch (e) {
                  console.error('[chats] ❌ 删除会话异常:', e);
                  Taro.showToast({ title: (e as Error).message || '删除失败', icon: 'none', duration: 3000 });
                }
              }
            },
          });
        }
      },
      fail: (err) => {
        if (err.errMsg?.includes('cancel')) {
          console.log('[chats] 用户取消长按菜单');
        }
      },
    });
    resetInactivityTimer();
  };


  usePullDownRefresh(async () => {
    await fetchConversations();
    Taro.stopPullDownRefresh();
  });

  if (authLoaded && !user) {
    redirectToLogin();
    return null;
  }

  if (!authLoaded || (!loaded && loading)) {
    return (
      <View className="min-h-screen bg-background flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    );
  }

  const handleExitPingClick = () => {
    exitClickCountRef.current += 1;
    if (exitClickTimerRef.current) clearTimeout(exitClickTimerRef.current);
    exitClickTimerRef.current = setTimeout(() => { exitClickCountRef.current = 0; }, 2000);
    if (exitClickCountRef.current >= 3) {
      exitClickCountRef.current = 0;
      Taro.showToast({ title: "返回网络检测", icon: "success", duration: 1500 });
      setTimeout(() => Taro.reLaunch({ url: "/pages/ping/index" }), 500);
    }
  };

  const handleStartChat = async () => {
    await fetchProfiles();
    const list = useChatsStore.getState().profiles.filter((p) => p.id !== user?.id);
    if (list.length === 0) {
      Taro.showToast({ title: '暂无其他用户', icon: 'none' });
      return;
    }
    const names = list.map((p) => getDisplayName(p.nickname, p.username));
    Taro.showActionSheet({
      itemList: names,
      success: async (res) => {
        const peer = list[res.tapIndex];
        try {
          Taro.showLoading({ title: '创建会话', mask: true });
          const convId = await startChat(peer.id);
          Taro.hideLoading();
          Taro.navigateTo({
            url: '/pages/chat/index?conversationId=' + convId + '&peerId=' + peer.id + '&peerName=' + encodeURIComponent(getDisplayName(peer.nickname, peer.username)),
          });
        } catch (e) {
          Taro.hideLoading();
          Taro.showToast({ title: (e as Error).message, icon: 'none' });
        }
      },
      fail: (err) => {
        if (err.errMsg?.includes('cancel')) {
          console.log('[chats] 用户取消选择联系人');
        }
      },
    });
  };

  const handleOpenChat = (item: { id: string; peer: { id: string; nickname: string | null; username: string | null } }) => {
    const peerName = encodeURIComponent(getDisplayName(item.peer.nickname, item.peer.username));
    Taro.navigateTo({
      url: '/pages/chat/index?conversationId=' + item.id + '&peerId=' + item.peer.id + '&peerName=' + peerName,
    });
  };

  return (
    <PrivacyShield>
    <View className="min-h-screen bg-background flex flex-col">
      {/* 顶部导航栏 */}
      <View className="bg-card border-b border-border" style={{ paddingTop: `${statusBarHeight}px` }}>
        {/* AI 助手按钮已移除，改为从 ping 页输入 ai 进入 */}
        <View className="flex items-center gap-2 px-4 py-3">
          <Text onClick={handleExitPingClick} className="text-sm text-muted-foreground font-medium cursor-pointer">信息列表</Text>
          <View onClick={handleStartChat} className="cursor-pointer">
            <View className="i-lucide-plus-circle w-8 h-8 text-muted-foreground" />
          </View>
        </View>
      </View>

      {conversations.length === 0 ? (
        <View className="flex flex-col items-center justify-center py-20">
          <View className="i-lucide-message-square w-12 h-12 text-muted-foreground" />
          <Text className="text-muted-foreground mt-3 text-sm">还没有会话，去和在线的人聊聊吧</Text>
        </View>
      ) : (
        <View>
          {conversations.map((item) => {
            const name = getDisplayName(item.peer.nickname, item.peer.username);
            const initial = name.charAt(0);
            return (
              <View
                key={item.id}
                className="relative"
                onLongPress={() => handleLongPress(item)}
              >
                {/* 会话内容 */}
                <View
                  className="flex items-center gap-3 px-4 py-3 bg-card border-b border-border"
                  onClick={() => handleOpenChat(item)}
                >
                  <View className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center shrink-0 relative">
                    <Text className="text-secondary-foreground text-lg font-medium">{initial}</Text>
                    {/* 未读消息数角标 */}
                    {item.unread_count && item.unread_count > 0 && (
                      <View className="absolute -top-1 -right-1 min-w-[20px] h-5 bg-red-500 rounded-full flex items-center justify-center px-1">
                        <Text className="text-white text-xs font-bold">
                          {item.unread_count > 99 ? '99+' : item.unread_count}
                        </Text>
                      </View>
                    )}
                  </View>
                  <View className="flex-1 min-w-0">
                    <View className="flex items-center justify-between">
                      <Text className="text-foreground font-medium block">{name}</Text>
                      <Text className="text-muted-foreground text-xs shrink-0 ml-2">
                        {formatTime(item.last_message_at)}
                      </Text>
                    </View>
                    <Text className="text-muted-foreground text-sm truncate block mt-1">
                      {item.last_message || '开始聊天吧'}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </View>
    </PrivacyShield>
  );
};

export default ChatsPage;
