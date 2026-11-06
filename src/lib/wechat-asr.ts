import Taro from '@tarojs/taro';
import { logDbg } from './logger';

/**
 * 「零成本」语音转文字通道：借用**微信同声传译插件**（WechatSI）的录音识别能力。
 *
 * 为什么需要它：平台 AI 网关只提供纯文本模型，外接第三方 ASR 又需要用户自备 Key。
 * 本通道由微信侧完成识别，**不需要任何密钥、不消耗云函数额度**。
 *
 * ⚠️ 与云函数通道的本质差异（必须让调用方和 UI 都清楚）：
 *    - 识别发生在**发送前的录音环节**。插件只能对正在录的音频做实时识别，
 *      **无法回头识别已经上传到存储桶的历史语音**。
 *    - 所以本模块的职责是：在按住说话时同步拿到识别文本，随消息一起落到本机缓存；
 *      对方发来的语音、以及本通道上线之前发出的历史语音，仍然只能走云函数通道（需 Key）。
 *
 * ⚠️ 两个硬前提（任一不满足即整体不可用，代码侧只能静默降级）：
 *    ① `app.config.ts` 声明了 `plugins.WechatSI`，且本项目 AppID 已在微信公众平台后台
 *       「添加插件」并通过——否则平台生成预览码时会被微信直接拒绝（实测 errcode 80082
 *       / permission deny），连累整个小程序构建失败；
 *    ② 主体为**企业/组织等非个人主体**——个人主体小程序无法添加该插件（微信侧限制）。
 *    当前项目若未满足上述条件，本模块所有入口都会返回 null / false，语音照常发送。
 */

/**
 * 插件「同声传译-长语音识别」管理器形态（RecordRecognitionManager）。
 * 只声明本项目用到的部分，避免 any 满天飞。
 *
 * ⚠️ 事件名是 `onRecognize` / `onStop` / `onError`，**不是** onTranslate——
 *    `getTranslateManager()` 是「文本翻译」用的，与语音识别是两个不同对象，别混用。
 */
interface SiRecordRecognitionManager {
  onStart?: (cb: (res?: { errMsg?: string }) => void) => void;
  /** 实时中间结果：每次返回的是**当前这句的全量文本**，不是增量，禁止累加 */
  onRecognize: (cb: (res: { result?: string }) => void) => void;
  /** 停止后回调：res.result 是最终整句文本 */
  onStop: (cb: (res: { result?: string; tempFilePath?: string; duration?: number; fileSize?: number }) => void) => void;
  onError: (cb: (res: { retcode?: number | string; msg?: string; errMsg?: string }) => void) => void;
  start: (opts: { lang?: string; duration?: number }) => void;
  stop: () => void;
}

/** 识别语言：聊天场景默认中文普通话（插件另支持 en_US / zh_HK / sichuanhua） */
const RECOGNIZE_LANG = 'zh_CN';

/** 单次识别上限：插件最长 60 秒，与 chat 页录音器的 duration 保持一致 */
const MAX_RECOGNIZE_MS = 60000;

let manager: SiRecordRecognitionManager | null = null;
/** 已尝试过获取插件但失败——不再反复重试刷日志 */
let unavailableLogged = false;

/**
 * 取录音识别管理器；插件未注册 / 未授权 / 非小程序端时返回 null。
 * 全程 try/catch：真机上 `requirePlugin` 在插件未授权时会直接抛，不能让它冒到录音链路里。
 */
export function getSiManager(): SiRecordRecognitionManager | null {
  if (manager) return manager;
  try {
    // requirePlugin 只在小程序端存在；H5 预览与类型系统都没有它，故走全局取值而非直接引用
    const requireFn = (globalThis as { requirePlugin?: (name: string) => unknown }).requirePlugin;
    if (typeof requireFn !== 'function') return null;
    const plugin = requireFn('WechatSI') as { getRecordRecognitionManager?: () => SiRecordRecognitionManager };
    const m = typeof plugin?.getRecordRecognitionManager === 'function' ? plugin.getRecordRecognitionManager() : null;
    if (!m || typeof m.start !== 'function' || typeof m.onStop !== 'function') {
      if (!unavailableLogged) {
        console.warn('[asr-wechat] ⚠️ 插件已加载但拿不到识别管理器');
        unavailableLogged = true;
      }
      return null;
    }
    manager = m;
    return manager;
  } catch (e) {
    if (!unavailableLogged) {
      console.warn('[asr-wechat] ⚠️ 同声传译插件不可用（未在后台添加插件 / 个人主体不支持 / 未配 APPID），本端将不做免密识别:', e);
      unavailableLogged = true;
    }
    return null;
  }
}

