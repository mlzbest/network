-- 云端兼容版：保留 login_events 表与 profiles.last_seen_boundary_at 列。
-- RLS 的 INSERT 策略通过 profiles.openid 映射当前 auth.uid()。
CREATE TABLE IF NOT EXISTS public.login_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_events_user_logged ON public.login_events (user_id, logged_at DESC);

ALTER TABLE public.login_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS login_events_select_all ON public.login_events;
CREATE POLICY login_events_select_all ON public.login_events FOR SELECT USING (true);

DROP POLICY IF EXISTS login_events_insert_own ON public.login_events;
CREATE POLICY login_events_insert_own ON public.login_events
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_seen_boundary_at TIMESTAMPTZ;