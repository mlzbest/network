-- 云端兼容版：原文件无 Supabase 专属依赖，直接保留。
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS presence_state TEXT,
  ADD COLUMN IF NOT EXISTS presence_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.presence_state IS '页面级在场状态: online(聊天区三页) / away(切后台或离开当前页) / offline(退回ping页)';
COMMENT ON COLUMN public.profiles.presence_at IS 'presence_state 的写入时刻，展示端按超时兜底降级';

CREATE INDEX IF NOT EXISTS idx_profiles_presence
  ON public.profiles (id, presence_at DESC);