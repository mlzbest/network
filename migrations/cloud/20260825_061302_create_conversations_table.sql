-- ============================================
-- 云端兼容版（方案 A：RLS 子查询映射 auth.uid() 字符串 → profiles.openid）
-- 生成自：migrations/20260825_061302_create_conversations_table.sql
-- ============================================

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user2_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_message TEXT,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 确保两用户之间只有一个会话（无论谁是 user1 谁是 user2）
CREATE UNIQUE INDEX IF NOT EXISTS conversations_pair_unique_idx
  ON public.conversations (
    LEAST(user1_id, user2_id),
    GREATEST(user1_id, user2_id)
  );

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己参与的会话（子查询：auth.uid() 字符串 → profiles.openid → profiles.id）
CREATE POLICY users_select_conversations ON public.conversations
  FOR SELECT USING (
    user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    OR user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

-- 用户可以创建会话（发起聊天）
CREATE POLICY users_insert_conversations ON public.conversations
  FOR INSERT WITH CHECK (
    user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    OR user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

-- 用户可以更新自己参与的会话（更新最后消息）
CREATE POLICY users_update_conversations ON public.conversations
  FOR UPDATE USING (
    user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    OR user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );
