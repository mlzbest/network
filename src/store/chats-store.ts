import { create } from 'zustand';
import * as conversationsApi from '@/api/conversations';
import * as profilesApi from '@/api/profiles';
import type { ConversationWithPeer } from '@/api/conversations';
import type { Profile } from '@/api/profiles';
import { useAuthStore } from './auth-store';

interface ChatsState {
  /** 当前用户的会话列表 */
  conversations: ConversationWithPeer[];
  /** 所有用户资料（用于用户列表选人发起聊天） */
  profiles: Profile[];
  loading: boolean;
  loaded: boolean;
  fetchConversations: () => Promise<void>;
  fetchProfiles: () => Promise<void>;
  /** 发起聊天：获取或创建会话，返回会话 id */
  startChat: (peerId: string) => Promise<string>;
  /** 删除会话及其所有消息 */
  deleteConversation: (conversationId: string) => Promise<void>;
  reset: () => void;
}

export const useChatsStore = create<ChatsState>((set, get) => ({
  conversations: [],
  profiles: [],
  loading: false,
  loaded: false,

  fetchConversations: async () => {
    const user = useAuthStore.getState().user;
    if (!user) return;
    if (get().loading) return;
    set({ loading: true });
    try {
      const conversations = await conversationsApi.listConversations(user.id);
      set({ conversations, loaded: true });
    } catch (e) {
      console.error('[chats-store] 查询会话失败:', e);
    } finally {
      set({ loading: false });
    }
  },

  fetchProfiles: async () => {
    try {
      const profiles = await profilesApi.listProfiles();
      set({ profiles });
    } catch (e) {
      console.error('[chats-store] 查询用户资料失败:', e);
    }
  },

  startChat: async (peerId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    const conversation = await conversationsApi.getOrCreateConversation(user.id, peerId);
    // 刷新会话列表
    get().fetchConversations();
    return conversation.id;
  },

  deleteConversation: async (conversationId: string) => {
    const user = useAuthStore.getState().user;
    if (!user) throw new Error('未登录');
    console.log('[chats-store] 开始删除会话:', conversationId);
    await conversationsApi.deleteConversation(conversationId, user.id);
    console.log('[chats-store] 会话已从数据库删除,重新拉取列表');
    // 重新从服务器拉取最新列表,确保数据一致性
    await get().fetchConversations();
  },

  reset: () => set({ conversations: [], profiles: [], loading: false, loaded: false }),
}));

// 登出时清空缓存
useAuthStore.subscribe((s, prev) => {
  if (prev.user && !s.user) useChatsStore.getState().reset();
});
