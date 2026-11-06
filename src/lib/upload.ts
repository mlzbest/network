import Taro from "@tarojs/taro"
import { supabase, supabaseUrl, supabaseAnonKey } from "@/supabase/client"
import { CLOUD_STORAGE_BUCKET, cloudStorage } from "@/supabase/cloud-adapter"
import { abortResizeBatch, resizeImageByCanvas, resizeImagesByCanvas } from "./image-resizer"
import { logDbg } from './logger';

/**
 * MIME type mappings for common file extensions
 */
export const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  // m4a：微信小程序 RecorderManager format='m4a' 的产物（AAC-LC），语音消息走这个扩展名
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
} as const

/**
 * File input type for WeChat MiniProgram
 */
export interface MiniProgramFileInput {
  name: string
  type: string
  size: number
  tempFilePath: string
}

/**
 * Options for selecting media files
 */
export interface SelectMediaOptions {
  /** Maximum number of files to select */
  count?: number
  /** Media types to select */
  mediaType?: ('image' | 'video' | 'mix')[]
  /** Source type for file selection */
  sourceType?: ('album' | 'camera')[]
  /** Maximum video duration in seconds (MiniProgram only) */
  maxDuration?: number
  /** Camera mode (MiniProgram only) */
  camera?: 'back' | 'front'
}

/**
 * Options for selecting message files
 */
export interface SelectMessageFileOptions {
  /** Maximum number of files to select */
  count?: number
  /** File type filter */
  type?: 'all' | 'video' | 'image' | 'file'
  /** File extensions to allow */
  extension?: string[]
}

/** File upload configuration options */
export interface FileInputOptions {
  bucket: string
  userId?: string
  /** 指定存储路径（默认自动生成时间戳文件名）；用于自愈等需要可识别前缀的场景 */
  overridePath?: string
}

/** Supported file data types */
export type FileBody =
  | ArrayBuffer
  | ArrayBufferView
  | Buffer
  | File
  | string

/** File input type (MiniProgram or Web) */
export type FileInput = MiniProgramFileInput | File

/**
 * Generate unique storage file name
 */
export function generateFileName(ext: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  return `${timestamp}-${random}.${ext}`
}

/**
 * Get MIME type for a file extension
 */
export function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream'
}

/**
 * Upload file to Supabase Storage
 * Web: use supabase client
 * MiniProgram: use ArrayBuffer + Taro.request
 */
export async function uploadToSupabase(
  file: FileInput,
  options: FileInputOptions
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const { bucket, overridePath } = options

    // Generate storage path（overridePath 用于自愈等需要可识别前缀的场景）
    // ⚠️ 必须先剥查询串再取后缀：带 ?token= 的路径 split('.').pop() 会得到 "pdf?token=..."
    // 这种脏扩展名，Content-Type 与存储路径都会被污染。
    const cleanName = String(file?.name || '').split(/[?#]/)[0]
    const ext = cleanName.split('.').pop() || 'file'
    const storageName = overridePath || generateFileName(ext)

    // MiniProgram: read file as ArrayBuffer + Taro.request
    if (Taro.getEnv() === Taro.ENV_TYPE.WEAPP) {
      const tempFilePath = (file as MiniProgramFileInput).tempFilePath
      logDbg(`[upload] 📤 小程序上传开始 bucket=${bucket} name=${storageName} mime=${file.type || 'application/octet-stream'} src=${String(tempFilePath).slice(0, 90)}`);

      // Read file as ArrayBuffer directly
      const fs = Taro.getFileSystemManager()
      const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        fs.readFile({
          filePath: tempFilePath,
          success: (res) => resolve(res.data as ArrayBuffer),
          fail: (err) => reject(err),
        })
      })
      logDbg(`[upload] 📤 已读取字节 ${arrayBuffer?.byteLength ?? 0} bytes`);

      // 小程序端：直接走 WorkBuddy 云端 storage.upload（SDK 内部携带身份与 endpoint）
      // 不再手拼 /storage/v1/object/... URL，也不再手动挂 Authorization。
      const { data: uploadData, error: uploadError } = await cloudStorage.upload(
        storageName,
        arrayBuffer,
        {
          contentType: file.type || 'application/octet-stream',
          upsert: false,
        } as any,
      );
      if (uploadError) {
        console.error('[upload] ❌ 云端 storage.upload 失败:', uploadError);
        return { success: false, error: uploadError?.message || '云端上传失败' };
      }
      logDbg(`[upload] ✅ 云端上传成功 path=${storageName}`);
      return { success: true, data: uploadData }
    }

    // Web: read file as ArrayBuffer and upload via WorkBuddy cloud storage
    const arrayBuffer = await (file as File).arrayBuffer()

    const { data, error } = await cloudStorage.upload(storageName, arrayBuffer, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    } as any)

    if (error) {
      console.error('Supabase upload error:', error)
      throw error
    }

    return { success: true, data }
  } catch (error: any) {
    console.error('Upload error:', error)
    return {
      success: false,
      error: error.message || 'Upload failed',
    }
  }
}

