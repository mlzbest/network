-- ============================================
-- 云端兼容版（方案 A：messages DELETE RLS 走子查询）
-- 生成自：migrations/20260904_005328_add_messages_delete_policy.sql
-- ============================================

CREATE POLICY users_delete_messages ON messages FOR DELETE USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
    AND (
      c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
      OR c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    )
  )
)
