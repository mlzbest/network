-- 云端兼容版：允许消息发送者本人删除其名下隐藏记录。
-- 通过 profiles.openid 将云端 auth.uid() 映射为业务 UUID。
DROP POLICY IF EXISTS senders_delete_message_visibility ON public.message_visibility;

CREATE POLICY senders_delete_message_visibility ON public.message_visibility
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND m.sender_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
    )
  );