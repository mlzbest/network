import Taro from '@tarojs/taro';
import { projectUrlId, supabase, supabaseAnonKey, supabaseUrl } from '@/supabase/client';
import { logDbg } from '../lib/logger';

/**
 * 「每天运动步数对比」的唯一网络出口。
 *
 * 为什么全走 Edge Function 而不是 supabase.from()：微信 getWeRunData 回包是
 * **加密数据**，解密所需 session_key 只能服务端用 code 换取，绝不下发前端；
 * 落库与「对方数据」的越权校验也必须在服务端做。Database 侧仍由 RLS 兜底，
 * 但业务读写统一收敛到云函数。
 *
 * ⚠️ 云函数额度只有 2 个名额，步数通道不单独建函数，而是挂在 `net-diagnose`
 *    函数内、按请求体 `action` 路由（实现见 `functions/net-diagnose/shared/we-run-steps.ts`）。
 *    因此这里的 action 必须用 `steps-query` / `steps-sync` 前缀，避免与诊断项字段混淆。
 */

export interface StepPoint {
  /** YYYY-MM-DD（Asia/Shanghai 自然日） */
  day: string;
  steps: number;
}

export interface StepsCompareResult {
  /** 本人今日步数（无数据为 0） */
  today: number;
  mine: StepPoint[];
  peer: StepPoint[];
  /** 是否允许查看对方数据（存在双方记录才为 true） */
  peerAllowed: boolean;
  /**
   * 对方**全历史**最近一次同步的日期（YYYY-MM-DD）。
   * 空串表示对方从未同步过任何步数——用于区分「从未同步」与「近期没同步」，
   * 这两种情况在 peer 数组里都表现为空，只看数组无法分辨。
   */
  peerLastDay: string;
}

/** 云函数统一响应解析：非 2xx 或 body.error 都抛中文语义错误 */
async function callStepsFunction(data: Record<string, unknown>): Promise<StepsCompareResult & Record<string, unknown>> {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token || supabaseAnonKey;
  const res = await Taro.request({
    url: `${supabaseUrl}/functions/v1/net-diagnose`,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: supabaseAnonKey,
      'OneDay-App-Id': projectUrlId,
    },
    data,
    timeout: 20000,
  });
  const body = (res.data ?? {}) as StepsCompareResult & Record<string, unknown> & { error?: string };
  if (res.statusCode < 200 || res.statusCode >= 300 || body.error) {
    // 404/401 且拿不到函数自己的 error 字段时，几乎只有一种原因：函数还没部署到云上。
    // 不翻译成中文的话，用户只会看到「步数服务异常(404)」这种无法行动的提示。
    if ((res.statusCode === 404 || res.statusCode === 401) && !body.error) {
      console.warn(`[steps] ⛔ net-diagnose 步数通道不可达 status=${res.statusCode}，判定为尚未部署`);
      throw new Error('步数服务尚未部署生效，请重新部署 net-diagnose 云函数后重试');
    }
    throw new Error(String(body.error || `步数服务异常(${res.statusCode})`));
  }
  return body;
}

/**
 * 拉取本机微信运动步数并同步落库，同时带回对方近 N 天数据。
 *
 * 端能力差异（必须区分，否则 H5 预览会当成"功能坏了"）：
 * - 微信小程序：getWeRunData + login 双通道，真实数据
 * - H5 预览：微信 JSAPI 不存在，直接抛引导文案（不是静默返回空，避免调用方误判成功）
 */
export async function syncMySteps(peerId?: string, days = 7): Promise<StepsCompareResult> {
  const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  if (!isWeapp) {
    throw new Error('请在微信小程序中打开以读取运动步数');
  }

  // 当前已登录账号的真实 uid：密码注册的老账号没有 openid，服务端解密拿到 openid 后
  // 会据此把 openid 补绑到该账号（首次同步打通身份），因此这里必须把 uid 一起带上去。
  const uid = (await supabase.auth.getSession()).data.session?.user?.id || '';

  let weRun: { encryptedData?: string; iv?: string };
  try {
    weRun = await Taro.getWeRunData();
  } catch (e: any) {
    const errMsg = String(e?.errMsg || e?.message || e || '');
    console.warn('[steps] ⛔ getWeRunData 失败:', errMsg);
    if (/privacy|api\s*scope|not\s*declared|隐私/i.test(errMsg)) {
      throw new Error('小程序尚未在《用户隐私保护指引》中声明「微信运动步数」，请在微信公众平台开通后重试');
    }
    if (/auth|deny|denied|授权/i.test(errMsg)) {
      throw new Error('未授权微信运动数据，无法获取步数');
    }
    throw new Error(errMsg || '读取微信运动数据失败');
  }
  if (!weRun?.encryptedData || !weRun?.iv) {
    throw new Error('微信未返回运动数据，请稍后重试');
  }

  const loginRes = await Taro.login();
  if (!loginRes.code) {
    throw new Error(`wx.login 失败: ${loginRes.errMsg || '未返回 code'}`);
  }

  const body = await callStepsFunction({
    action: 'steps-sync',
    user_id: uid,
    code: loginRes.code,
    encryptedData: weRun.encryptedData,
    iv: weRun.iv,
    peer_id: peerId || '',
    days,
  });
  logDbg(`[steps] ✅ 本人步数已同步 today=${body.today} 明细${body.mine?.length ?? 0}天 对方${body.peer?.length ?? 0}天`);
  return {
    today: Number(body.today) || 0,
    mine: Array.isArray(body.mine) ? body.mine : [],
    peer: Array.isArray(body.peer) ? body.peer : [],
    peerAllowed: Boolean(body.peerAllowed),
    peerLastDay: typeof body.peerLastDay === 'string' ? body.peerLastDay : '',
  };
}

/**
 * 只读已落库的数据（不触发微信解密），用于进页秒出与降级展示。
 * user_id 从当前会话取；过渡登录态（bootstrapped）下拿不到真实 uid，调用方需自行门控。
 */
export async function fetchStepsCompare(peerId?: string, days = 7): Promise<StepsCompareResult> {
  const uid = (await supabase.auth.getSession()).data.session?.user?.id || '';
  if (!uid) throw new Error('登录状态尚未就绪');
  const body = await callStepsFunction({ action: 'steps-query', user_id: uid, peer_id: peerId || '', days });
  return {
    today: Number(body.today) || 0,
    mine: Array.isArray(body.mine) ? body.mine : [],
    peer: Array.isArray(body.peer) ? body.peer : [],
    peerAllowed: Boolean(body.peerAllowed),
    peerLastDay: typeof body.peerLastDay === 'string' ? body.peerLastDay : '',
  };
}
