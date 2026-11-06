-- ============================================
-- 云端兼容版（方案 A：保留 CREATE TABLE + 3 条 RLS，删 Realtime publication，RLS 走子查询）
-- 生成自：migrations/20260825_061319_create_messages_table.sql
-- ============================================

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON public.messages (conversation_id, created_at DESC);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己参与的会话的消息（子查询映射 auth.uid() → profiles.openid）
CREATE POLICY users_select_messages ON public.messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
      AND (
        c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
        OR c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
      )
    )
  );

-- 用户只能在自己参与的会话中发消息
CREATE POLICY users_insert_messages ON public.messages
  FOR INSERT WITH CHECK (
    sender_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
      AND (
        c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
        OR c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
      )
    )
  );

-- 云端 Realtime 通道未公开，supabase_realtime PUBLICATION 不存在。
-- 原 Supabase 专属：ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
-- 实时推送改由前端自写 broadcast / 轮询（见 src/lib/realtime-socket-patch.ts 注释占位）。
