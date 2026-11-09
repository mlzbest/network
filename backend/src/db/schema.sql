-- ============================================================================
-- 检测网络 · 自建后端数据库结构（依据 src/supabase/types.ts 反推的真实结构）
-- ----------------------------------------------------------------------------
-- 本文件与 Meoo Cloud 自动生成的 types.ts 一一对应：列名 / 类型 / 外键 / 函数
-- 签名均与生产库一致。最终仍建议以 Meoo Cloud 的 `pg_dump --schema-only` 为权威
-- 来源做一次 diff 校正（尤其是触发器、默认值、NOT NULL、额外索引）。
--
-- 初始化空库： psql "$DATABASE_URL" -f src/db/schema.sql
-- 灌入存量数据： pg_dump "$MEOO_DATABASE_URL" --data-only --no-owner \
--                 -t profiles -t conversations -t conversation_deletes \
--                 -t messages -t message_deletes -t message_visibility \
--                 -t login_events -t user_location_history -t user_we_run_steps \
--               | psql "$DATABASE_URL"
--   ⚠️ 存量数据迁过来后，老账号需重新登录（JWT 密钥变了，旧 token 失效，数据不丢）。
-- ============================================================================

-- gen_random_uuid() 自 PostgreSQL 13 起为内置函数，不再需要 pgcrypto 扩展。
-- 不依赖任何扩展，也意味着本文件可直接在 PGlite（WASM 版 PG）里执行。

-- ----------------------------------------------------------------------------
-- profiles：身份 + 资料（自建后 id 即用户主键，同时作为会话/消息参与者标识）
--   对应原 Supabase 的 auth.users + profiles 合并；`openid/unionid` 预留微信绑定。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username                  text UNIQUE,
  email                     text UNIQUE,
  avatar_url                text,
  nickname                  text,
  openid                    text,
  unionid                   text,
  hide_presence             boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  last_active_at            timestamptz,
  last_lat                  double precision,
  last_lng                  double precision,
  last_location_at          timestamptz,
  last_login_at             timestamptz,
  last_logout_at            timestamptz,
  last_seen_boundary_at     timestamptz,
  presence_at               timestamptz,
  presence_state            text,
  recovery_sent_at          timestamptz,
  recovery_token_hash       text,
  -- 自研鉴权专用：scrypt 口令哈希。仅后端 auth 层直连读取，
  -- 列白名单（schema-map.ts）刻意不含此列，杜绝经 /api/db 外泄。
  password_hash             text,
  -- 兼容迁移期：保留占位邮箱标记（'1' 表示 email 是 {username}@meoo.local 占位）
  -- 实际字段不存在于原 schema，这里用 recovery 字段之外的扩展列承载，见 README。
  CONSTRAINT username_or_email CHECK (username IS NOT NULL OR email IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- conversations：双人会话
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user1_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user2_id       uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  last_message   text,
  last_message_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_distinct CHECK (user1_id <> user2_id)
);
CREATE INDEX IF NOT EXISTS idx_conversations_participants
  ON conversations(user1_id, user2_id);

-- 软删除：任一方标记删除
CREATE TABLE IF NOT EXISTS conversation_deletes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_deletes_conv ON conversation_deletes(conversation_id);

-- ----------------------------------------------------------------------------
-- messages
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content          text NOT NULL,
  content_type     text NOT NULL DEFAULT 'text',  -- text | image | voice | emoji | file ...
  media_url        text,
  reply_to_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  reply_to_content text,
  delivered_at     timestamptz,
  read_at          timestamptz,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- 消息级软删除（单用户对单条）
CREATE TABLE IF NOT EXISTS message_deletes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_deletes_msg ON message_deletes(message_id);

-- 消息可见性（按用户控制，例如对某侧隐藏）
CREATE TABLE IF NOT EXISTS message_visibility (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_visibility_msg ON message_visibility(message_id);

-- ----------------------------------------------------------------------------
-- 其他业务表
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  logged_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events(user_id, logged_at);

CREATE TABLE IF NOT EXISTS user_location_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  name         text,
  address      text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_location_user ON user_location_history(user_id, recorded_at);

CREATE TABLE IF NOT EXISTS user_we_run_steps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  day        date NOT NULL,
  steps      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day)
);

