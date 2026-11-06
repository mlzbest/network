-- ============================================
-- 云端兼容版（方案 A：RLS 子查询映射 auth.uid() 字符串 → profiles.openid）
-- 生成自：migrations/20260825_061335_create_message_deletes_table.sql
-- ============================================

CREATE TABLE IF NOT EXISTS public.message_deletes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, user_id)
);

ALTER TABLE public.message_deletes ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己删除的记录
CREATE POLICY users_select_message_deletes ON public.message_deletes
  FOR SELECT USING (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

-- 用户只能创建自己的删除记录
CREATE POLICY users_insert_message_deletes ON public.message_deletes
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

-- 用户只能删除自己的删除记录（恢复用）
CREATE POLICY users_delete_message_deletes ON public.message_deletes
  FOR DELETE USING (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );
