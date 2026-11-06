/**
 * 文件消息（content_type='file'）的展示与打开辅助。
 *
 * 约定：content 存「原始文件名」，media_url 存 chat-media 桶的公开下载地址。
 * 上传时存储路径是随机生成名（fs-xxx.pdf），真实文件名只留在消息 content 里，
 * 所以展示、下载、openDocument 都必须以 content 的文件名为准。
 */

import Taro from '@tarojs/taro';
import { isH5 } from '@/lib/platform';
import { uploadToSupabase, getMimeType } from '@/lib/upload';
import type { FileInput } from '@/lib/upload';
import { supabaseUrl } from '@/supabase/client';
import { setMediaPickerGrace, endMediaPickerGrace } from '@/lib/shield-state';
import { logDbg } from './logger';

/** 人类可读的文件大小（B / KB / MB，保留一位小数） */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 从文件名取小写扩展名（无扩展名返回空串） */
export function fileExtOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/**
 * 按扩展名选图标类名。
 * ⚠️ 必须全部写成字面量分支：Tailwind 扫描不到动态拼接的 `i-lucide-${x}`，会漏打包图标。
 */
export function fileIconClass(name: string): string {
  const ext = fileExtOf(name);
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'svg'].includes(ext)) return 'i-lucide-image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return 'i-lucide-video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) return 'i-lucide-music';
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return 'i-lucide-archive';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'i-lucide-sheet';
  if (['doc', 'docx'].includes(ext)) return 'i-lucide-file-text';
  if (['ppt', 'pptx'].includes(ext)) return 'i-lucide-presentation';
  if (ext === 'pdf') return 'i-lucide-file-type';
  return 'i-lucide-file';
}

/** openDocument 支持的类型；微信端不支持打开的扩展名直接提示到外部查看 */
const OPEN_DOC_EXTS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'];

/**
 * 上传文件到 chat-media 桶（沿用图片/语音同款 uploadToSupabase 链路，不压缩、不改名内容）。
 * 返回公开下载地址与真实体积。
 */
export async function uploadChatFile(
  file: FileInput,
  fileName: string,
): Promise<{ url: string; size: number }> {
  const ext = fileExtOf(fileName);
  const path = `fs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${ext ? `.${ext}` : ''}`;
  const result = await uploadToSupabase(file, { bucket: 'chat-media', overridePath: path });
  if (!result.success || !result.data?.path) throw new Error(result.error || '文件上传失败');
  const url = `${supabaseUrl}/storage/v1/object/public/chat-media/${result.data.path}`;
  logDbg('[file] ✅ 文件已上传:', url.slice(0, 80));
  return { url, size: file.size };
}

/** 点开气泡时按 URL 探测真实体积（HEAD 在小程序不支持，用 Range 只取 1 字节读 content-range） */
const sizeCache = new Map<string, number>();

async function probeFileSize(url: string): Promise<number> {
  const hit = sizeCache.get(url);
  if (hit) return hit;
  try {
    const res = await Taro.request({
      url,
      method: 'GET',
      header: { Range: 'bytes=0-0' },
      timeout: 8000,
      // 只要头不要体
      responseType: 'text',
    } as any);
    const cr = String((res.header && ((res.header['content-range'] || res.header['Content-Range']))) || '');
    const m = /\/(\d+)\s*$/.exec(cr);
    const len = m ? Number(m[1]) : Number(res.header?.['content-length'] || res.header?.['Content-Length'] || 0);
    if (Number.isFinite(len) && len > 0) {
      sizeCache.set(url, len);
      return len;
    }
  } catch (e) {
    console.warn('[file] 体积探测失败(静默降级不显示大小):', e);
  }
  return 0;
}

/**
 * 点开文件气泡：下载 → 用系统文档预览打开。
 *
 * ⚠️ 豁免接线：downloadFile 与 openDocument 都会拉起系统界面，真机可能触发 App 级
 * onAppHide——若不豁免会被防护罩误弹。这里复用发图链路的「批次级布尔豁免」：
 * 开始置位、整批落定的 finally 释放，期间所有 hide 一律不遮挡；释放后用户
 * 真实切后台照常亮罩（isInMediaPickerGrace 只判定不消费）。
 */
export async function openFileMessage(url: string, fileName: string): Promise<void> {
  const ext = fileExtOf(fileName);
  if (!isH5() && !OPEN_DOC_EXTS.includes(ext)) {
    Taro.showToast({ title: '该格式暂不支持预览，请转发到电脑查看', icon: 'none' });
    return;
  }
  setMediaPickerGrace();
  try {
    const size = await probeFileSize(url);
    logDbg('[file] 开始下载文件:', fileName, formatFileSize(size), url.slice(0, 80));
    Taro.showLoading({ title: '加载中...' });
    const dl = await Taro.downloadFile({ url });
    Taro.hideLoading();
    if (dl.statusCode !== 200 || !dl.tempFilePath) {
      console.warn('[file] 下载失败 statusCode=', dl.statusCode);
      Taro.showToast({ title: '文件下载失败，请稍后重试', icon: 'none' });
      return;
    }
    if (!isH5()) {
      // 微信端 downloadFile 的 tempFilePath 可能丢失扩展名，openDocument 靠 fileType 识别格式
      await Taro.openDocument({
        filePath: dl.tempFilePath,
        showMenu: true,
        fileType: (ext || undefined) as never,
      });
    } else {
      // H5 预览端：新窗口打开（浏览器自行决定内联预览或下载）
      window.open(url, '_blank');
    }
  } catch (e: any) {
    try { Taro.hideLoading(); } catch {}
    const errMsg = String(e?.errMsg || e?.message || e || '');
    // 用户在系统文档预览里主动关闭也会 reject（cancel），属正常操作，不打错误日志
    if (/cancel/i.test(errMsg)) {
      logDbg('[file] 用户取消预览:', errMsg);
    } else {
      console.warn('[file] 打开文件失败:', errMsg);
      Taro.showToast({ title: '暂时无法打开该文件', icon: 'none' });
    }
  } finally {
    endMediaPickerGrace();
  }
}

/** MIME 兜底（供调用方需要时取用，避免重复实现） */
export { getMimeType };
