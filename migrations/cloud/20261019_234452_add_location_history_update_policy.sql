-- 云端兼容版：保留 user_location_history 的 UPDATE RLS，不再调用 uid()。
-- 通过 profiles.openid 将云端 auth.uid() 映射为业务 UUID。
CREATE POLICY location_history_update_own ON public.user_location_history
  FOR UPDATE USING (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  )
  WITH CHECK (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );