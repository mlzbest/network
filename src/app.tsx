import Taro, { useLaunch } from '@tarojs/taro';
import { PropsWithChildren } from 'react';
import { supabase } from '@/supabase/client';
import { useAuthStore, warmupAuthStore } from '@/store/auth-store';
import { warmupProfilesStore } from '@/store/profiles-store';
import { useChatsStore } from '@/store/chats-store';
import { useMessagesStore } from '@/store/messages-store';
import '@/app.css';
import { recordHeartbeat } from '@/api/profiles';
// 冷启动即加载鉴权与资料 store 模块。注意：光靠副作用 import 是不够的——
// Rollup 会把「没有值被实际使用」的 import 摇掉，dist/app.js 里连公共 chunk 的
// require 都不会留下（上一轮就是这么失败的）。真正生效的是 useLaunch 里
// 对 warmup* 函数的调用 + 使用其返回值，形成不可消除的强引用。
import { noteBackground } from '@/lib/page-guard';
import { reportPresence, flushPendingPresence } from '@/lib/presence';
import { clearPresenceQueue } from '@/lib/presence-queue';
import { isInMediaPickerGrace, isInNativePreviewGrace } from '@/lib/shield-state';
import { patchRealtimeSocket } from '@/lib/realtime-socket-patch';
import { recordError } from '@/lib/error-log';
import { logDbg, logErr } from '@/lib/logger';
import { Preset } from './presets';

// ⚠️ 必须在模块顶层立即安装（不能只放在 useLaunch 里）：
// `src/supabase/client.ts` 在**模块加载时**就执行了 createClient()，realtime 实例
// 那一刻已经建好。补丁现在直接包装这个已存在的实例，越早装越好——放在 useLaunch
// 里虽然也能生效（实例是同一个），但顶层安装能覆盖「useLaunch 之前就发生的 close」。
patchRealtimeSocket();

/**
 * 把「未处理 Promise 拒绝」的 reason 转成可读字符串。
 *
 * 【为什么需要】`Taro.onUnhandledRejection` 的 `res.reason` 不一定是 Error 实例：
 * 微信/H5 底层常抛普通对象（`{ errMsg: 'xxx' }`）或字符串。直接 `logErr('...', reason)`
 * 时控制台只会显示 `object`，message/stack 全部丢失——排查「Importing a module script
 * failed.」这类问题时，日志里只剩 `未处理的 Promise 拒绝: object`，等于没有线索。
 * 这里按 Error → 常见字段 → JSON → String 的顺序逐级降级，保证任何 reason 都能打印出内容。
 */
