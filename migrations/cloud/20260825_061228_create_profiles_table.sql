-- ============================================
-- 云端兼容版（方案 A：保留 UUID 业务主键，auth.uid() 字符串映射到 profiles.openid）
-- 生成自：migrations/20260825_061228_create_profiles_table.sql
-- ============================================
--
-- 关键改写点（相对 Supabase 原版）：
--   1. 主键不再 REFERENCES auth.users(id)（云端 auth.users 结构未公开、id 类型未知）
--      → 改为业务主键 UUID，openid TEXT UNIQUE 承载云端 auth.uid() 字符串
--   2. 加 openid 索引（RLS 子查询 JOIN profiles 全靠它）
--   3. RLS 的 auth.uid() = id 全部改成子查询：
--      id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
--
-- 触发器 handle_new_user 在云端改为「前端登录函数」负责（见 0001 注释占位）。

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY,
  username TEXT UNIQUE,
  openid TEXT UNIQUE,
  unionid TEXT UNIQUE,
  nickname TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_openid ON public.profiles (openid);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 所有人可读（chat 列表等展示场景需要）
CREATE POLICY users_select_profiles ON public.profiles
 FOR SELECT USING (true);

-- 用户只能更新自己的 profile（通过 openid 反查 id）
CREATE POLICY users_update_own_profile ON public.profiles
 FOR UPDATE USING (
   id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
 ) WITH CHECK (
   id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
 );