/** 一次录音会话的识别句柄 */
export interface WechatAsrSession {
  /** 目前累计到的识别文本（中间结果会不断变长，UI 可直接展示） */
  readonly text: string;
  /** 结束识别并返回最终文本；无插件参与时返回空串 */
  finish: () => string;
}

/**
 * 在录音开始时启动识别。返回的句柄由调用方在录音结束时 `finish()` 取最终文本。
 *
 * 语义说明：插件的 `start()/stop()` 自己就管着录音与识别（内部占用录音器），
 * 因此**必须在 `RecorderManager.start()` 之后**调用，避免两边抢麦克风；
 * 最终文本以 `onStop` 为准，`onRecognize` 只作为提前到达的兜底值。
 *
 * @param recorder 本次录音使用的 RecorderManager（仅用于挂错误回调，不参与识别本身）
 * @returns 识别句柄；`null` 表示本端没有可用的插件识别能力，调用方按原逻辑继续即可
 */
export function startWechatAsr(recorder?: Taro.RecorderManager): WechatAsrSession | null {
  const m = getSiManager();
  if (!m) return null;

  let latest = '';
  let finished = false;
  /** onStop 是否已回写过最终值——决定 finish() 要不要等下一拍 */
  let settled = false;

  const session: WechatAsrSession = {
    get text() {
      return latest;
    },
    finish() {
      if (!finished) {
        finished = true;
        try {
          m.stop();
        } catch (e) {
          console.warn('[asr-wechat] ⚠️ 停止识别异常（忽略）:', e);
        }
      }
      // 注意：插件 onStop 是异步的，这里通常还拿不到最终值。
      // 调用方（chat 页）在 onStop 之后才取文本，多数情况下 latest 已是较完整内容；
      // 漏掉最后半句可接受，卡住语音发送不可接受。
      return latest.trim();
    },
  };

  m.onRecognize((res) => {
    if (finished) return;
    const piece = typeof res?.result === 'string' ? res.result.trim() : '';
    // 全量覆盖，绝不累加——插件返回的是当前这句的完整文本，累加会重复出字
    if (piece) latest = piece;
  });

  m.onStop((res) => {
    const piece = typeof res?.result === 'string' ? res.result.trim() : '';
    if (piece) latest = piece;
    settled = true;
    logDbg(`[asr-wechat] 🎙️ 识别结束: ${latest.length} 字`);
  });

  m.onError((res) => {
    console.warn('[asr-wechat] ⚠️ 插件识别报错（不影响录音发送）:', res?.msg || res?.errMsg, 'retcode=', res?.retcode);
  });

  if (recorder) {
    recorder.onError(() => {
      if (!finished) {
        finished = true;
        try {
          m.stop();
        } catch {
          /* 录音本身已出错，无需再管识别 */
        }
      }
    });
  }

  try {
    m.start({ lang: RECOGNIZE_LANG, duration: MAX_RECOGNIZE_MS });
    logDbg('[asr-wechat] 🎙️ 同声传译识别已启动');
  } catch (e) {
    console.warn('[asr-wechat] ⚠️ 启动识别失败（降级为不识别）:', e);
    return null;
  }

  // settled 仅为可读性保留：真正的最终值靠闭包 latest，外部通过 session.text 观察
  void settled;

  return session;
}

/**
 * 供 UI 判断「本机是否具备免密识别能力」，用于按钮文案与提示。
 * ⚠️ H5 预览态恒为 false（requirePlugin 不存在），属预期表现。
 */
export function hasWechatAsr(): boolean {
  return getSiManager() !== null;
}
