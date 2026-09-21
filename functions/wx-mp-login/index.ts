/**
 * 微信小程序登录 Edge Function
 *
 * 流程：
 * 1. 前端 wx.login() 拿到 code，POST 到本函数
 * 2. 本函数用 code + AppID + AppSecret 换 openid/unionid（jscode2session）
 * 3. 用 openid 生成 {openid}@wx.local 虚拟邮箱
 * 4. 直接尝试 admin.createUser：成功 → 新用户；返回"已注册"错误 → 已存在用户，走登录路径
 *    （不再用 listUsers 翻页预查，因为大用户量下 perPage 易被服务端 cap，导致漏判）
 * 5. 用 generateLink 生成 magiclink 的 hashed_token，同时拿回用户对象
 * 6. 前端用 supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) 完成登录
 *
 * 环境变量（必需，需要用户手动配置）：
 * - WX_APP_ID       微信小程序 AppID
 * - WX_APP_SECRET   微信小程序 AppSecret
 *
 * 部署：edge-runtime deploy --name wx-mp-login --no-jwt
 *      （-j false 是必须的，登录前用户没有 token）
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Jscode2SessionResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

// Supabase 在 email 已注册时的错误识别：兼容 code 字段（新版）和 message 关键字（旧版）
function isEmailAlreadyExistsError(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'email_exists') return true;
  const msg = (e?.message || '').toLowerCase();
  return msg.includes('already') && (msg.includes('registered') || msg.includes('exists'));
}

Deno.serve(async (req) => {
  const functionName = 'wx-mp-login';
  const requestId = crypto.randomUUID().slice(0, 8);
  const startTime = Date.now();

  if (req.method === 'OPTIONS') {
    console.info(`[${functionName}] CORS preflight ${requestId}`);
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const appid = Deno.env.get('WX_APP_ID');
    const secret = Deno.env.get('WX_APP_SECRET');
    if (!appid || !secret) {
      console.warn(`[${functionName}] config missing ${requestId} hasAppId=${Boolean(appid)} hasSecret=${Boolean(secret)}`);
      return new Response(
        JSON.stringify({
          code: 'WX_CONFIG_MISSING',
          error: '微信登录尚未配置：请到「云服务 → 登录认证 → 微信登录」配置 WX_APP_ID 和 WX_APP_SECRET',
        }),
        { status: 503, headers: corsHeaders },
      );
    }

    const { code } = await req.json();
    console.info(`[${functionName}] request ${requestId} method=${req.method} hasCode=${Boolean(code)} codeLength=${typeof code === 'string' ? code.length : 0}`);

    if (!code || typeof code !== 'string') {
      console.warn(`[${functionName}] invalid code ${requestId} codeType=${typeof code}`);
      return new Response(JSON.stringify({ error: '缺少 wx.login 返回的 code 参数' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // 1) code → openid
    const wxUrl =
      `https://api.weixin.qq.com/sns/jscode2session` +
      `?appid=${encodeURIComponent(appid)}` +
      `&secret=${encodeURIComponent(secret)}` +
      `&js_code=${encodeURIComponent(code)}` +
      `&grant_type=authorization_code`;

    const wxStartTime = Date.now();
    const wxRes = await fetch(wxUrl);
    const wxData: Jscode2SessionResponse = await wxRes.json();
    console.info(`[${functionName}] wechat upstream ${requestId} status=${wxRes.status} durationMs=${Date.now() - wxStartTime}`);

    if (wxData.errcode || !wxData.openid) {
      console.warn(`[${functionName}] wechat login failed ${requestId} errcode=${wxData.errcode ?? 'missing_openid'} errmsg=${String(wxData.errmsg ?? '').slice(0, 120)}`);
      return new Response(
        JSON.stringify({
          error: `微信登录失败: ${wxData.errmsg || 'unknown'}`,
          errcode: wxData.errcode,
        }),
        { status: 400, headers: corsHeaders },
      );
    }
    const { openid, unionid } = wxData;

    // 2) 用 openid 派生虚拟邮箱（统一虚拟邮箱域名模式）
    const email = `${openid}@wx.local`;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 3) 直接 createUser：新用户直接建好；"email 已注册"错误是合法分支（老用户重复登录），不要 throw
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: {
        provider: 'wechat_miniprogram',
        openid,
        unionid: unionid ?? null,
      },
    });
    if (createErr && !isEmailAlreadyExistsError(createErr)) {
      throw createErr;
    }
    console.info(`[${functionName}] auth user ${requestId} created=${Boolean(created?.user)} existing=${Boolean(createErr && isEmailAlreadyExistsError(createErr))}`);

    // 4) 生成 magiclink 的 hashed_token（不发邮件，直接拿 token 给前端 verifyOtp）
    //    generateLink 同时返回完整用户对象，免去为老用户再查一次 ID
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: '' },
    });
    if (linkErr) throw linkErr;

    const tokenHash = linkData?.properties?.hashed_token;
    const userId = created?.user?.id ?? linkData?.user?.id ?? null;
    if (!tokenHash) {
      console.error(`[${functionName}] missing token hash ${requestId} hasUserId=${Boolean(userId)}`);
      return new Response(JSON.stringify({ error: '生成 magiclink token 失败' }), {
        status: 500,
        headers: corsHeaders,
      });
    }
    console.info(`[${functionName}] success ${requestId} created=${Boolean(created?.user)} hasUnionId=${Boolean(unionid)} durationMs=${Date.now() - startTime}`);

    return new Response(
      JSON.stringify({
        token_hash: tokenHash,
        user_id: userId,
        openid,
        unionid: unionid ?? null,
      }),
      { headers: corsHeaders },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[${functionName}] failed ${requestId}: ${message}`);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
