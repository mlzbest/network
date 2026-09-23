import { DEV } from '../../utils/dev';
import { View, Text, Input, ScrollView, Image, Form, Button } from '@tarojs/components';
import Taro, { useLoad, useRouter, useDidShow, useDidHide } from '@tarojs/taro';
import { useState, useEffect, useRef } from 'react';
import { useMessagesStore } from '@/store/messages-store';
import { useAuthStore } from '@/store/auth-store';
import { supabase, supabaseUrl } from '@/supabase/client';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { useKeyboardOffset } from '@/lib/hooks/use-keyboard-offset';
import { uploadToSupabase, selectMediaFiles } from '@/lib/upload';
import * as messagesApi from '@/api/messages';
import * as conversationsApi from '@/api/conversations';
import type { Message } from '@/api/messages';
import { setPageSwitching, getPageSwitching, resetPageSwitching, setCurrentPage, getCurrentPage } from '@/lib/inactivity-timer';
import PrivacyShield from '@/components/privacy-shield';
import { isShieldArmed, getArmedRoute } from '@/lib/shield-state';

export default function ChatPage() {
  const router = useRouter();
  const conversationId = router.params.conversationId || '';
  const peerName = decodeURIComponent(router.params.peerName || '聊天');

  const { user, loaded } = useAuthStore();
  const { messages, loading, loaded: msgLoaded, fetchMessages, sendMessage, receiveMessage, markAsRead, deleteMessage, deleteAllMessages, reset } = useMessagesStore();
  const [inputValue, setInputValue] = useState('');
  const [inputFocus, setInputFocus] = useState(false); // 默认不聚焦,用户点击后才聚焦
  const inputRef = useRef<any>(null); // Input ref,用于强制聚焦
  const [scrollTop, setScrollTop] = useState(0);
  const [showEmojiPanel, setShowEmojiPanel] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [hiddenClickCount, setHiddenClickCount] = useState(0);
  const [exitClickCount, setExitClickCount] = useState(0);
  const exitClickTimerRef = useRef<any>(null);
  const [timerStatus, setTimerStatus] = useState('未启动'); // 调试用:显示计时器状态
  const timerStartTimeRef = useRef<number>(0); // 记录计时器启动时间戳
  const keyboardOffset = useKeyboardOffset();
  const recorderManagerRef = useRef<any>(null);
  const innerAudioContextRef = useRef<any>(null);
  const recordingTimerRef = useRef<any>(null);
  const hiddenClickTimerRef = useRef<any>(null);
  const inactivityTimerRef = useRef<any>(null);
  const pollingTimerRef = useRef<any>(null); // 轮询计时器(Realtime降级方案)
  const realtimeConnectedRef = useRef(false); // Realtime连接状态
  const lastPeerMsgAtRef = useRef(0); // 最近一条对方消息的服务端时间戳(ms),用于计算推送延迟
  const timerIdCounter = useRef<number>(0); // 计时器ID计数器,用于验证setTimeout是否是当前有效的
  const [uploading, setUploading] = useState(false); // 图片上传状态
  const [selectMode, setSelectMode] = useState(false); // 长按进入的多选删除模式
  const [selectedIds, setSelectedIds] = useState<string[]>([]); // 已勾选的消息id
  const longPressTimerRef = useRef<any>(null); // 长按计时器
  const pendingLongPressRef = useRef<string | null>(null); // 长按已触发但抬手click未消费的消息id
  const longPressFiredRef = useRef(false); // 本次触摸是否已触发长按
  const [replyTo, setReplyTo] = useState<Message | null>(null); // 正在引用回复的消息

  // 自定义导航栏(去掉原生返回键)后,顶部需留出状态栏高度,避免内容被刘海/状态栏遮挡
  const statusBarHeight = Taro.getSystemInfoSync().statusBarHeight || 0;

  // 丰富表情列表(120个常用表情)
  const emojis = [
    // 笑脸系列
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃',
    '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙',
    '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔',
    '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥',
    '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮',
    '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓',
    // 手势系列
    '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞',
    '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍',
    '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝',
    '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂',
    // 爱心系列
    '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
    '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️',
    // 动物系列
    '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
    '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆',
    // 食物系列
    '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈',
    '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦',
    // 庆祝系列
    '🎉', '🎊', '🎈', '🎁', '🎀', '🎗️', '🎟️', '🎫', '🎖️', '🏆',
    '🏅', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '⚾', '🥎', '🎾',
    // 其他常用
    '🔥', '💯', '✨', '⭐', '🌟', '💫', '💥', '💢', '💦', '💨',
    '🕳️', '💣', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤', '👋🏻', '👋🏼',
  ];

  // 当 loaded 和 user 都就绪后,自动加载消息
  useEffect(() => {
    if (loaded && user && conversationId) {
      [DEV]('[chat] 页面加载完成,conversationId:', conversationId);
      fetchMessages(conversationId);
      // 进入聊天页后,将对方发来的历史消息标记为已读
      markAsRead(conversationId);
    } else {
      [DEV]('[chat] 等待加载... loaded:', loaded, 'user:', !!user, 'conversationId:', conversationId);
    }
  }, [loaded, user, conversationId]);

  // 消息加载完成后,首次进入自动滚动到底部
  useEffect(() => {
    if (msgLoaded && messages.length > 0) {
      timerIdCounter.current += 1;
      const newScrollTop = 999999 + timerIdCounter.current;
      setTimeout(() => {
        setScrollTop(newScrollTop);
        [DEV]('[chat] 消息加载完成,自动滚动到底部, scrollTop:', newScrollTop);
      }, 300);
    }
  }, [msgLoaded]);

  // 120秒无输入自动返回网络页面
  const resetInactivityTimer = () => {
    const now = Date.now();

    // 清除旧的计时器(如果存在)
    if (inactivityTimerRef.current) {
      clearInterval(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }

    timerStartTimeRef.current = now;
    const timeStr = new Date().toLocaleTimeString();
    [DEV](`[chat] 🔥 [${timeStr}] 启动120秒计时器(setInterval模式), timerStartTimeRef=${now}`);

    // 使用setInterval每1秒检查一次
    inactivityTimerRef.current = setInterval(() => {
      const checkTime = Date.now();
      const elapsed = checkTime - timerStartTimeRef.current;

      // 检查当前页面是否仍是活跃页面
      const currentPage = getCurrentPage();
      if (currentPage !== 'chat') {
        [DEV](`[chat] ⚠️ 当前活跃页面是${currentPage},不是chat,清除计时器`);
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        return;
      }

      // 检查是否超时
      if (elapsed >= 120000) {
        const timeoutTime = new Date().toLocaleTimeString();
        [DEV](`[chat] ⏰ [${timeoutTime}] 确认超时(${Math.floor(elapsed / 1000)}秒),执行跳转`);
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
    [DEV](`[chat] 🔍 [${timeStr}] 检查超时: 已过去 ${Math.floor(elapsed / 1000)}秒`);
    if (elapsed >= 120000) {
      [DEV](`[chat] ⚠️ [${timeStr}] 检测到已超时(${Math.floor(elapsed / 1000)}秒),立即跳转`);
      Taro.reLaunch({ url: '/pages/ping/index' });
    } else {
      const remaining = Math.ceil((120000 - elapsed) / 1000);
      [DEV](`[chat] ℹ️ [${timeStr}] 未超时,剩余 ${remaining}秒`);
    }
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    // 兜底拦截：遮挡未解除期间(如点原生返回键/右滑)落到本页，立即弹回被遮挡页
    if (isShieldArmed() && getArmedRoute() !== 'pages/chat/index') {
      [DEV]('[chat] 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
      Taro.reLaunch({ url: '/' + getArmedRoute() });
      return;
    }
    const timeStr = new Date().toLocaleTimeString();
    const currentPage = getCurrentPage();
    const isPageSwitch = currentPage !== '' && currentPage !== 'chat'; // 如果当前活跃页面不是自己,说明是页面切换

    // 先强制清除任何可能存在的旧计时器
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      [DEV](`[chat] 🛑 [${timeStr}] 强制清除旧计时器`);
    }

    setCurrentPage('chat'); // 记录当前活跃页面

    [DEV](`[chat] 📱 [${timeStr}] useDidShow 触发, currentPage=${currentPage}, isPageSwitch=${isPageSwitch}`);
    setTimerStatus('已启动');

    if (!conversationId) return;

    if (isPageSwitch) {
      // 页面切换:重置计时器
      [DEV](`[chat] 🔄 [${timeStr}] 检测到页面切换(从${currentPage}切换过来),重置计时器`);
      resetInactivityTimer();
    } else if (timerStartTimeRef.current) {
      // 从后台切回:检查是否超时
      [DEV](`[chat] 🔙 [${timeStr}] 从后台切回,检查是否超时`);
      checkTimeout();
    } else {
      // 首次进入页面,启动计时器
      [DEV](`[chat]  [${timeStr}] 首次进入页面,启动计时器`);
      resetInactivityTimer();

      // 首次进入且有消息时,自动滚动到底部(使用递增计数器确保触发)
      if (messages.length > 0) {
        timerIdCounter.current += 1;
        const newScrollTop = 999999 + timerIdCounter.current;
        setTimeout(() => {
          setScrollTop(newScrollTop);
          [DEV]('[chat] 首次进入自动滚动到底部, scrollTop:', newScrollTop);
        }, 500);
      }
    }
  });

  // 页面隐藏时:清除计时器,标记为页面切换
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    [DEV](`[chat] 👻 [${timeStr}] useDidHide 触发,清除计时器并标记为页面切换`);
    setTimerStatus('页面隐藏');

    // 强制清除计时器(无论是否有)
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
      [DEV](`[chat] 🛑 [${timeStr}] 已清除旧计时器`);
    } else {
      [DEV](`[chat] ℹ️ [${timeStr}] 无活跃计时器可清除`);
    }

    setPageSwitching(true); // 标记为页面切换
    [DEV](`[chat] 🏷️ [${timeStr}] 已调用setPageSwitching(true)`);
  });

  // Realtime 订阅对方发来的新消息和已读状态更新
  useEffect(() => {
    if (!conversationId || !user) return;

    const channel = supabase
      .channel('chat:' + conversationId);

    // 必须在 subscribe() 之前注册所有 on() 回调

    // 监听新消息(INSERT)
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + conversationId },
      (payload) => {
        const newMsg = payload.new as Message;
        // 计算从对方发出(created_at服务端时间)到本机收到推送的真实延迟
        const sentAt = new Date(newMsg.created_at).getTime();
        const latencyMs = Date.now() - sentAt;
        [DEV]('[chat] ⚡ Realtime收到INSERT事件:', newMsg.id, '发送者:', newMsg.sender_id === user.id ? '自己' : '对方', '推送延迟(ms):', latencyMs);
        if (newMsg.sender_id !== user.id) {
          lastPeerMsgAtRef.current = Math.max(lastPeerMsgAtRef.current, sentAt);
          receiveMessage(newMsg);
          // 收到对方消息后自动标记为已读
          markAsRead(conversationId);
        }
      },
    );

    // 监听消息更新(UPDATE) - 用于同步已读状态
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + conversationId },
      (payload) => {
        const updatedMsg = payload.new as Message;
        [DEV]('[chat] 收到消息更新事件:', updatedMsg.id, 'read_at:', updatedMsg.read_at);
        // 通过store的setter更新本地消息列表
        useMessagesStore.setState({
          messages: useMessagesStore.getState().messages.map((m) =>
            m.id === updatedMsg.id ? { ...m, read_at: updatedMsg.read_at } : m
          ),
        });
      },
    );

    // 最后才调用 subscribe(),并监听订阅状态
    channel.subscribe((status) => {
      [DEV]('[chat] Realtime订阅状态:', status);
      if (status === 'SUBSCRIBED') {
        [DEV]('[chat] ✅ Realtime订阅成功,可以实时接收消息');
        realtimeConnectedRef.current = true;
        // Realtime成功后,停止轮询(如果正在轮询)
        if (pollingTimerRef.current) {
          clearInterval(pollingTimerRef.current);
          pollingTimerRef.current = null;
          [DEV]('[chat] Realtime已连接,停止轮询');
        }
        // 补拉一次:订阅建立前一刻发出的消息可能错过事件,立即对齐最新列表
        fetchMessages(conversationId);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[chat] ⚠️ Realtime订阅失败:', status, '- 启动轮询降级方案');
        realtimeConnectedRef.current = false;
        // Realtime失败时,启动轮询
        startPolling();
      }
    });

    return () => {
      channel.unsubscribe();
      reset();
      // 清理轮询
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [conversationId, user]);

  // 轮询函数:定期检查新消息和已读状态(Realtime降级方案)
  const startPolling = () => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
    }
    [DEV]('[chat] 🔄 启动轮询模式,每1秒增量检查一次新消息和已读状态');
    pollingTimerRef.current = setInterval(async () => {
      if (!conversationId || !user) return;

      try {
        const user_id = useAuthStore.getState().user?.id;
        if (!user_id) return;

        const currentMessages = useMessagesStore.getState().messages;

        // 增量拉取1:对方新消息——以「已知最后一条消息的服务端时间」为游标(而非本地时钟),
        // 避免设备时钟偏差漏拉;结果集极小、单次往返即拿到新消息。
        const lastKnownAt = currentMessages.length > 0
          ? new Date(currentMessages[currentMessages.length - 1].created_at).getTime()
          : 0;
        const cursor = Math.max(lastKnownAt, lastPeerMsgAtRef.current);
        const peerNew = await messagesApi.listPeerMessagesSince(
          conversationId, user_id, new Date(cursor - 2000).toISOString(),
        );
        [DEV]('[chat] 轮询增量拉取完成: 对方新消息', peerNew.length, '条(静态导入模式)');

        if (peerNew.length > 0) {
          const knownIds = new Set(useMessagesStore.getState().messages.map((m) => m.id));
          const fresh = peerNew.filter((m) => !knownIds.has(m.id));
          if (fresh.length > 0) {
            // 计算从对方发出到本机发现的真实延迟(ms),用于评估接收速度
            const firstSentAt = new Date(fresh[0].created_at).getTime();
            [DEV]('[chat] 轮询发现对方新消息:', fresh.length, '条, 接收延迟(ms):', Date.now() - firstSentAt);
            fresh.forEach((m) => {
              receiveMessage(m);
              lastPeerMsgAtRef.current = Math.max(lastPeerMsgAtRef.current, new Date(m.created_at).getTime());
            });
            markAsRead(conversationId);
          }
        }

        // 增量拉取2:自己发出消息的已读回执变化——只查自己发的、read_at 非空的少量行
        const mineRead = await messagesApi.listMyReadMessages(conversationId, user_id);
        let hasReadStatusChange = false;
        const readMap = new Map(mineRead.map((m) => [m.id, m.read_at]));
        latestLoop: for (const cm of useMessagesStore.getState().messages) {
          if (cm.sender_id === user_id) {
            const remote = readMap.get(cm.id);
            if (remote !== undefined && remote !== cm.read_at) {
              hasReadStatusChange = true;
              break latestLoop;
            }
          }
        }
        if (hasReadStatusChange) {
          [DEV]('[chat] 轮询检测到已读状态变化');
          useMessagesStore.setState({
            messages: useMessagesStore.getState().messages.map((m) =>
              m.sender_id === user_id && readMap.has(m.id)
                ? { ...m, read_at: readMap.get(m.id) ?? null }
                : m,
            ),
          });
        }
      } catch (e) {
        console.error('[chat] 轮询失败:', e);
      }
    }, 1000); // 每1秒轮询一次
  };

  // 移除 messages.length 变化时的 scrollTop 自动更新,避免触发 ScrollView 滚动导致键盘收起
  // 用户可通过手动滚动查看最新消息

  // 键盘弹出时自动滚动到最新消息(等待输入区高度稳定后再滚,避免动画中途失效)
  const prevKeyboardOffsetRef = useRef(0);
  useEffect(() => {
    const prev = prevKeyboardOffsetRef.current;
    prevKeyboardOffsetRef.current = keyboardOffset;

    // 仅在键盘"从收起变为弹出"(0 -> >0)时触发,避免收起/中间态反复滚动
    if (prev === 0 && keyboardOffset > 0) {
      timerIdCounter.current += 1;
      const newScrollTop = 999999 + timerIdCounter.current;
      setTimeout(() => {
        setScrollTop(newScrollTop);
        [DEV]('[chat] 键盘弹出,自动滚动到最新消息, scrollTop:', newScrollTop);
      }, 250);
    }
  }, [keyboardOffset]);

  const onSendText = async () => {
    const text = inputValue.trim();
    if (!text || !conversationId) return;

    try {
      [DEV]('[chat] 发送文字消息:', text, replyTo ? '引用消息:' + replyTo.id : '');

      await sendMessage(
        conversationId,
        text,
        'text',
        undefined,
        replyTo ? { id: replyTo.id, content: quoteSummary(replyTo) } : undefined,
      );
      [DEV]('[chat] 消息发送成功,重置计时器');
      resetInactivityTimer();

      // 清空输入框、引用状态并保持焦点
      setInputValue('');
      setReplyTo(null);
      setInputFocus(true);

      // 发送后自动滚动到底部(使用递增计数器确保每次scrollTop值都不同,避免重复值不触发更新)
      timerIdCounter.current += 1;
      const newScrollTop = 999999 + timerIdCounter.current;
      setScrollTop(newScrollTop);
      [DEV]('[chat] 发送后自动滚动到底部, scrollTop:', newScrollTop);
    } catch (err) {
      console.error('[chat] 发送消息失败:', err);
      Taro.showToast({ title: (err as Error).message, icon: 'none' });
    }
  };

  // 引用气泡仅做展示与定位，不改变 ScrollView 高度；点击定位原消息用近似滚动
  const onSendImage = async (url: string) => {
    if (!conversationId) return;
    try {
      await sendMessage(
        conversationId,
        '[图片]',
        'image',
        url,
        replyTo ? { id: replyTo.id, content: quoteSummary(replyTo) } : undefined,
      );
      resetInactivityTimer();
      setReplyTo(null);
      // 发送后刷新列表
      await fetchMessages(conversationId);
      // 发送后保持焦点
      setInputFocus(true);
    } catch (e) {
      Taro.showToast({ title: (e as Error).message, icon: 'none' });
    }
  };

  // 初始化录音管理器
  useEffect(() => {
    if (Taro.getEnv() === Taro.ENV_TYPE.WEAPP) {
      recorderManagerRef.current = Taro.getRecorderManager();
      innerAudioContextRef.current = Taro.createInnerAudioContext();

      recorderManagerRef.current.onStop((res: any) => {
        setIsRecording(false);
        setRecordingDuration(0);
        if (recordingTimerRef.current) {
          clearInterval(recordingTimerRef.current);
        }

        // 上传语音文件
        handleUploadVoice(res.tempFilePath, res.duration);
      });

      recorderManagerRef.current.onError((err: any) => {
        console.error('[chat] 录音错误:', err);
        setIsRecording(false);
        setRecordingDuration(0);
        // 安全隐藏loading(可能未显示)
        try { Taro.hideLoading(); } catch {}
        Taro.showToast({ title: '录音失败', icon: 'none' });
      });
    }

    return () => {
      if (innerAudioContextRef.current) {
        innerAudioContextRef.current.destroy();
      }
    };
  }, []);

  const handleUploadVoice = async (tempFilePath: string, duration: number) => {
    if (!conversationId) return;
    try {
      Taro.showLoading({ title: '发送中...' });

      // 构造 MiniProgramFileInput 对象
      const file = {
        name: `voice-${Date.now()}.mp3`,
        type: 'audio/mpeg',
        size: 0, // 小程序环境不需要 size
        tempFilePath,
      };

      // 使用统一的上传函数(自动处理小程序/Web环境)
      const result = await uploadToSupabase(file, { bucket: 'chat-media' });

      if (!result.success) {
        throw new Error(result.error || '上传失败');
      }

      // 获取公开 URL
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${result.data.path}`;

      // 发送消息
      await sendMessage(conversationId, `[${Math.ceil(duration / 1000)}s]`, 'voice', publicUrl);
      resetInactivityTimer();
      // 发送后刷新列表
      await fetchMessages(conversationId);
      Taro.hideLoading();
      Taro.showToast({ title: '发送成功', icon: 'success' });
      // 发送后保持焦点
      setInputFocus(true);
    } catch (e: any) {
      console.error('上传语音失败:', e);
      // 安全隐藏loading(可能未显示)
      try { Taro.hideLoading(); } catch {}
      Taro.showToast({ title: e.message || '发送失败', icon: 'none' });
    }
  };

  const onStartRecording = () => {
    if (isRecording) return;

    if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
      Taro.showToast({ title: '请在小程序中使用', icon: 'none' });
      return;
    }

    setIsRecording(true);
    setRecordingDuration(0);

    // 启动计时器
    recordingTimerRef.current = setInterval(() => {
      setRecordingDuration((prev) => prev + 1);
    }, 1000);

    // 开始录音
    recorderManagerRef.current.start({
      duration: 60000, // 最长60秒
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 48000,
      format: 'mp3',
    });

    // 安全显示toast(可能因权限问题失败)
    try {
      Taro.showToast({ title: '正在录音...', icon: 'none', duration: 60000 });
    } catch {}
  };

  const onStopRecording = () => {
    if (!isRecording) return;
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
    }
    recorderManagerRef.current.stop();
    Taro.hideToast();
  };

  const onSendVoice = () => {
    [DEV]('[chat] 语音按钮被点击, isRecording:', isRecording);
    if (isRecording) {
      onStopRecording();
    } else {
      onStartRecording();
    }
  };

  const playVoice = (messageId: string, url: string) => {
    if (!innerAudioContextRef.current) return;

    // 如果正在播放同一条,则暂停
    if (playingVoiceId === messageId) {
      innerAudioContextRef.current.pause();
      setPlayingVoiceId(null);
      return;
    }

    // 停止之前的播放
    if (playingVoiceId) {
      innerAudioContextRef.current.stop();
    }

    // 播放新语音
    innerAudioContextRef.current.src = url;
    innerAudioContextRef.current.play();
    setPlayingVoiceId(messageId);

    innerAudioContextRef.current.onEnded(() => {
      setPlayingVoiceId(null);
    });

    innerAudioContextRef.current.onError(() => {
      setPlayingVoiceId(null);
      Taro.showToast({ title: '播放失败', icon: 'none' });
    });
  };

  // 可见退出按钮点击处理(连续3次返回Ping页)
  const handleExitClick = () => {
    const newCount = exitClickCount + 1;
    [DEV](`[chat] 退出按钮点击次数: ${newCount}`);
    setExitClickCount(newCount);

    if (exitClickTimerRef.current) {
      clearTimeout(exitClickTimerRef.current);
    }

    exitClickTimerRef.current = setTimeout(() => {
      [DEV]('[chat] 退出按钮计数器重置');
      setExitClickCount(0);
    }, 2000);

    if (newCount >= 3) {
      [DEV]('[chat] 触发退出功能: 返回Ping页面');
      setExitClickCount(0);
      if (exitClickTimerRef.current) {
        clearTimeout(exitClickTimerRef.current);
      }
      Taro.showToast({ title: '返回网络检测', icon: 'success', duration: 1500 });
      setTimeout(() => {
        Taro.reLaunch({ url: '/pages/ping/index' });
      }, 500);
    }
  };

  // 隐藏按钮点击处理(连续3次返回Ping页)
  const handleHiddenClick = () => {
    const newCount = hiddenClickCount + 1;
    [DEV](`[chat] 隐藏按钮点击次数: ${newCount}`);
    setHiddenClickCount(newCount);

    // 清除之前的定时器
    if (hiddenClickTimerRef.current) {
      clearTimeout(hiddenClickTimerRef.current);
    }

    // 设置2秒内重置计数器
    hiddenClickTimerRef.current = setTimeout(() => {
      [DEV]('[chat] 隐藏按钮计数器重置');
      setHiddenClickCount(0);
    }, 2000);

    // 达到3次点击
    if (newCount >= 3) {
      [DEV]('[chat] 触发隐藏功能: 返回Ping页面');
      setHiddenClickCount(0);
      if (hiddenClickTimerRef.current) {
        clearTimeout(hiddenClickTimerRef.current);
      }
      Taro.showToast({ title: '返回网络检测', icon: 'success', duration: 1500 });
      setTimeout(() => {
        Taro.reLaunch({ url: '/pages/ping/index' });
      }, 500);
    }
  };

  // ===== 长按多选删除 =====
  const exitSelectMode = () => {
    [DEV]('[chat] 退出多选删除模式');
    setSelectMode(false);
    setSelectedIds([]);
  };

  const toggleMessageSelect = (messageId: string) => {
    setSelectedIds((prev) => {
      const next = prev.includes(messageId)
        ? prev.filter((id) => id !== messageId)
        : [...prev, messageId];
      [DEV]('[chat] 勾选消息:', messageId, '当前已选数量:', next.length);
      return next;
    });
  };

  // 触摸开始:650ms后触发长按,弹出多选确认菜单。
  // 【防误触】手指移动超过10px(滚动/滑动)立即取消长按判定——
  // 之前500ms纯计时,滚动时手指在任何消息上停顿都会误弹菜单。
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const onMsgTouchStart = (e: any, msgId: string) => {
    // 长按热区已收窄到气泡/勾选框,但事件仍会冒泡到行层——多选模式内
    // 点空白处只该退出多选,绝不能再弹操作菜单
    if (selectMode) return;
    pendingLongPressRef.current = null;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    const t = e?.touches?.[0];
    touchStartPosRef.current = t ? { x: t.clientX, y: t.clientY } : null;
    longPressTimerRef.current = setTimeout(() => {
      // 长按达成后抬手仍会补发一次click,置pending标记供行内消费(多选未开启时也会被ScrollView兜底消费)
      pendingLongPressRef.current = 'longpress';
      [DEV]('[chat] 长按消息触发,弹出操作菜单:', msgId);
      Taro.vibrateShort({ type: 'light' }).catch(() => {});
      Taro.showActionSheet({
        itemList: ['回复', '多选删除消息'],
        itemColor: '#3f3f46',
        success: (res) => {
          if (res.tapIndex === 0) {
            // 进入引用回复：展示引用条并聚焦输入框
            const target = messages.find((m) => m.id === msgId);
            if (target) {
              [DEV]('[chat] 用户选择回复消息:', target.id);
              setReplyTo(target);
              setInputFocus(true);
            }
          } else if (res.tapIndex === 1) {
            // 用户主动点菜单确认后才进入多选模式,此时不消费任何click,无需pending标记
            [DEV]('[chat] 用户确认进入多选删除模式');
            setSelectMode(true);
          } else {
            [DEV]('[chat] 用户取消,不进入任何模式');
          }
        },
        fail: () => {
          [DEV]('[chat] ActionSheet被关闭,不进入任何模式');
        },
      });
    }, 650);
  };

  const onMsgTouchMove = (e: any) => {
    const start = touchStartPosRef.current;
    const t = e?.touches?.[0];
    if (!start || !t) return;
    const dx = Math.abs(t.clientX - start.x);
    const dy = Math.abs(t.clientY - start.y);
    if ((dx > 10 || dy > 10) && longPressTimerRef.current) {
      [DEV](`[chat] 手指移动(${Math.round(dx)},${Math.round(dy)}px),取消长按判定`);
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const onMsgTouchEnd = () => {
    touchStartPosRef.current = null;
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // 多选模式下点击消息行:切换勾选。
  // 【根因】小程序/Taro里子元素onClick默认继续冒泡到ScrollView,
  // 会被ScrollView的"点空白退出多选"逻辑误判并exitSelectMode,
  // 表现为"刚勾上第2条就自动取消"。必须显式stopPropagation阻断冒泡。
  const lastToggleRef = useRef<{ id: string; time: number }>({ id: '', time: 0 });
  const onMsgTapInSelectMode = (messageId: string, e?: any) => {
    // 关键:无论后续走哪条分支,先阻断向ScrollView的冒泡
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (!selectMode) return;
    // 长按刚触发(弹菜单)的消息,其抬手补发的click直接消费掉,不进入toggle逻辑。
    // 同步复位longPressFiredRef,防止其它层再次误判。
    if (pendingLongPressRef.current !== null) {
      pendingLongPressRef.current = null;
      longPressFiredRef.current = false;
      [DEV]('[chat] 消费长按后的误触click:', messageId);
      return;
    }
    // 一次物理触摸可能派发多次click(行内+残留),400ms同id去重作为最后防线。
    const now = Date.now();
    if (lastToggleRef.current.id === messageId && now - lastToggleRef.current.time < 400) {
      [DEV]('[chat] 同一消息400ms内重复toggle,已去重:', messageId);
      return;
    }
    lastToggleRef.current = { id: messageId, time: now };
    [DEV]('[chat] 点击消息行,切换勾选(已阻断冒泡):', messageId);
    toggleMessageSelect(messageId);
  };

  // 全选/取消全选
  const handleToggleSelectAll = () => {
    if (selectedIds.length === messages.length) {
      [DEV]('[chat] 取消全选');
      setSelectedIds([]);
    } else {
      [DEV]('[chat] 全选消息,数量:', messages.length);
      setSelectedIds(messages.map((m) => m.id));
    }
  };

  // 删除已勾选的消息(软删除,仅自己视图消失)。
  // 【防误删】点删除先弹二次确认,避免多选模式下顺手点错直接删掉。
  const handleDeleteSelected = () => {
    if (selectedIds.length === 0) {
      Taro.showToast({ title: '请先选择消息', icon: 'none' });
      return;
    }
    const count = selectedIds.length;
    [DEV]('[chat] 点击删除按钮,弹出二次确认,数量:', count);
    Taro.showModal({
      title: '确认删除',
      content: `确定删除选中的 ${count} 条消息吗？仅从你的聊天记录中移除。`,
      confirmText: '删除',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) {
          [DEV]('[chat] 用户取消删除');
          return;
        }
        [DEV]('[chat] 确认删除选中消息,数量:', count);
        try {
          Taro.showLoading({ title: '删除中...', mask: true });
          for (const id of selectedIds) {
            await deleteMessage(id);
          }
          Taro.hideLoading();
          Taro.showToast({ title: `已删除${count}条`, icon: 'success', duration: 1200 });
          exitSelectMode();
          resetInactivityTimer();
        } catch (e) {
          try { Taro.hideLoading(); } catch (_) {}
          console.error('[chat] 删除选中消息失败:', e);
          Taro.showToast({ title: (e as Error).message || '删除失败', icon: 'none' });
        }
      },
      fail: () => {
        [DEV]('[chat] 确认弹窗打开失败');
      },
    });
  };

  // 清空聊天记录并删除会话(入口:长按聊天名称,无可见按钮)
  const handleClearAllMessages = () => {
    Taro.showModal({
      title: '确认清空',
      content: '确定要清空与对方的所有聊天记录吗？对方仍可见。清空后此会话将被删除。',
      success: async (res) => {
        if (res.confirm) {
          try {
            Taro.showLoading({ title: '清空中...', mask: true });
            await deleteAllMessages(conversationId);
            // 同时删除会话本身
            const currentUser = useAuthStore.getState().user;
            if (currentUser) {
              await conversationsApi.deleteConversation(conversationId, currentUser.id);
            }
            resetInactivityTimer();
            Taro.hideLoading();
            Taro.showToast({ title: '已清空', icon: 'success', duration: 1500 });
            // 延迟返回会话列表
            setTimeout(() => {
              Taro.navigateBack();
            }, 1500);
          } catch (e) {
            Taro.hideLoading();
            Taro.showToast({ title: (e as Error).message, icon: 'none' });
          }
        }
      },
    });
  };

  const onSendEmoji = async (emoji: string) => {
    if (!conversationId) {
      Taro.showToast({ title: '会话ID不存在', icon: 'none' });
      return;
    }
    const currentUser = useAuthStore.getState().user;
    if (!currentUser) {
      Taro.showToast({ title: '用户未登录', icon: 'none' });
      return;
    }
    try {
      [DEV]('[chat] 发送表情:', emoji, 'conversationId:', conversationId, 'userId:', currentUser.id);
      await sendMessage(conversationId, emoji, 'emoji');
      setShowEmojiPanel(false);
      // 发送表情后不强制聚焦输入框,让用户可以继续选择其他表情
      resetInactivityTimer();
      // 发送后刷新列表
      await fetchMessages(conversationId);
      // 显示成功提示
      Taro.showToast({ title: '已发送', icon: 'success', duration: 1000 });
      [DEV]('[chat] 表情发送成功,面板已关闭');
    } catch (e: any) {
      console.error('[chat] 发送表情失败:', e);
      console.error('[chat] 错误详情:', e.message);
      Taro.showToast({
        title: `发送失败: ${e.message?.substring(0, 30) || '未知错误'}`,
        icon: 'none',
        duration: 3000
      });
    }
  };

  // 选择并上传图片
  const handleSelectImage = async () => {
    [DEV]('[chat] 加号按钮被点击');

    if (uploading) return;

    try {
      // 先让用户选择图片,此时不显示loading,避免"未选先提示发送中"的体验问题
      const files = await selectMediaFiles({ count: 1, mediaType: ['image'] });
      [DEV]('[chat] 选择图片结果:', files.length, '个文件');

      // 用户取消选择(未选中任何图片),直接返回,不做任何提示
      if (files.length === 0) {
        [DEV]('[chat] 用户取消选择图片,终止流程');
        return;
      }

      // 确认已选中图片后,再进入上传状态并显示loading
      setUploading(true);
      Taro.showLoading({ title: '上传中...' });

      // 使用统一的上传函数(自动处理小程序/Web环境)
      const file = files[0];
      const result = await uploadToSupabase(file, { bucket: 'chat-media' });

      if (!result.success) {
        throw new Error(result.error || '上传失败');
      }

      // 获取公开 URL
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${result.data.path}`;

      await onSendImage(publicUrl);
      Taro.showToast({ title: '发送成功', icon: 'success' });
    } catch (e: any) {
      console.error('上传图片失败:', e);
      Taro.showToast({ title: e.message || '上传失败', icon: 'none' });
    } finally {
      setUploading(false);
      try {
        Taro.hideLoading();
      } catch {}
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${h}:${m}`;
  };

  // 消息的引用摘要文本（非文字消息用类型占位符表示）
  const quoteSummary = (msg: Message) => {
    if (msg.content_type === 'text') return msg.content;
    if (msg.content_type === 'emoji') return `[表情] ${msg.content}`;
    if (msg.content_type === 'image') return '[图片]';
    if (msg.content_type === 'voice') return '[语音]';
    return msg.content;
  };

  // 引用气泡内点击：提示原消息（小程序内不做像素级定位，避免不可靠的滚动计算）
  const onQuoteTap = (messageId: string) => {
    const exists = messages.some((m) => m.id === messageId);
    Taro.showToast({
      title: exists ? '被引用的消息在上方' : '原消息已删除',
      icon: 'none',
    });
  };

  const renderMessageContent = (msg: Message, isMine: boolean) => {
    switch (msg.content_type) {
      case 'image':
        return (
          <Image
            src={msg.media_url || ''}
            mode="widthFix"
            className="rounded-lg max-w-full"
            style={{ maxWidth: '200px' }}
          />
        );
      case 'emoji':
        return (
          <Text className={`text-3xl ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
            {msg.content}
          </Text>
        );
      case 'voice':
        const isPlaying = playingVoiceId === msg.id;
        return (
          <View
            onClick={() => msg.media_url && playVoice(msg.id, msg.media_url)}
            className="flex flex-row items-center gap-2 cursor-pointer"
          >
            <View className={`i-lucide-${isPlaying ? 'pause' : 'play'} w-5 h-5`} />
            <Text className={`text-sm ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
              {msg.content}
            </Text>
            {isPlaying && (
              <View className="ml-1">
                <View className="i-lucide-volume-2 w-4 h-4 animate-pulse" />
              </View>
            )}
          </View>
        );
      default:
        return (
          <Text className={`text-sm ${isMine ? 'text-primary-foreground' : 'text-foreground'}`}>
            {msg.content}
          </Text>
        );
    }
  };

  // 登录状态加载中显示加载提示
  if (!loaded) {
    return (
      <View className="min-h-screen flex items-center justify-center bg-background">
        <View className="flex flex-col items-center gap-4">
          <View className="i-lucide-loader-2 w-8 h-8 animate-spin text-primary" />
          <Text className="text-muted-foreground text-sm">正在加载...</Text>
        </View>
      </View>
    );
  }

  // 未登录跳转到登录页
  if (!user) {
    redirectToLogin();
    return null;
  }

  return (
    <PrivacyShield>
      <View className="min-h-screen flex flex-col bg-background">
        {/* 顶部导航栏 */}
      <View
        className="flex items-center gap-3 px-3 py-3 bg-card border-b border-border"
        style={{ paddingTop: `${statusBarHeight + 12}px` }}
      >
        <View
          onClick={() => {
            handleHiddenClick();
            [DEV]('[chat] 点击页面内返回按钮,执行 navigateBack');
            Taro.navigateBack();
          }}
        >
          <View className="i-lucide-chevron-left w-6 h-6 text-foreground" />
        </View>
        <View
          onLongPress={handleClearAllMessages}
          className="flex-1 overflow-hidden"
        >
          <Text className="text-lg font-bold text-foreground truncate">{peerName}</Text>
        </View>
      </View>

      {/* 多选删除模式工具栏(加大按钮与间距,避免误触) */}
      {selectMode && (
        <View className="flex items-center gap-2 px-4 py-3 bg-secondary border-b border-border">
          <Text className="text-sm text-foreground flex-1">已选 {selectedIds.length} 条</Text>
          <View
            onClick={handleToggleSelectAll}
            className="px-5 py-3 rounded-lg bg-card border border-border active:bg-muted"
          >
            <Text className="text-base text-primary">
              {selectedIds.length === messages.length && messages.length > 0 ? '取消全选' : '全选'}
            </Text>
          </View>
          <View
            onClick={handleDeleteSelected}
            className={`px-6 py-3 rounded-lg ${selectedIds.length > 0 ? 'bg-destructive' : 'bg-muted'}`}
          >
            <Text className={`text-base font-medium ${selectedIds.length > 0 ? 'text-white' : 'text-muted-foreground'}`}>删除</Text>
          </View>
          <View
            onClick={exitSelectMode}
            className="px-5 py-3 rounded-lg bg-card border border-border active:bg-muted"
          >
            <Text className="text-base text-muted-foreground">取消</Text>
          </View>
        </View>
      )}

      {/* 消息区 */}
      <View className="flex-1">
        {loading && !msgLoaded ? (
          <View className="flex items-center justify-center py-20">
            <Text className="text-muted-foreground text-sm">加载中...</Text>
          </View>
        ) : messages.length === 0 ? (
          <View className="flex items-center justify-center py-20">
            <Text className="text-muted-foreground text-sm">开始聊天吧</Text>
          </View>
        ) : (
          <ScrollView
            scrollY
            scrollWithAnimation
            scrollTop={scrollTop}
            className="py-4"
            style={{
              // 键盘弹出时:视口 - 键盘高度 - 顶部导航(50px) - 底部输入区(130px)
              // 键盘未弹出:视口 - 顶部导航(50px) - 底部输入区(130px)
              // 在原始扣减值基础上加大48px(约1.5格):消息区变矮后,底部留白把最新消息
              // 从视口底缘向上顶起,自动滚到底时信息停留位置整体上移
              height: showEmojiPanel
                ? `calc(100vh - 278px)`
                : keyboardOffset > 0
                  ? `calc(100vh - ${keyboardOffset}px - 228px)`
                  : `calc(100vh - 228px)`,
              // 底部padding必须足够大,确保最后一条消息不被输入框遮挡
              paddingBottom: '140px'
            }}
            onClick={() => {
              // 长按抬手补发的click落在空白处:消费掉,不退出多选
              if (pendingLongPressRef.current) {
                [DEV]('[chat] 滚动区消费长按后的误触click');
                pendingLongPressRef.current = null;
                return;
              }
              // 兜底:触摸层已处理长按标志,此处兼容旧的长按标志位
              if (longPressFiredRef.current) {
                longPressFiredRef.current = false;
                return;
              }
              if (selectMode) {
                [DEV]('[chat] 多选模式:点击滚动区空白处退出');
                exitSelectMode();
                return;
              }
              [DEV]('[chat] 点击消息区域,隐藏键盘');
              setInputFocus(false);
            }}
            onScroll={() => {
              [DEV]('[chat] ScrollView滚动, keyboardOffset:', keyboardOffset);
            }}
          >
            <View className="w-full px-4">
              {messages.map((msg) => {
                const isMine = msg.sender_id === user.id;
                return (
                  <View
                    key={msg.id}
                    className={`flex mb-3 items-center gap-3 ${isMine ? 'justify-end' : 'justify-start'}`}
                    onClick={(e) => onMsgTapInSelectMode(msg.id, e)}
                  >
                    {/* 多选模式下的勾选框(视觉圆点不变,外层扩大点击热区并加高整行可点范围) */}
                    {selectMode && (
                      <View className="w-10 h-10 flex items-center justify-center shrink-0">
                        <View
                          className={`w-7 h-7 rounded-full border-2 flex items-center justify-center ${
                            selectedIds.includes(msg.id)
                              ? 'bg-primary border-primary'
                              : 'border-muted-foreground'
                          }`}
                        >
                          {selectedIds.includes(msg.id) && (
                            <View className="i-lucide-check w-4 h-4 text-white" />
                          )}
                        </View>
                      </View>
                    )}
                    {/* 消息内容(长按热区只包气泡+时间行,不覆盖整行两侧空白;
                        之前整行绑touchstart导致点消息旁空白也弹删除菜单) */}
                    <View
                      className="max-w-3/4"
                      onTouchStart={(e) => onMsgTouchStart(e, msg.id)}
                      onTouchMove={onMsgTouchMove}
                      onTouchEnd={onMsgTouchEnd}
                      onTouchCancel={onMsgTouchEnd}
                    >
                      <View
                        className={`rounded-2xl px-3 py-2 ${isMine ? 'bg-primary rounded-br-sm' : 'bg-card border border-border rounded-bl-sm'} ${
                          selectMode && selectedIds.includes(msg.id) ? 'opacity-80' : ''
                        }`}
                      >
                        {/* 引用回复气泡：展示被引消息内容快照，点击可定位原消息 */}
                        {msg.reply_to_id && (
                          <View
                            onClick={(e) => { e.stopPropagation(); onQuoteTap(msg.reply_to_id!); }}
                            className={`mb-1 rounded-lg px-2 py-1 ${isMine ? 'bg-white' : 'bg-muted'} ${isMine ? 'border-l-2 border-primary' : 'border-l-2 border-border'}`}
                          >
                            <Text className={`text-xs truncate ${isMine ? 'text-muted-foreground' : 'text-secondary-foreground'}`}>
                              {msg.reply_to_content || '[原消息]'}
                            </Text>
                          </View>
                        )}
                        {renderMessageContent(msg, isMine)}
                      </View>
                      <View className={`flex flex-row items-center gap-1 mt-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
                        <Text className="text-muted-foreground text-xs">
                          {formatTime(msg.created_at)}
                        </Text>
                        {/* 消息状态标识(仅自己发送的消息显示) */}
                        {isMine && (
                          <Text className={`text-xs ${msg.read_at ? 'text-primary' : 'text-muted-foreground'}`}>
                            {' '}· {msg.read_at ? '已读' : '未读'}
                          </Text>
                        )}
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}
      </View>

      {/* 表情面板(默认显示3行) */}
      {showEmojiPanel && (
        <View className="bg-card border-t border-border">
          <ScrollView scrollY className="py-3" style={{ height: '180px' }}>
            <View className="w-full px-3">
              <View className="grid grid-cols-6 gap-2">
                {emojis.map((emoji, index) => (
                  <View
                    key={index}
                    onClick={() => onSendEmoji(emoji)}
                    className="flex items-center justify-center h-12 bg-secondary rounded-lg active:bg-muted"
                  >
                    <Text className="text-2xl">{emoji}</Text>
                  </View>
                ))}
              </View>
            </View>
          </ScrollView>
        </View>
      )}

      {/* 录音状态提示 */}
      {isRecording && (
        <View style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <View className="bg-card rounded-2xl p-8 flex flex-col items-center gap-4">
            <View className="i-lucide-mic w-16 h-16 text-destructive animate-pulse" />
            <Text className="text-foreground text-lg font-bold">正在录音</Text>
            <Text className="text-muted-foreground text-2xl font-mono">
              {recordingDuration}s
            </Text>
            <View
              onClick={onStopRecording}
              className="mt-4 bg-destructive px-6 py-2 rounded-lg"
            >
              <Text className="text-destructive-foreground font-medium">点击停止</Text>
            </View>
          </View>
        </View>
      )}

      {/* 引用回复条(输入区上方) */}
      {replyTo && !selectMode && (
        <View className="flex flex-row items-center gap-2 px-3 py-2 bg-secondary border-t border-border">
          <View className="i-lucide-corner-up-left w-4 h-4 shrink-0 text-muted-foreground" />
          <Text className="text-xs text-muted-foreground flex-1 truncate">
            回复 {quoteSummary(replyTo)}
          </Text>
          <View
            onClick={(e) => { e.stopPropagation(); setReplyTo(null); }}
            className="w-6 h-6 flex items-center justify-center shrink-0"
          >
            <View className="i-lucide-x w-4 h-4 text-muted-foreground" />
          </View>
        </View>
      )}

      {/* 底部输入区 - 使用inline style确保H5端fixed定位生效 */}
      <View
        style={{
          position: 'fixed',
          bottom: keyboardOffset,
          left: 0,
          right: 0,
          backgroundColor: '#f7f7f7',
          borderTop: '1px solid #e5e5e5',
          zIndex: 100,
          // 键盘弹出时不需要安全区域padding,否则会有额外空白
          paddingBottom: keyboardOffset > 0 ? '0' : 'env(safe-area-inset-bottom)',
        }}
      >
        {/* 输入区域 - 一行布局:语音 | 输入框+麦克风 | 表情 | 加号 */}
        <Form onSubmit={onSendText}>
          <View className="flex flex-row items-center gap-2 px-3 py-2">
            {/* 语音按钮 */}
            <View
              onClick={(e) => { e.stopPropagation(); onSendVoice(); }}
              className="flex items-center justify-center w-9 h-9 rounded-full border-2 border-muted-foreground"
            >
              <View className="i-lucide-mic w-5 h-5 text-muted-foreground" />
            </View>

            {/* 输入框容器 */}
            <View className="flex-1 bg-white rounded-lg px-3 py-2 border border-border flex flex-row items-center gap-2">
              <Input
                ref={inputRef}
                className="flex-1 bg-transparent text-foreground"
                value={inputValue}
                focus={inputFocus}
                adjustPosition={false} // 禁用系统自动上推,改为手动监听键盘高度
                onInput={(e) => {
                  const newValue = e.detail.value;
                  [DEV]('[chat] 输入框内容变化:', newValue);
                  setInputValue(newValue);
                  resetInactivityTimer();
                }}
                onFocus={() => {
                  [DEV]('[chat] 输入框获得焦点');
                  setInputFocus(true);
                  resetInactivityTimer();
                }}
                onBlur={() => {
                  [DEV]('[chat] 输入框失去焦点,当前键盘偏移:', keyboardOffset);
                }}
                onClick={(e) => {
                  [DEV]('[chat] 输入框被点击,重置计时器');
                  e.stopPropagation();
                  resetInactivityTimer();
                }}
                placeholder="输入消息"
                placeholderClass="text-muted-foreground"
                confirmType="send"
                confirmHold // 点击键盘右下角"发送"键时保持键盘不收起
                onConfirm={onSendText}
              />
              {/* 输入框内的麦克风图标 - 点击触发语音 */}
              <View onClick={(e) => { e.stopPropagation(); onSendVoice(); }} className="flex items-center justify-center w-6 h-6 cursor-pointer">
                <View className="i-lucide-mic w-4 h-4 text-muted-foreground" />
              </View>
            </View>

            {/* 表情按钮已移除 */}

            {/* 加号按钮(图片上传) */}
            <View
              onClick={(e) => { e.stopPropagation(); handleSelectImage(); }}
              className={`flex items-center justify-center w-9 h-9 rounded-full border-2 border-muted-foreground ${uploading ? 'opacity-50' : ''}`}
            >
              <View className="i-lucide-plus w-5 h-5 text-muted-foreground" />
            </View>

            {/* 可见退出按钮(连续3次点击返回Ping页) */}
            <View
              onClick={(e) => { e.stopPropagation(); handleExitClick(); }}
              className="flex items-center justify-center w-9 h-9 rounded-full border-2 border-destructive bg-destructive/10"
            >
              <View className="i-lucide-log-out w-5 h-5 text-destructive" />
            </View>
          </View>
        </Form>
      </View>
      </View>
    </PrivacyShield>
  );
}
