import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, usePullDownRefresh } from '@tarojs/taro';
import { useChatsStore } from '@/store/chats-store';
import { useAuthStore } from '@/store/auth-store';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/supabase/client';
import PrivacyShield from '@/components/privacy-shield';
import { isShieldArmed, getArmedRoute, disarmShield } from '@/lib/shield-state';
import { setPageSwitching, resetPageSwitching, setCurrentPage, getCurrentPage } from '@/lib/inactivity-timer';
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
  const [hiddenClickCount, setHiddenClickCount] = useState(0);
  const hiddenClickTimerRef = useRef<any>(null);
  const pollingTimerRef = useRef<any>(null); // 轮询计时器(用于实时更新会话列表)
  const lastMessageAtMapRef = useRef<Map<string, string>>(new Map()); // 记录每个会话的最后消息时间戳
  const timerIdCounter = useRef<number>(0); // 计时器ID计数器,用于验证setTimeout是否是当前有效的

  // 隐藏按钮点击处理(连续3次跳转到Ping页)
  const handleHiddenClick = () => {
    const newCount = hiddenClickCount + 1;
    console.log(`[chats] 隐藏按钮点击次数: ${newCount}`);
    setHiddenClickCount(newCount);

    // 清除之前的定时器
    if (hiddenClickTimerRef.current) {
      clearTimeout(hiddenClickTimerRef.current);
    }

    // 设置2秒内重置计数器
    hiddenClickTimerRef.current = setTimeout(() => {
      console.log('[chats] 隐藏按钮计数器重置');
      setHiddenClickCount(0);
    }, 2000);

    // 达到3次点击
    if (newCount >= 3) {
      console.log('[chats] 触发隐藏功能: 跳转到Ping页面');
      setHiddenClickCount(0);
      if (hiddenClickTimerRef.current) {
        clearTimeout(hiddenClickTimerRef.current);
      }
      Taro.showToast({ title: '进入网络检测', icon: 'success', duration: 1500 });
      setTimeout(() => {
        // 用 reLaunch 关闭所有页面再打开 ping，彻底清空页面栈，
        // 避免回到 ping 后仍残留返回键 / 可右滑退回聊天列表
        Taro.reLaunch({ url: '/pages/ping/index' });
      }, 500);
    }
  };

  // 无操作计时器（v1.0.33 内联实现）
  const timerStartTimeRef = useRef<number>(0);
  const inactivityTimerRef = useRef<any>(null);
  const INACTIVITY_TIMEOUT_MS = 120_000; // 120秒

  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    timerStartTimeRef.current = Date.now();
    inactivityTimerRef.current = setTimeout(() => {
      console.log('[chats] ⏰ 无操作120秒，自动返回Ping页');
      inactivityTimerRef.current = null;
      timerStartTimeRef.current = 0;
      Taro.reLaunch({ url: '/pages/ping/index' });
    }, INACTIVITY_TIMEOUT_MS);
  };

  const checkInactivityTimeout = () => {
    if (!timerStartTimeRef.current) return;
    const elapsed = Date.now() - timerStartTimeRef.current;
    if (elapsed >= INACTIVITY_TIMEOUT_MS) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      timerStartTimeRef.current = 0;
      console.log('[chats] ⏰ 进入时已超时，立即返回Ping页');
      Taro.reLaunch({ url: '/pages/ping/index' });
    }
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    // 兜底拦截：遮挡未解除期间(如点原生返回键/右滑)落到本页，立即弹回被遮挡页。
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

    // 再检查登录状态
    if (!authLoaded) return;
    if (!user) {
      redirectToLogin();
      return;
    }
    // 每次显示页面都刷新会话列表,确保登录后能看到最新数据
    fetchConversations();
    fetchProfiles();
    // 启动智能轮询,每10秒检查一次是否有新消息
    startPolling();

    // 计时器逻辑
    const currentPage = getCurrentPage();
    setCurrentPage('chats');
    const isPageSwitch = currentPage !== '' && currentPage !== 'chats';
    if (isPageSwitch) {
      resetInactivityTimer();
    } else if (timerStartTimeRef.current) {
      checkInactivityTimeout();
    } else {
      resetInactivityTimer();
    }
  });

  useDidHide(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    timerStartTimeRef.current = 0;
    setPageSwitching(true);
  });

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    // 兜底拦截：遮挡未解除期间(如点原生返回键/右滑)落到本页，立即弹回被遮挡页。
    // 例外：若被遮挡页此刻已不在页面栈里(如遮挡后曾 reLaunch 去 ping 再暗号进入列表)，
    // 弹回只会把用户刚打开的本页顶走，此时直接解除遮挡、正常停留本页。
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

    // 再检查登录状态
    if (!authLoaded) return;
    if (!user) {
      redirectToLogin();
      return;
    }
    // 每次显示页面都刷新会话列表,确保登录后能看到最新数据
    fetchConversations();
    fetchProfiles();
    // 启动智能轮询,每10秒检查一次是否有新消息
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

  // 页面隐藏时:清理轮询
  useDidHide(() => {
    // 清理轮询
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

        // 步骤1: 轻量查询,只获取每个会话的last_message_at
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

        // 步骤2: 检查是否有会话的last_message_at发生变化
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

        // 步骤3: 只有当有变化时才刷新完整数据
        if (hasChanges) {
          console.log('[chats] 📥 检测到新消息,刷新完整会话列表');
          await fetchConversations();
          // 更新时间戳映射
          lastMessageAtMapRef.current = currentMap;
        } else {
          console.log('[chats] ⏸️ 无新消息,跳过刷新');
        }
      } catch (e) {
        console.error('[chats] 轮询失败:', e);
      }
    }, 10000); // 每10秒轮询一次
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
    });
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
        // 用户取消选择或点击遮罩层，静默处理
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
    <View className="min-h-screen bg-background">
      {/* 调试信息:显示计时器状态 */}
      {/* 计时器状态条已隐藏,功能保留 */}
      {/* <View className="px-4 py-2 bg-yellow-100 border-b border-yellow-300">
        <Text className="text-xs text-yellow-800">⏱️ 计时器状态: {timerStatus}</Text>
      </View> */}
      <View className="flex items-center justify-between px-4 py-3 bg-card border-b border-border">
        <View onClick={handleHiddenClick} className="cursor-pointer">
          <Text className="text-xl font-bold text-foreground">检测网络</Text>
        </View>
        <View onClick={handleStartChat}>
          <View className="i-lucide-message-circle-plus w-6 h-6 text-primary" />
        </View>
      </View>

      {conversations.length === 0 ? (
        <View className="flex flex-col items-center justify-center py-20">
          <View className="i-lucide-message-square w-16 h-16 text-muted-foreground" />
          <Text className="text-muted-foreground mt-4">还没有会话，去和在线的人聊聊吧</Text>
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
