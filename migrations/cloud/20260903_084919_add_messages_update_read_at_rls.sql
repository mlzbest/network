-- ============================================
-- 云端兼容版（方案 A：messages read_at UPDATE RLS 走子查询）
-- 生成自：migrations/20260903_084919_add_messages_update_read_at_rls.sql
-- ============================================

CREATE POLICY users_update_read_at_messages ON public.messages
 FOR UPDATE USING (
 EXISTS (
 SELECT 1 FROM public.conversations c
 WHERE c.id = messages.conversation_id
 AND (
   c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
   OR c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
 )
 )
 );
