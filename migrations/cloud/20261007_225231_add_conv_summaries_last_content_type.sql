-- 云端兼容版：原文件无 Supabase 专属依赖，直接保留。
DROP FUNCTION IF EXISTS public.get_conversation_summaries();

CREATE OR REPLACE FUNCTION public.get_conversation_summaries()
RETURNS TABLE (
 conversation_id UUID,
 visible_count BIGINT,
 unread_count BIGINT,
 last_visible_revoked BOOLEAN,
 last_visible_content TEXT,
 last_visible_content_type TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
 WITH mine AS (
 SELECT d.message_id FROM message_deletes d WHERE d.user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
 ),
 ranked AS (
 SELECT m.conversation_id,
 m.id,
 m.read_at,
 m.sender_id,
 m.revoked_at,
 m.content,
 m.content_type,
 ROW_NUMBER() OVER (
 PARTITION BY m.conversation_id
 ORDER BY m.created_at DESC, m.id DESC
 ) AS rn
 FROM messages m
 WHERE NOT EXISTS (SELECT 1 FROM mine x WHERE x.message_id = m.id)
 AND EXISTS (
 SELECT 1 FROM conversations c
 WHERE c.id = m.conversation_id
 AND (c.user1_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid()) OR c.user2_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid()))
 )
 AND NOT EXISTS (
 SELECT 1 FROM conversation_deletes cd
 WHERE cd.conversation_id = m.conversation_id AND cd.user_id IN (SELECT id FROM public.profiles WHERE openid = auth.uid())
 )
 )
 SELECT r.conversation_id,
 COUNT(*) AS visible_count,
 COUNT(*) FILTER (WHERE r.read_at IS NULL AND r.sender_id NOT IN (SELECT id FROM public.profiles WHERE openid = auth.uid())) AS unread_count,
 COALESCE(BOOL_OR(r.revoked_at IS NOT NULL) FILTER (WHERE r.rn = 1), FALSE) AS last_visible_revoked,
 MAX(r.content) FILTER (WHERE r.rn = 1) AS last_visible_content,
 MAX(r.content_type) FILTER (WHERE r.rn = 1) AS last_visible_content_type
 FROM ranked r
 GROUP BY r.conversation_id;
$$;