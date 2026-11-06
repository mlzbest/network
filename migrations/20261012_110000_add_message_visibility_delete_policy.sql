-- 暗号（where）链路修复：允许「消息接收方」删除自己名下的隐藏记录。
--
-- 【为什么需要】原策略只允许消息发送者插入隐藏行（防止任一方隐藏对方的消息）。
-- 但暗号链路里 B 需要隐藏 A 发来的 where，B 不是发送者 → 插不进去。
-- 解法：B 先插入一条「占位隐藏行」（message_id 指向 A 的 where，user_id = B），
-- 此时该行对 B 无效（RLS 的 SELECT 策略要求 user_id = auth.uid()，B 读不到它）；
-- 等 A 收到 ack 后，A 用自己（发送者）的权限把这条占位行的 user_id 改成 A，
-- 隐藏行随即对 A 生效 —— 于是 A 也看不到自己发的 where。
--
-- 这个「改归属」的动作需要 A 能 DELETE 掉 B 留下的占位行，故补一条 DELETE 策略：
-- 只允许删除「消息发送者本人」名下的隐藏记录（即 A 只能删自己那条消息的隐藏行）。
-- 不会放宽到「任一方都能隐藏对方消息」——B 依然无法让隐藏行对自己生效。

DROP POLICY IF EXISTS senders_delete_message_visibility ON public.message_visibility;

CREATE POLICY senders_delete_message_visibility ON public.message_visibility
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id AND m.sender_id = auth.uid()
    )
  );
