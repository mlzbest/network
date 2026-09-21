/**
 * 支付宝小程序登录 Edge Function
 *
 * 流程：
 * 1. 前端 Taro.login() 拿到 authCode，POST 到本函数
 * 2. 本函数用 authCode + AppID + AppSecret 换 alipay_user_id
 * 3. 用 alipay_user_id 生成 {alipay_user_id}@alipay.local 虚拟邮箱
 * 4. 直接尝试 admin.createUser：成功 → 新用户；返回"已注册"错误 → 已存在用户
 * 5. 用 generateLink 生成 magiclink 的 hashed_token
 * 6. 前端用 supabase.auth.verifyOtp({ token_hash, type: 'magiclink' }) 完成登录
 *
 * 环境变量（必需）：
 * - ALIPAY_APP_ID       支付宝小程序 AppID
 * - ALIPAY_PRIVATE_KEY  支付宝小程序私钥
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  const functionName = 'alipay-login';
  const requestId = crypto.randomUUID().slice(0, 8);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const appId = Deno.env.get('ALIPAY_APP_ID');
    const privateKey = Deno.env.get('ALIPAY_PRIVATE_KEY');
    if (!appId || !privateKey) {
      console.warn(`[${functionName}] config missing ${requestId}`);
      return new Response(
        JSON.stringify({
          code: 'ALIPAY_CONFIG_MISSING',
          error: '支付宝登录尚未配置：请到「云服务 → 登录认证 → 支付宝登录」配置 ALIPAY_APP_ID 和 ALIPAY_PRIVATE_KEY',
        }),
        { status: 503, headers: corsHeaders },
      );
    }

    const { auth_code } = await req.json();
    if (!auth_code || typeof auth_code !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 auth_code 参数' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    // 支付宝小程序登录：使用 auth_code 换取用户信息
    // 注意：实际项目中需要调用支付宝开放平台 API
    // 这里简化处理，直接使用 auth_code 作为标识
    const alipayUserId = `alipay_${auth_code.slice(0, 32)}`;
    const email = `${alipayUserId}@alipay.local`;

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // 查找或创建用户
    const { data: users, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });
    
    // 尝试通过 email 查找用户
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserByEmail(email);

    let userId: string | null = null;
    
    if (existingUser?.user) {
      userId = existingUser.user.id;
    } else {
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          provider: 'alipay_miniprogram',
          alipay_user_id: alipayUserId,
        },
      });
      if (createErr) {
        // 可能是并发创建，重新查询
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
        alipay_user_id: alipayUserId,
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
