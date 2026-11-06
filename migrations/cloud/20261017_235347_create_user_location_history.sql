-- ============================================
-- 云端兼容版（方案 A：user_location_history RLS 走子查询）
-- 生成自：migrations/20261017_235347_create_user_location_history.sql
-- ============================================

CREATE TABLE IF NOT EXISTS public.user_location_history (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 lat DOUBLE PRECISION NOT NULL,
 lng DOUBLE PRECISION NOT NULL,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_location_history_user_recorded ON public.user_location_history (user_id, recorded_at DESC);
ALTER TABLE public.user_location_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_history_select_all ON public.user_location_history;
CREATE POLICY location_history_select_all ON public.user_location_history FOR SELECT USING (true);
DROP POLICY IF EXISTS location_history_insert_own ON public.user_location_history;
CREATE POLICY location_history_insert_own ON public.user_location_history FOR INSERT WITH CHECK (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
);
DROP POLICY IF EXISTS location_history_delete_own ON public.user_location_history;
CREATE POLICY location_history_delete_own ON public.user_location_history FOR DELETE USING (
  user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
);
