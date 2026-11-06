-- ============================================
-- 云端兼容版（方案 A：conversation_deletes RLS 走子查询）
-- 生成自：migrations/20260930_053420_create_conversation_deletes_table.sql
-- ============================================

CREATE TABLE IF NOT EXISTS public.conversation_deletes (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_deletes_user_id ON public.conversation_deletes (user_id);
CREATE INDEX IF NOT EXISTS idx_conversation_deletes_conv_id ON public.conversation_deletes (conversation_id);
ALTER TABLE public.conversation_deletes ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_conversation_deletes ON public.conversation_deletes FOR SELECT USING (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
);
CREATE POLICY users_insert_conversation_deletes ON public.conversation_deletes FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
);
CREATE POLICY users_delete_conversation_deletes ON public.conversation_deletes FOR DELETE USING (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
);
