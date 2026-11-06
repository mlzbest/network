import { supabase } from '@/supabase/client';

/**
 * 会话列表缩略图专用：把消息的 media_url（原图公开直链）换成服务端缩放后的小图地址。
 *
 * 为什么需要：chat-media 桶是 public，messages.media_url 存的是
 * `${supabaseUrl}/storage/v1/object/public/{bucket}/{path}` 原图直链。列表里 32×32 的
 * 小格子直接拉原图，滚动时流量与解码开销都被浪费（上一轮交付时明确留下的待完善项）。
 *
 * 做法：从 URL 反解出 bucket + path，再交给 storage 客户端 getPublicUrl({ transform })
 * 生成带缩放参数的地址。transform 在本依赖版本只支持 width/height/resize 三个字段
 * （无 quality/format），所以这里按 2x 设备像素取 64×64、cover 裁切。
 *
 * ⚠️ 全程纯同步、不发网络请求；任何解析失败都返回空串，由调用方降级回原图 URL，
 * 绝不能因为缩略图优化反而让列表画不出图。
 */

/** 缩略图边长（展示 32px × 2 倍屏） */
const THUMB_SIZE = 64;

/** Supabase Storage 公开读路径的固定前缀段 */
const PUBLIC_MARKER = '/storage/v1/object/public/';

/** 已生成过的 url → thumb 映射，避免每次渲染重复解析（同一批会话反复重渲染时省正则开销） */
const cache = new Map<string, string>();

/**
 * 从任意形态的媒体地址里反解 `{ bucket, path }`。
 * 兼容三种来源：标准 public 直链、签名链接（去掉 query 后同构）、以及历史脏数据里的裸 path。
 */
function parseMediaUrl(raw: string): { bucket: string; path: string } | null {
  const idx = raw.indexOf(PUBLIC_MARKER);
  if (idx >= 0) {
    const rest = raw.slice(idx + PUBLIC_MARKER.length);
    const clean = rest.split('?')[0].split('#')[0];
    const slash = clean.indexOf('/');
    if (slash <= 0 || slash === clean.length - 1) return null;
    return { bucket: clean.slice(0, slash), path: clean.slice(slash + 1) };
  }
  // 非直链形态：尝试当作 `bucket/path` 裸路径处理（仅取第一段作桶名）
  const bare = raw.split('?')[0].replace(/^\/+/, '');
  const slash = bare.indexOf('/');
  if (slash <= 0 || slash === bare.length - 1) return null;
  return { bucket: bare.slice(0, slash), path: bare.slice(slash + 1) };
}

/**
 * 生成列表缩略图地址。入参是 messages.media_url（或本地缓存快照里的同名字段）。
 * 返回空串表示「无法生成」，调用方应退回原图 URL 或不画缩略图。
 */
export function buildThumbUrl(mediaUrl: string | null | undefined): string {
  if (!mediaUrl) return '';
  const hit = cache.get(mediaUrl);
  if (hit !== undefined) return hit;

  let thumb = '';
  try {
    const parsed = parseMediaUrl(mediaUrl);
    if (parsed) {
      const { data } = supabase.storage
        .from(parsed.bucket)
        .getPublicUrl(parsed.path, {
          transform: { width: THUMB_SIZE, height: THUMB_SIZE, resize: 'cover' },
        });
      thumb = data?.publicUrl || '';
    }
  } catch (e) {
    console.warn('[thumb-url] ⚠️ 生成缩略图地址失败，调用方将降级:', e);
    thumb = '';
  }
  cache.set(mediaUrl, thumb);
  return thumb;
}