const describeReason = (reason: unknown): string => {
  if (reason == null) return String(reason);
  if (reason instanceof Error) {
    const head = reason.stack?.split('\n')[0] ?? '';
    return head && head !== reason.message
      ? `${reason.name}: ${reason.message} | ${head}`
      : `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === 'object') {
    const obj = reason as Record<string, unknown>;
    const msg = obj.message ?? obj.errMsg ?? obj.reason ?? obj.msg;
    if (typeof msg === 'string' && msg) return msg;
    try {
      return JSON.stringify(reason).slice(0, 500);
    } catch {
      // 循环引用等无法序列化的情况，回退到 String()
      return String(reason);
    }
  }
  return String(reason);
};

const App = ({ children }: PropsWithChildren) => {
  // 构建版本探针 + 冷启动预热：日志顺序即诊断依据
  // 🚀 有 → dist 是最新的；🔥 有 → store 模块确实在 App 阶段执行了。
  useLaunch(() => {
    const uid = warmupAuthStore();
    const cached = warmupProfilesStore();
    console.log(
      `[app] 🚀 onLaunch 构建版本: 2026-09-27-C（page-guard 接管计时）过渡user=${uid ? '有' : '无'} / 缓存资料=${cached} 份`,
    );
    // ===== 轻量心跳（在线状态推断的写入侧）=====
    // 前台每 45 秒把 last_active_at 写进 profiles；切后台时微信冻结 JS 定时器、
    // 杀进程代码不执行——「不再写入」即离线信号，展示端按约 2 分钟超时判定离线。
    // 因此这里只需：登录态就绪才启动、回前台立即补写一次并重启、切后台/登出即停。
    let heartbeatTimer: any = null;
    const startHeartbeat = () => {
      const st = useAuthStore.getState();
      const hbUid = st.user?.id;
      if (!hbUid || st.bootstrapped) return; // 过渡 user 无 token，写了也会被 RLS 当匿名挡掉
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      void recordHeartbeat(hbUid);
      heartbeatTimer = setInterval(() => {
        const cur = useAuthStore.getState();
        if (!cur.user?.id || cur.bootstrapped) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          return;
        }
        void recordHeartbeat(cur.user.id);
      }, 45_000);
      console.log('[app] 💓 心跳定时器已启动(45s)');
    };
    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        console.log('[app] 💤 心跳定时器已停止');
      }
    };
    // auth 真值到达（bootstrapped→false 且有 user）即启动；登出即停
    // 缺陷②：真实登录态一到就补发此前未送达的 offline——过渡态无 token 写不进库，
    // 必须等真值，否则补发也会被 RLS 当匿名静默拦掉。
    useAuthStore.subscribe((s, prev) => {
      const realNow = !!s.user && !s.bootstrapped;
      const realPrev = !!prev.user && !prev.bootstrapped;
      if (realNow && !realPrev) {
        startHeartbeat();
        void flushPendingPresence();
      }
      if (!s.user && prev.user) {
        stopHeartbeat();
        // 登出清空队列：防止把上一个账号的「不在线」补发到下一个账号（串号）
        clearPresenceQueue();
      }
    });
    if (useAuthStore.getState().user && !useAuthStore.getState().bootstrapped) {
      startHeartbeat();
      void flushPendingPresence();
    }

    // ===== 全局 messages Realtime 订阅（解决消息接收延迟问题）=====
    // 根因：此前 Realtime 订阅只在聊天页/会话列表页建立，用户在其他页面时收不到新消息推送。
    // 方案：App 级建立全局订阅，监听所有 messages INSERT 事件，收到后触发 chats-store 刷新。
    let globalMessagesChannel: any = null;
    const startGlobalMessagesRealtime = () => {
      const st = useAuthStore.getState();
      if (!st.user?.id || st.bootstrapped) return; // 过渡态无 token，订阅会被 RLS 当匿名挡掉

      // 先停掉旧订阅（防止重复建立）
      if (globalMessagesChannel) {
        try {
          supabase.removeChannel(globalMessagesChannel);
        } catch (e) {
          logDbg('[app] ⚠️ 移除旧 messages 通道失败:', e);
        }
      }

      globalMessagesChannel = supabase.channel('messages-global-realtime');
      globalMessagesChannel
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages' },
          (payload) => {
            const newMsg = payload.new as any;
            const sentAt = new Date(newMsg.created_at).getTime();
            const latencyMs = Date.now() - sentAt;
            logDbg(`[app] ⚡ 全局 Realtime 收到新消息: ${newMsg.id.substring(0, 8)}... 会话 ${newMsg.conversation_id.substring(0, 8)}... 发送者 ${newMsg.sender_id.substring(0, 8)}... 延迟 ${latencyMs}ms`);

            // 触发 chats-store 刷新会话列表（含未读数更新）
            const fetchConversations = useChatsStore.getState().fetchConversations;
            if (fetchConversations) {
              logDbg('[app] 🔄 触发 chats-store 刷新会话列表');
              void fetchConversations(true); // force=true 跳过在途请求复用
            }

            // 如果当前正在聊天详情页，且消息属于该会话，触发 messages-store 接收
            try {
              const pages = Taro.getCurrentPages();
              const currentPage = pages[pages.length - 1];
              if (currentPage?.route === 'pages/chat/index') {
                const currentConvId = (currentPage as any).$instance?.data?.conversationId;
                if (currentConvId === newMsg.conversation_id) {
                  logDbg('[app] 📩 当前在聊天页，触发 messages-store 接收消息');
                  const receiveMessage = useMessagesStore.getState().receiveMessage;
                  if (receiveMessage) {
                    receiveMessage(newMsg);
                  }
                }
              }
            } catch (e) {
              logDbg('[app] ⚠️ 检查当前页面失败:', e);
            }
          },
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            logDbg('[app] ✅ 全局 messages Realtime 订阅已建立');
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn(`[app] ⚠️ 全局 messages Realtime 订阅异常: ${status}`);
          }
        });
    };

    const stopGlobalMessagesRealtime = () => {
      if (globalMessagesChannel) {
        try {
          supabase.removeChannel(globalMessagesChannel);
          globalMessagesChannel = null;
          logDbg('[app] 📴 已取消全局 messages Realtime 订阅');
        } catch (e) {
          logDbg('[app] ⚠️ 取消全局 messages 通道失败:', e);
        }
      }
    };

    // auth 真值到达即启动全局订阅；登出即停
    useAuthStore.subscribe((s, prev) => {
      const realNow = !!s.user && !s.bootstrapped;
      const realPrev = !!prev.user && !prev.bootstrapped;
      if (realNow && !realPrev) {
        startGlobalMessagesRealtime();
      }
      if (!s.user && prev.user) {
        stopGlobalMessagesRealtime();
      }
    });

    // 冷启动时如果已有登录态，立即启动
    if (useAuthStore.getState().user && !useAuthStore.getState().bootstrapped) {
      startGlobalMessagesRealtime();
    }

    // App 级注册切后台事件：page-guard 用它与各页 didHide 配对，
    // 区分「切后台导致的 hide」（保留 120 秒起点，回前台补判）与
    // 「导航离开导致的 hide」（作废旧起点，新页全新起表）。
    Taro.onAppHide(() => {
      console.log('[app] 🌙 onAppHide — 通知 page-guard 记录切后台时刻 + 停心跳 + 上报不在当前');
      noteBackground();
      stopHeartbeat();
      // 切入微信后台 = 「不在当前」。页面级 didHide 也会写 away，两者同值不冲突；
      // 若用户随后退回 ping 页，退场出口会用 offline 覆盖（offline 不参与抑制）。
      // ⚠️ 豁免：previewImage 全屏预览与相册/相机系统面板也会触发 App 级 onAppHide，
      // 用户其实仍停留在聊天页内活动——此时写 away 会让对方看到假的「不在当前」
      // （用户实测报过）。shield-state 的两套豁免计数正是为此而生，presence 必须共用。
      if (isInNativePreviewGrace() || isInMediaPickerGrace()) {
        console.log('[presence] 🛡 onAppHide 命中系统面板/原生预览豁免，跳过 away 上报');
        return;
      }
      reportPresence('away');
    });
    Taro.onAppShow(() => {
      logDbg('[app] ☀️ onAppShow — 各页 didShow 将按已流逝时长补判/续跑 + 恢复心跳');
      startHeartbeat();
      // 缺陷②：回前台是网络最可能已恢复的时刻，顺手补发未送达的 offline
      void flushPendingPresence();
    });

    // ===== App 级错误兜底（记录侧）=====
    // 与页面级 ErrorBoundary 的分工：ErrorBoundary 拦「渲染阶段抛错」并能阻止白屏；
    // 这里拦「异步未捕获错误」——错误已经发生、拦不住白屏，但必须留下记录，
    // 否则用户反馈「页面白屏/点了没反应」时我们手上没有任何线索。
    // ⚠️ 只记录、不做任何 UI 干预：崩溃时弹 toast 会打断用户，且可能触发二次错误。
    const currentRoute = (): string => {
      try {
        const pages = Taro.getCurrentPages();
        return pages[pages.length - 1]?.route || '';
      } catch {
        return '';
      }
    };
    Taro.onError((err) => {
      recordError({ route: currentRoute(), error: err });
      logErr('[app] 💥 未捕获的脚本错误:', err);
    });
    Taro.onUnhandledRejection((res) => {
      recordError({ route: currentRoute(), error: res?.reason });
      logErr('[app] 💥 未处理的 Promise 拒绝:', describeReason(res?.reason));
    });
  });
  return <Preset>{children}</Preset>;
};

export default App;
