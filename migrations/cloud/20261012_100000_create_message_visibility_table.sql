-- 云端兼容版：重复建表占位。
-- 20261012_073437_create_message_visibility_table.sql 已创建 message_visibility；
-- 此文件保留原迁移名以避免后续迁移断链，执行时仅做幂等检查。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'message_visibility'
  ) THEN
    RAISE NOTICE 'message_visibility missing; please ensure 20261012_073437 was applied';
  END IF;
END
$$;