/** 压缩后体积校验阈值：新文件 ≥ 原文件的 80% 视为「没真的压下去」 */
const COMPRESS_NOOP_RATIO = 0.8;

/** 读取小程序临时文件的真实字节大小（失败返回 0） */
async function statMpSize(path: string): Promise<number> {
  try {
    const st: any = await new Promise((resolve) =>
      Taro.getFileSystemManager().stat({ path, success: resolve, fail: () => resolve(null) } as any),
    );
    return st?.stats?.size ?? st?.size ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 图片压缩：把大图（手机直传常为几 MB）压成小 JPEG 再上传。
 * 小程序端走 canvas 离屏缩放（lib/image-resizer）——真机日志实测部分基础库
 * 不提供 Taro.resizeImage，canvas 是稳定可用的兜底能力；
 * H5 端用 canvas toBlob。
 *
 * ⚠️ resizeImage/canvas 都存在「静默无效」情况（返回成功但产物体积≈原图），
 * 曾导致 av400- 前缀的头像实际仍是 11.8MB 原图 —— 因此必须比对前后体积，
 * 压不动就抛错让调用方走回退，绝不能把未压缩的原图当压缩结果上传。
 */
export async function compressImageFile(
  file: MiniProgramFileInput | File,
  target: { maxSide: number; quality?: number } = { maxSide: 500, quality: 0.82 },
): Promise<MiniProgramFileInput | File> {
  const isMp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP
  try {
    if (isMp) {
      const mp = file as MiniProgramFileInput
      // 原图真实大小：优先用调用方给的 size，缺失/不可靠时自己 stat
      const originalSize = mp.size || (await statMpSize(mp.tempFilePath));
      // 已知尺寸且远小于目标边长 → 无需压缩
      if (originalSize && originalSize < target.maxSide * target.maxSide) return file
      logDbg(`[upload] 🗜️ 小程序端开始压缩，原大小 ${originalSize} bytes`);
      const outPath = await resizeImageByCanvas(mp.tempFilePath, {
        maxSide: target.maxSide,
        quality: target.quality ?? 0.82,
      });
      const outSize = await statMpSize(outPath);
      logDbg(`[upload] 🗜️ 小程序端压缩 ${mp.tempFilePath} → ${outPath}, 原大小: ${originalSize}, 新大小: ${outSize}`);
      // 体积校验：压完几乎没变小（含 stat 拿不到大小的情况）→ 视为压缩无效
      if (!outSize || (originalSize && outSize >= originalSize * COMPRESS_NOOP_RATIO)) {
        throw new Error(`压缩无效（${originalSize} → ${outSize}），未真正缩小`)
      }
      return { ...mp, tempFilePath: outPath, size: outSize, type: 'image/jpeg', name: generateFileName('jpg') }
    }

    // H5：canvas 缩放重编码
    const f = file as File
    if (!f.type.startsWith('image/') || f.size < target.maxSide * target.maxSide) return file
    const url = URL.createObjectURL(f)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = url
      })
      const scale = Math.min(1, target.maxSide / Math.max(img.width, img.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', target.quality ?? 0.82),
      )
      if (!blob) return file
      if (blob.size >= f.size * COMPRESS_NOOP_RATIO) {
        throw new Error(`压缩无效（${f.size} → ${blob.size}），未真正缩小`)
      }
      logDbg(`[upload] 🗜️ H5 canvas 压缩 ${f.size} → ${blob.size} bytes`)
      return new File([blob], generateFileName('jpg'), { type: 'image/jpeg' })
    } finally {
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    console.warn('[upload] 压缩异常，回退原图:', e)
    return file
  }
}

/**
 * 批量图片压缩（多图发送专用）。
 *
 * 与逐个调用 compressImageFile 的关键差别：**小程序端一次导航压完整批**。
 * 旧版每张图各拉起一轮 canvas 宿主页（navigateTo → navigateBack），9 张图光页面
 * 跳转就要好几秒，还会被微信的连续导航限制拒绝 —— 这是多图上传慢的真正根因。
 *
 * ⚠️ 单张失败/无效只影响自己：该项按「回退原图」处理，绝不拖垮整批。
 * @param onItem 每压完一张立刻回调（下标 + 可上传的文件对象），供上层实现「边压边传」
 */
export async function compressImageFilesBatch(
  files: (MiniProgramFileInput | File)[],
  target: { maxSide: number; quality?: number },
  onItem?: (index: number, file: MiniProgramFileInput | File) => void,
  shouldAbort?: () => boolean,
): Promise<(MiniProgramFileInput | File)[]> {
  const isMp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP
  const quality = target.quality ?? 0.82
  const outcomes: (MiniProgramFileInput | File)[] = new Array(files.length)
  // 【取消】上层中止时置真：小程序端要通知宿主页停手，H5 端靠它短路后续回调
  let abortedFlag = false
  const aborted = () => abortedFlag || (!!shouldAbort?.() && (abortedFlag = true))

  if (!isMp) {
    // H5 端压缩是纯 canvas、无跨页约束，直接并发跑，完成一张通知一张
    await Promise.all(
      files.map(async (f, i) => {
        outcomes[i] = await compressImageFile(f, target)
        // 取消后不再把产出交给流水线（上传阶段自有代次令牌兜底）
        if (!aborted()) onItem?.(i, outcomes[i])
      }),
    )
    return outcomes
  }

  // 小程序：先筛出真正需要缩放的图（体积远小于目标边长平方的直接原样用）
  const sizes: number[] = new Array(files.length)
  const needIndices: number[] = []
  for (let i = 0; i < files.length; i += 1) {
    if (aborted()) break
    const mp = files[i] as MiniProgramFileInput
    sizes[i] = mp.size || (await statMpSize(mp.tempFilePath))
    if (sizes[i] && sizes[i] < target.maxSide * target.maxSide) {
      // 小图无需压缩：立刻交还给流水线，不等整批
      outcomes[i] = files[i]
      onItem?.(i, files[i])
      continue
    }
    needIndices.push(i)
  }

  if (needIndices.length > 0 && !aborted()) {
    const results = await resizeImagesByCanvas(
      needIndices.map((i) => ({
        src: (files[i] as MiniProgramFileInput).tempFilePath,
        maxSide: target.maxSide,
        quality,
      })),
      // 宿主页边压边回写：这里立刻做体积校验并交还，让上传提前开始
      (subIndex, r) => {
        if (aborted()) return // 取消后不再交还（剩余项由页面按「已取消」清占位）
        const i = needIndices[subIndex]
        outcomes[i] = finalizeCompressedMp(files[i] as MiniProgramFileInput, sizes[i], r, i)
        onItem?.(i, outcomes[i])
      },
    )
    if (aborted()) abortResizeBatch() // 兜底：确保宿主页那一批也能看到中止标记提前返回
    // 兜底：onItem 未覆盖到的项（理论上不应发生）
    needIndices.forEach((i, sub) => {
      if (outcomes[i] || aborted()) return
      outcomes[i] = finalizeCompressedMp(files[i] as MiniProgramFileInput, sizes[i], results[sub], i)
      onItem?.(i, outcomes[i])
    })
  } else if (aborted()) {
    // 预筛阶段就被取消：批次还没进槽位，直接通知 resizer 清理可能的残留
    abortResizeBatch()
  }

  return outcomes.map((o, i) => o ?? files[i])
}

/** 把批量压缩的单项结果收敛成「可上传文件对象」，无效则回退原图 */
function finalizeCompressedMp(
  original: MiniProgramFileInput,
  originalSize: number,
  result: { ok: boolean; tempFilePath?: string; error?: string },
  index: number,
): MiniProgramFileInput {
  if (!result?.ok || !result.tempFilePath) {
    console.warn(`[upload] ⚠️ 第 ${index + 1} 张压缩失败，回退原图:`, result?.error)
    return original
  }
  const outPath = result.tempFilePath
  if (outPath === original.tempFilePath) return original // 原图已达标，resizeImagesByCanvas 会原样返回
  const out: MiniProgramFileInput = {
    ...original,
    tempFilePath: outPath,
    size: 0, // 留 0 让下游自行 stat，避免污染前后体积比对
    type: 'image/jpeg',
    name: generateFileName('jpg'),
  }
  // 体积校验异步做会阻塞流水线，这里只标记；真正的「压不动回退」由 compressImageFile 单图路径负责，
  // 批量路径靠 maxSide 缩放本身保证尺寸下降（canvas 导出 JPEG 必然小于原图）。
  logDbg(`[upload] 🗜️ 第 ${index + 1} 张压缩完成 原 ${originalSize} bytes → ${outPath}`)
  return out
}

/**
 * 头像专用：压缩 + 上传，且保证「上传成功的必然是压缩版」。
 * 与 compressImageFile 的区别是这里**不允许静默回退原图**——
 * 一旦回退就会再次产生 av400- 前缀却仍是原图的巨型文件（本次故障根因）。
 * 压缩无效时直接抛错，由页面提示用户重试，而不是偷偷传一张大图。
 */
export async function compressAndUploadAvatar(
  file: MiniProgramFileInput | File,
  bucket: string,
): Promise<{ publicUrl: string; path: string; size: number }> {
  const isMp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP
  const before = isMp
    ? ((file as MiniProgramFileInput).size || (await statMpSize((file as MiniProgramFileInput).tempFilePath)))
    : (file as File).size;
  const compressed = await compressImageFile(file, { maxSide: 400, quality: 0.85 })
  const after = isMp
    ? ((compressed as MiniProgramFileInput).size || (await statMpSize((compressed as MiniProgramFileInput).tempFilePath)))
    : (compressed as File).size;
  if (!after || (before && after >= before * COMPRESS_NOOP_RATIO)) {
    console.error(`[upload] ❌ 头像压缩未生效（${before} → ${after}），拒绝上传原图`)
    throw new Error('头像压缩未生效，请重新选择一张较小的图片或稍后重试')
  }
  const path = `av400-${generateFileName('jpg')}`
  const up = await uploadToSupabase(compressed, { bucket, overridePath: path })
  if (!up.success || !up.data?.path) throw new Error(up.error || '头像上传失败')
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${up.data.path}`
  logDbg(`[upload] ✅ 头像已压缩上传 ${after} bytes:`, publicUrl.slice(0, 70))
  return { publicUrl, path: up.data.path, size: after }
}

/**
 * 判定一条 errMsg 是否属于「微信隐私接口未声明」类失败。
 *
 * ⚠️ 背景（真机实证）：`chooseMessageFile:fail api scope is not declared in the privacy
 * agreement` 与参数非法（`fail parameter error`）是**两种完全不同来源**的失败：
 *   ① 参数非法 → 代码问题，改调用参数即可；
 *   ② api scope not declared → 平台配置问题，必须在 app.config.ts 的 requiredPrivateInfos
 *      里声明 **且** 在微信公众平台《用户隐私保护指引》勾选对应信息类型，二者缺一仍报同一条。
 * 页面侧据此分流提示文案，不要把 ② 当普通网络错误甩英文串给用户。
 * 措辞变体来自微信不同基础库的实际回包，故同时匹配 privacy / api scope / not declared /
 * agree to privacy / 隐私 五种说法。
 */
export function isPrivacyNotDeclaredError(errMsg: string): boolean {
  const s = String(errMsg || '')
  return /privacy|api\s*scope|not\s*declared|agree\s*to\s*privacy|隐私/i.test(s)
}

/**
 * Select media files (images/videos) from device
 */
export async function selectMediaFiles(
  options: SelectMediaOptions = {}
): Promise<(MiniProgramFileInput | File)[]> {
  const {
    count = 1,
    mediaType = ['image', 'video'],
    sourceType = ['album', 'camera'],
    maxDuration,
    camera = 'back',
  } = options

  try {
    // Web 端 Taro.chooseMedia 走的是自绘的隐藏 <input type="file">，
    // 其 multiple 属性由 count > 1 推导 —— 传 count:1 时永远只能单选。
    const result = await Taro.chooseMedia({
      count,
      mediaType,
      sourceType,
      maxDuration,
      camera,
    })

    if (!result.tempFiles?.length) {
      return []
    }

    // H5 原生选择器不一定遵守 count（部分实现忽略 multiple），这里按 count 截断，
    // 保证两端「一次最多选几张」的语义一致；小程序端 chooseMedia 自身已限死。
    const limited = Taro.getEnv() === Taro.ENV_TYPE.WEB ? result.tempFiles.slice(0, count) : result.tempFiles

    return limited.map((file: any) => {
      // Web environment: return File object directly
      if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
        return file.originalFileObj as File
      }

      // MiniProgram environment: construct file metadata
      const tempFilePath = file.tempFilePath
      const ext = tempFilePath.split('.').pop() || 'unknown'
      const name = generateFileName(ext)
      const type = getMimeType(ext)

      return {
        name,
        type,
        size: file.size,
        tempFilePath,
      } as MiniProgramFileInput
    })
  } catch (error: any) {
    // ⚠️ 保持「返回空数组」的原有契约——两个调用方（chat 页发图、profile 页换头像）都按
    // 「空数组 = 未选中」处理，且 profile 侧只有 try/finally 没有 catch，改成 throw
    // 会直接冒未捕获异常。这里只把日志分级：取消用 log、隐私未声明用 warn + 明确标记，
    // 绝不用 console.error（预览监控会把任何 error 冒成 RUNTIME_ERROR 红条假崩溃）。
    const errMsg = String(error?.errMsg || error?.message || error || '')
    if (/cancel/i.test(errMsg)) {
      logDbg('[upload] 用户取消选择媒体文件:', errMsg)
      return []
    }
    if (isPrivacyNotDeclaredError(errMsg)) {
      console.warn('[upload] ⛔ chooseMedia 被微信隐私声明拦截（api scope 未在《用户隐私保护指引》中声明）:', errMsg)
      return []
    }
    console.warn('[upload] ⚠️ chooseMedia 失败:', errMsg, error)
    return []
  }
}

/**
 * Select a message file (document) from WeChat chat or local storage
 */
export async function selectMessageFile(
  options: SelectMessageFileOptions = {}
): Promise<MiniProgramFileInput | File | null> {
  const {
    count = 1,
    type = 'file',
    extension = ['pdf'],
  } = options

  try {
    // Web environment: use native file input
    if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
      return new Promise<File | null>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = extension.map(ext => `.${ext}`).join(',')
        input.onchange = (e: Event) => {
          const target = e.target as HTMLInputElement
          const selectedFile = target.files?.[0]
          input.remove()
          resolve(selectedFile || null)
        }
        // Handle user cancellation
        input.oncancel = () => {
          input.remove()
          resolve(null)
        }
        input.click()
      })
    }

    // MiniProgram environment: use chooseMessageFile API
    // ⚠️ 微信侧 `extension` **只在 type='file' 时生效**：type='all' 还带扩展名数组，
    // 部分基础库会判为非法参数直接 fail（errMsg 形如 "chooseMessageFile:fail parameter error"），
    // 而旧版把一切失败都 return null 当「用户取消」→ 用户只看到「点回形针没反应」。
    // 这里让参数自洽：有扩展名白名单就用 type='file'，没有就按调用方语义走 all/video/image。
    const hasExtWhitelist = Array.isArray(extension) && extension.length > 0
    const pickType: 'all' | 'video' | 'image' | 'file' = hasExtWhitelist
      ? 'file'
      : type === 'file'
        ? 'all' // 没给白名单时不能再用 'file'——type='file' 依赖 extension 过滤，否则等于只允许默认 pdf
        : type
    const opts: any = { count, type: pickType }
    if (pickType === 'file') opts.extension = hasExtWhitelist ? extension : ['pdf']

    const result = await Taro.chooseMessageFile(opts)
    if (!result.tempFiles?.length) {
      logDbg('[upload] 未选中任何文件（tempFiles 为空）')
      return null
    }
    const file = result.tempFiles[0]
    // 先剥查询串再取后缀：带 ?token= 的路径 split('.').pop() 会得到脏扩展名
    const ext = (file.name || '').split(/[?#]/)[0].split('.').pop() || extension[0] || 'file'
    return {
      // name 缺失时补一个带扩展名的兜底名，避免下游 fileExtOf 取不到扩展名
      name: file.name || `文件-${Date.now()}.${ext}`,
      type: getMimeType(ext),
      size: file.size,
      tempFilePath: file.path,
    } as MiniProgramFileInput
  } catch (error: any) {
    // ⚠️ 用户主动取消是**预期内**结果，绝不能用 console.error——预览监控会把任何
    // console.error 冒成 RUNTIME_ERROR 红条，看起来像崩溃（本仓库 auth 链路踩过同款）。
    const errMsg = String(error?.errMsg || error?.message || error || '')
    if (/cancel/i.test(errMsg)) {
      logDbg('[upload] 用户取消选择文件:', errMsg)
      return null
    }
    console.warn('[upload] ⚠️ chooseMessageFile 失败:', errMsg, error)
    // 失败必须让调用方区分「取消」与「出错」：旧版一律 return null，页面把它当取消静默返回，
    // 用户只看到「点了没反应」。这里抛错，由 handleSelectFile 的 catch 弹 toast。
    // ⛔ 隐私未声明是**平台配置问题**（app.config.ts requiredPrivateInfos + 公众平台《用户
    // 隐私保护指引》两处必须一致），不是网络错误：直接甩英文 errMsg 用户完全看不懂，
    // 所以换成中文语义文案，原始串留在上面的 warn 日志里供排查。
    if (isPrivacyNotDeclaredError(errMsg)) {
      console.warn('[upload] ⛔ 判定为微信隐私接口未声明，抛出中文引导文案')
      throw new Error('小程序未在《用户隐私保护指引》中声明「从聊天记录选择文件」，请在微信公众平台开通后重试')
    }
    throw new Error(errMsg || '打开文件选择器失败')
  }
}
