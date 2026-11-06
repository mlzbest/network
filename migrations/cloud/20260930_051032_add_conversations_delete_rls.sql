-- ============================================
-- 云端兼容版（方案 A：conversations DELETE RLS 走子查询）
-- 生成自：migrations/20260930_051032_add_conversations_delete_rls.sql
-- ============================================

CREATE POLICY users_delete_conversations ON public.conversations
 FOR DELETE
 USING (
   user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
   OR user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
 );
