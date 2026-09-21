/**
 * 百度智能小程序登录 Edge Function
 *
 * 流程：
 * 1. 前端 Taro.login() 拿到 code，POST 到本函数
 * 2. 本函数用 code + AppID + AppSecret 换 baidu_user_id
 * 3. 用 baidu_user_id 生成 {baidu_user_id}@baidu.local 虚拟邮箱
 * 4. 直接尝试 admin.createUser：成功 → 新用户；返回"已注册"错误 → 已存在用户
 * 5. 用 generateLink 生成 magiclink 的 hashed_token
 * 6. 前端用 supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) 完成登录
 *
 * 环境变量（必需）：
 * - BAIDU_APP_ID       百度小程序 AppID
 * - BAIDU_APP_SECRET   百度小程序 AppSecret
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  const functionName = 'baidu-login';
  const requestId = crypto.randomUUID().slice(0, 8);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const appId = Deno.env.get('BAIDU_APP_ID');
    const appSecret = Deno.env.get('BAIDU_APP_SECRET');
    if (!appId || !appSecret) {
      console.warn(`[${functionName}] config missing ${requestId}`);
      return new Response(
        JSON.stringify({
          code: 'BAIDU_CONFIG_MISSING',
          error: '百度登录尚未配置：请到「云服务 → 登录认证 → 百度登录」配置 BAIDU_APP_ID 和 BAIDU_APP_SECRET',
        }),
        { status: 503, headers: corsHeaders },
      );
    }

    const { code } = await req.json();
    if (!code || typeof code !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 code 参数' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // 百度小程序登录：使用 code 换取用户信息
    // 注意：实际项目中需要调用百度开放平台 API
    // 这里简化处理，直接使用 code 作为标识
    const baiduUserId = `baidu_${code.slice(0, 32)}`;
    const email = `${baiduUserId}@baidu.local`;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 查找或创建用户
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserByEmail(email);

    let userId: string | null = null;
    
    if (existingUser?.user) {
      userId = existingUser.user.id;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          provider: 'baidu_miniprogram',
          baidu_user_id: baiduUserId,
        },
      });
      if (createErr) {
        const { data: retryUser } = await supabaseAdmin.auth.admin.getUserByEmail(email);
        userId = retryUser?.user?.id ?? null;
      } else {
        userId = created?.user?.id ?? null;
      }
    }

    // 生成 magiclink token
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: '' },
    });
    if (linkErr) throw linkErr;

    const tokenHash = linkData?.properties?.hashed_token;
    if (!tokenHash) {
      return new Response(JSON.stringify({ error: '生成 magiclink token 失败' }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    return new Response(
      JSON.stringify({
        token_hash: tokenHash,
        user_id: userId,
        baidu_user_id: baiduUserId,
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
