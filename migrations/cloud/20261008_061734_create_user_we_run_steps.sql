-- ============================================
-- 云端兼容版（方案 A：user_we_run_steps 引用 profiles，RLS 走子查询）
-- 生成自：migrations/20261008_061734_create_user_we_run_steps.sql
-- ============================================
-- 改写点：
--   1. user_id UUID NOT NULL REFERENCES auth.users(id) → REFERENCES public.profiles(id)
--      （云端 auth.users 结构未公开，业务主键统一挂到 profiles.id）
--   2. RLS 的 auth.uid() = user_id → 子查询映射 auth.uid() 字符串 → profiles.openid → profiles.id

-- 微信运动每日步数：支撑「每天运动步数对比」
-- 每人每天一行，(user_id, day) 复合唯一，供 net-diagnose 云函数的步数通道 upsert。
CREATE TABLE IF NOT EXISTS public.user_we_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_we_run_steps_user_day_key UNIQUE (user_id, day)
);

CREATE INDEX IF NOT EXISTS idx_user_we_run_steps_user_day
  ON public.user_we_run_steps (user_id, day DESC);

ALTER TABLE public.user_we_run_steps ENABLE ROW LEVEL SECURITY;

-- 本人可读写自己的行（upsert 的 insert/update/delete 三种 cmd 都覆盖到）
CREATE POLICY users_select_own_steps ON public.user_we_run_steps
  FOR SELECT USING (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

CREATE POLICY users_insert_own_steps ON public.user_we_run_steps
  FOR INSERT WITH CHECK (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

CREATE POLICY users_update_own_steps ON public.user_we_run_steps
  FOR UPDATE USING (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  ) WITH CHECK (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

CREATE POLICY users_delete_own_steps ON public.user_we_run_steps
  FOR DELETE USING (
    user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
  );

-- 聊天对象可读：仅当读取者是某条双人会话的参与者、且该行属于该会话的另一方。
-- 与 profiles「所有人可读」口径不同——步数是健康类数据，收紧到「只有 TA 的聊天对象能看」。
CREATE POLICY peers_select_conversation_steps ON public.user_we_run_steps
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE (
          (c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid()) AND c.user2_id = user_we_run_steps.user_id)
          OR (c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid()) AND c.user1_id = user_we_run_steps.user_id)
        )
    )
  );
