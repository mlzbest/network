import { create } from 'zustand';
import * as messagesApi from '@/api/messages';
import * as conversationsApi from '@/api/conversations';
import type { Message, MessageType } from '@/api/messages';
import { useAuthStore } from './auth-store';

interface MessagesState {
  /** 当前会话的消息列表 */
  messages: Message[];
  loading: boolean;
  loaded: boolean;
  /** 当前会话 id */
  conversationId: string | null;
  /** 加载历史消息 */
  fetchMessages: (conversationId: string) => Promise<void>;
  /** 发送消息（本地立即追加，不依赖 Realtime） */
  sendMessage: (
    conversationId: string,
    content: string,
    contentType?: MessageType,
    mediaUrl?: string,
  ) => Promise<Message>;
  /** 接收 Realtime 推送的新消息（来自对方） */
  receiveMessage: (message: Message) => void;
  /** 标记某会话中对方发来的消息为已读 */
  markAsRead: (conversationId: string) => Promise<void>;
  /** 软删除消息（仅从自己视图移除） */
  deleteMessage: (messageId: string) => Promise<void>;
  /** 批量软删除某会话的所有消息 */
  deleteAllMessages: (conversationId: string) => Promise<void>;
  reset: () => void;
}

export const useMessagesStore = create<MessagesState>((set, get) => ({
  messages: [],
  loading: false,
  loaded: false,
  conversationId: null,

  fetchMessages: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    if (get().loading) return;
    set({ loading: true, conversationId });
    try {
      const messages = await messagesApi.listMessages(conversationId, user.id);
      set({ messages, loaded: true });
    } catch (e) {
      console.error('[messages-store] 查询消息失败:', e);
    } finally {
      set({ loading: false });
    }
  },

  sendMessage: async (
    conversationId: string,
    content: string,
    contentType: MessageType = 'text',
    mediaUrl?: string,
  ) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    const message = await messagesApi.sendMessage(
      conversationId,
      user.id,
      content,
      contentType,
      mediaUrl,
    );
    // 本地立即追加，不依赖 Realtime
    set({ messages: [...get().messages, message] });
    // 更新会话最后消息（不阻塞发送）
    const summary = contentType === 'text' ? content : `[${contentType}]`;
    conversationsApi.updateLastMessage(conversationId, summary).catch((e) => {
      console.warn('[messages-store] 更新会话最后消息失败:', e);
    });
    return message;
  },

  receiveMessage: (message: Message) => {
    // 避免重复添加（自己发的消息已本地追加）
    const exists = get().messages.some((m) => m.id === message.id);
    if (exists) return;
    set({ messages: [...get().messages, message] });
  },

  markAsRead: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    try {
      await messagesApi.markMessagesAsRead(conversationId, user.id);
      // 本地同步: 将对方发来的未读消息标记为已读
      set({
        messages: get().messages.map((m) =>
          m.sender_id !== user.id && !m.read_at
            ? { ...m, read_at: new Date().toISOString() }
            : m,
        ),
      });
    } catch (e) {
      console.warn('[messages-store] 标记已读失败:', e);
    }
  },

  deleteMessage: async (messageId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    await messagesApi.deleteMessage(messageId, user.id);
    // 从本地视图移除
    set({ messages: get().messages.filter((m) => m.id !== messageId) });
  },

  deleteAllMessages: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    await messagesApi.deleteAllMessages(conversationId, user.id);
    // 清空本地视图
    set({ messages: [] });
  },

  reset: () => set({ messages: [], loading: false, loaded: false, conversationId: null }),
}));

// 登出时清空缓存
useAuthStore.subscribe((s, prev) => {
  if (prev.user && !s.user) useMessagesStore.getState().reset();
});
