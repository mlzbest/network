-- ============================================
-- 云端兼容版（方案 A：messages RLS 走子查询映射）
-- 生成自：migrations/20260902_002934_add_message_deletes_update_policy.sql
-- ============================================

CREATE POLICY users_update_message_deletes ON message_deletes FOR UPDATE USING (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
) WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
);