-- ----------------------------------------------------------------------------
-- 触发器：消息写入/撤回时维护会话的 last_message / last_message_at 冗余快照
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_conversation_last_message()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  conv_id uuid;
  latest  record;
BEGIN
  conv_id := COALESCE(NEW.conversation_id, OLD.conversation_id);
  SELECT content, created_at INTO latest
  FROM messages
  WHERE conversation_id = conv_id
  ORDER BY created_at DESC NULLS LAST
  LIMIT 1;
  UPDATE conversations
  SET last_message = COALESCE(latest.content, NULL),
      last_message_at = COALESCE(latest.created_at, NULL)
  WHERE id = conv_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_last ON messages;
CREATE TRIGGER trg_messages_last
  AFTER INSERT OR UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION refresh_conversation_last_message();

-- ============================================================================
-- RPC 函数（替代原 Supabase 的 Postgres 函数；自研时用 p_user_id 替代 auth.uid()）
-- ============================================================================

-- 会话摘要：给定用户，返回其所有「未软删除」会话的可见消息统计 + 最后一条可见消息。
-- 对应 get_conversation_summaries()，前端用它与 conversations 行并行拉取后合并。
CREATE OR REPLACE FUNCTION get_conversation_summaries(p_user_id uuid)
RETURNS TABLE (
  conversation_id          uuid,
  visible_count            bigint,
  unread_count             bigint,
  last_visible_revoked     boolean,
  last_visible_content     text,
  last_visible_content_type text,
  last_visible_media_url   text
) LANGUAGE sql STABLE AS $$
  SELECT
    c.id AS conversation_id,
    COALESCE(v.cnt, 0) AS visible_count,
    COALESCE(u.cnt, 0) AS unread_count,
    COALESCE(lv.revoked, false) AS last_visible_revoked,
    lv.content AS last_visible_content,
    lv.content_type AS last_visible_content_type,
    lv.media_url AS last_visible_media_url
  FROM conversations c
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt FROM messages m
    WHERE m.conversation_id = c.id
      AND NOT EXISTS (
        SELECT 1 FROM message_deletes md
        WHERE md.message_id = m.id AND md.user_id = p_user_id)
  ) v ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt FROM messages m
    WHERE m.conversation_id = c.id
      AND m.sender_id <> p_user_id
      AND m.read_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM message_deletes md
        WHERE md.message_id = m.id AND md.user_id = p_user_id)
  ) u ON true
  LEFT JOIN LATERAL (
    SELECT m.revoked_at IS NOT NULL AS revoked, m.content, m.content_type, m.media_url
    FROM messages m
    WHERE m.conversation_id = c.id
      AND NOT EXISTS (
        SELECT 1 FROM message_deletes md
        WHERE md.message_id = m.id AND md.user_id = p_user_id)
    ORDER BY m.created_at DESC NULLS LAST
    LIMIT 1
  ) lv ON true
  WHERE (c.user1_id = p_user_id OR c.user2_id = p_user_id)
    AND NOT EXISTS (
      SELECT 1 FROM conversation_deletes cd
      WHERE cd.conversation_id = c.id AND cd.user_id = p_user_id)
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC;
$$;

-- 双向软删除后彻底清除会话（仅当双方都标记删除）。
-- 对应 purge_conversation_if_both_deleted(_conversation_id)，SECURITY DEFINER 等价体。
CREATE OR REPLACE FUNCTION purge_conversation_if_both_deleted(_conversation_id uuid)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  u1 uuid;
  u2 uuid;
  d1 boolean;
  d2 boolean;
BEGIN
  SELECT user1_id, user2_id INTO u1, u2
  FROM conversations WHERE id = _conversation_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- 调用方已先行写入自己的删除标记；这里只判定双方是否都已标记
  SELECT EXISTS (
    SELECT 1 FROM conversation_deletes
    WHERE conversation_id = _conversation_id AND user_id = u1) INTO d1;
  SELECT EXISTS (
    SELECT 1 FROM conversation_deletes
    WHERE conversation_id = _conversation_id AND user_id = u2) INTO d2;

  IF d1 AND d2 THEN
    DELETE FROM messages WHERE conversation_id = _conversation_id;
    DELETE FROM conversation_deletes WHERE conversation_id = _conversation_id;
    DELETE FROM conversations WHERE id = _conversation_id;
    RETURN true;
  END IF;
  RETURN false;
END;
$$;
