-- 云端兼容版：放宽 message_visibility 的 INSERT 策略。
-- 会话参与者可为该消息创建自己名下的隐藏行；通过 profiles.openid 映射 auth.uid()。
DROP POLICY IF EXISTS senders_insert_message_visibility ON public.message_visibility;

CREATE POLICY participants_insert_message_visibility ON public.message_visibility
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.messages m
      JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.id = message_id
        AND (
          c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
          OR c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
        )
    )
  );