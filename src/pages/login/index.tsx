import { useEffect, useState, useRef } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { View, Text, Input } from '@tarojs/components';
import PrivacyShield from '@/components/privacy-shield';
import { useAuthStore } from '@/store/auth-store';
import { consumeReturnPath } from '@/lib/redirect-to-login';
import { markSecretEntry } from '@/lib/secret-entry';
import { reportLoginLocation } from '@/api/profiles';
import { ForgotPasswordSheet } from '@/components/forgot-password-sheet';
import { disarmShield, getArmedRoute, isShieldArmed } from '@/lib/shield-state';
import { getWindowInfo } from '@/lib/system-info';
import {
  abandonGuard,
  bumpGuard,
  claimFreshEntry,
  clearBackgroundNote,
  getLatestGeneration,
  notePageHidden,
  resolveEntryMode,
  retainGeneration,
  resumeGuard,
  startGuard,
} from '@/lib/page-guard';
import ErrorBoundary from '@/components/error-boundary';

// 本页 route（与 app.config.ts pages 一致），供 guard 做栈顶前台校验与代次归属
const PAGE_ROUTE = 'pages/login/index';

type Mode = 'signin' | 'signup';

/** 上次成功登录/注册的用户名（仅本机记忆，方便复用账号；不含任何密码信息） */
const LAST_USERNAME_KEY = '***';

function readLastUsername(): string {
  try {
    const v = Taro.getStorageSync(LAST_USERNAME_KEY);
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * 把底层异常翻译成用户能看懂、且**不泄露内部地址**的提示。
 *
 * 【为什么必须翻译】supabase-js 在网关拒绝时抛的是
 * `Failed to fetch: https://xxx.database.meoo.xyz/auth/v1/token?grant_type=password 状态码: 400`
 * —— 直接把内部域名、接口路径、状态码甩到 toast 上，用户既看不懂也不知道该做什么，
 * 还会误以为是自己密码错了。这里按错误特征归类成三类可行动提示：
 *   ① 凭据错误（invalid_grant / Invalid login credentials）→ 账号或密码错误
 *   ② 邮箱未验证（email_not_confirmed）→ 引导去验证
 *   ③ 网络/网关层失败（Failed to fetch / 状态码 4xx-5xx / timeout）→ 网络或服务异常，请重试
 * 其余情况原样透出（业务层自己抛的中文提示已经是可读的）。
 */
function toFriendlyAuthError(e: unknown): string {
  const raw = (e as Error)?.message || '';
  if (!raw) return '操作失败，请稍后重试';

  const lower = raw.toLowerCase();

  // ① 凭据类：不区分「账号不存在」与「密码错」，避免账号枚举
  if (
    lower.includes('invalid login credentials') ||
    lower.includes('invalid_grant') ||
    lower.includes('invalid credentials')
  ) {
    return '账号或密码错误，请重新输入';
  }

  // ② 邮箱未验证
  if (lower.includes('email not confirmed') || lower.includes('email_not_confirmed')) {
    return '该账号邮箱尚未验证，请先完成邮箱验证';
  }

  // ③ 网络 / 网关层：把内部 URL 与状态码全部吞掉，只给可行动提示
  if (
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('timeout') ||
    lower.includes('abort') ||
    /状态码:\s*\d{3}/.test(raw) ||
    /\b(4\d{2}|5\d{2})\b/.test(raw)
  ) {
    return '网络或服务暂时不可用，请检查网络后重试';
  }

  return raw;
}

export default function LoginPage() {
  const [username, setUsername] = useState(() => readLastUsername());
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('signin');
  // 注册模式必须勾选协议；条款全文页面内弹层展示（小程序不便跳外链）
  const [agreed, setAgreed] = useState(false);
  const [termsVisible, setTermsVisible] = useState(false);
  // 「忘记密码」弹层开关：重置成功后要顺带清掉密码输入，避免用户拿旧密码再点登录
  const [forgotVisible, setForgotVisible] = useState(false);
  // 密码可见性切换（明文/密文），默认密文；小眼睛整行可点，热区足够
  const [pwdVisible, setPwdVisible] = useState(false);
  // 120秒无操作自动返回 ping 页：起点/代次统一由模块级 page-guard 管理，
  // 组件内只持有本实例代次号（旧实例补跑一律静默忽略，防误踢新页面）。
  const genRef = useRef(0);

  /** 所有「离开 login 页」出口的统一收口：只有最新代次实例才允许发起跳转 */
  const exitToPing = (tag: string) => {
    if (genRef.current !== getLatestGeneration()) {
      console.log(`[login] 🛑 [GUARD_STALE] ${tag} 但本实例代次(${genRef.current})已过期, 忽略跳转`);
      return;
    }
    console.log(`[login] 🚪 [${tag}] 废弃计时, reLaunch 回 ping 页`);
    abandonGuard();
    Taro.reLaunch({ url: '/pages/ping/index' });
  };

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    const timeStr = new Date().toLocaleTimeString();
    // ⚠️ 原实现在 setInterval tick 里读存储的「当前活跃页」判归属——微信切后台会冻结
    // JS 定时器，回前台瞬间挂起的 tick 抢在 didShow 前补跑，读到旧值就把计时器 clear
    // 掉，导致「停在页面不操作也永不跳转」（本次 bug 根因）。
    const entry = resolveEntryMode(PAGE_ROUTE);
    if (entry.mode === 'stale') {
      console.log(`[login] 👻 [GUARD_STALE] [${timeStr}] didShow 但栈顶非本页(旧实例补触发), 忽略本次生命周期`);
      return;
    }
    genRef.current = entry.mode === 'resume' ? retainGeneration(PAGE_ROUTE) : claimFreshEntry(PAGE_ROUTE);
    clearBackgroundNote();

    // ② 遮挡兜底拦截：遮罩未解除期间（原生返回键/右滑等）落到本页，立即弹回被遮挡页。
    //    例外：被遮挡页已不在页面栈里（如遮挡后曾 reLaunch），弹回会把用户刚打开的本页
    //    顶走，此时直接解除遮挡、正常停留本页。与 chats/chat/profile 同款范式。
    if (isShieldArmed() && getArmedRoute() !== PAGE_ROUTE) {
      const armedInStack = Taro.getCurrentPages().some((p) => p.route === getArmedRoute());
      if (armedInStack) {
        console.log('[login] 🛡️ 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
        abandonGuard();
        Taro.reLaunch({ url: '/' + getArmedRoute() });
        return;
      }
      console.log('[login] 🛡️ 遮挡归属页已不在页面栈, 解除遮挡并停留本页');
      disarmShield();
    }

    const elapsed = entry.elapsedMs;
    console.log(`[login] 🧭 [${timeStr}] didShow — mode:`, entry.mode, '| 已流逝(s):', Math.floor(elapsed / 1000), '| 代次:', genRef.current);
    if (entry.mode === 'resume') {
      if (elapsed >= 120000) {
        console.log(`[login] 🔙 后台切回补判已超时(${Math.floor(elapsed / 1000)}秒)`);
        exitToPing('EXIT_RESUME');
        return;
      }
      resumeGuard(genRef.current);
    } else {
      startGuard({ pageRoute: PAGE_ROUTE, generation: genRef.current, onTimeout: () => exitToPing('EXIT_TICK') });
    }
  });

  // 页面隐藏时:记录 hide 时刻 + 仅停表（保留起点供后台切回补判）
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    console.log(`[login] 👻 [${timeStr}] useDidHide 触发, 记录 hide 时刻 + 仅停表(保留计时起点供切回补判)`);
    notePageHidden(PAGE_ROUTE);
  });

  const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;

  // custom 导航栏下需自绘顶栏：状态栏避让 + 胶囊右留白。
  // ⚠️ 与 ping/chats 同款范式：getMenuButtonBoundingClientRect 在 H5 预览会 reject Promise
  // （errMsg: 暂时不支持 API），同步 try-catch 捕不到 → 泄漏成 "Uncaught Object"；
  // 故仅在微信端调用，H5 直接回退固定留白。留白取「屏宽 - 胶囊左缘 + 8」，
  // 保证居中标题/右侧内容永不被胶囊压住。
  const sysInfo = getWindowInfo();
  const statusBarHeight = sysInfo.statusBarHeight ?? 20;
  const [capsuleRightPadding, setCapsuleRightPadding] = useState(96);
  useEffect(() => {
    if (!isWeapp) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect();
      const winW = sysInfo.windowWidth;
      if (rect && typeof rect.left === 'number' && rect.left > 0 && winW > 0) {
        setCapsuleRightPadding(Math.round(winW - rect.left + 8));
      }
    } catch (e) {
      console.log('[login] getMenuButtonBoundingClientRect 异常，回退固定留白');
    }
  }, [isWeapp, sysInfo]);
  console.log('[login] custom 导航栏生效，状态栏高度:', statusBarHeight, '胶囊右留白:', capsuleRightPadding);

  // 跳转由 store 订阅驱动：避免依赖 supabase 事件触发时机；也覆盖已登录用户误进本页自动跳走。
  // mount 时一次性消费暂存的 returnPath，避免后续访问拿到陈旧值
  useEffect(() => {
    const target = consumeReturnPath();
    const goBack = () => {
      console.log('[login] 检测到已登录，准备跳转到:', target);
      Taro.reLaunch({ url: target });
    };

    // 订阅 store 变化
    const unsubscribe = useAuthStore.subscribe((state, prev) => {
      if (state.user && !prev.user) {
        console.log('[login] subscribe 检测到 user 变化，触发跳转');
        goBack();
        return;
      }
      // 登录过期:曾经已登录(user非空)被鉴权链路清成未登录 → 自动跳回ping入口页
      if (!state.user && prev.user && prev.loaded) {
        console.log('[login] ⏰ 检测到登录态过期，自动跳转到ping页面');
        Taro.reLaunch({ url: '/pages/ping/index' });
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  async function submit(
    action: () => Promise<unknown>,
    options: { errorModalTitle?: string } = {},
  ) {
    Taro.showLoading({ title: '处理中...', mask: true });

    // 设置8秒超时保护,避免无限等待
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      Taro.hideLoading();
      Taro.showToast({
        title: '登录响应超时',
        icon: 'none',
        duration: 3000
      });
      console.warn('[login] 登录请求超过8秒未响应');
    }, 8000);

    try {
      await action();

      if (!timedOut) {
        clearTimeout(timeoutId);
        // 登录成功后立即隐藏 loading，即使跳转有延迟也不会一直转圈
        Taro.hideLoading();
        // 成功即记住本次用户名，下次进页自动预填（微信一键登录无用户名，不写）
        const uname = username.trim();
        if (uname) {
          try { Taro.setStorageSync(LAST_USERNAME_KEY, uname); } catch { /* 存储失败不影响登录 */ }
        }
        console.log('[login] 登录成功，等待 store 更新触发跳转');
        // 登录地点上报：让「登录地点」真正对应每次登录（此前只有进聊天页才记位置）。
        // ⚠️ 不 await：定位在真机首次可能要 3~8 秒，绝不能拖住登录跳转。
        // ⚠️ 必须现读 store 拿 uid：`submit` 的闭包里没有 user，且此刻 store 刚被
        //    onAuthStateChange 更新过，现读才拿得到真实账号。
        const uid = useAuthStore.getState().user?.id;
        if (uid) {
          void reportLoginLocation(uid);
        } else {
          console.warn('[login] 登录成功但 store 尚无 user，跳过登录定位上报');
        }
      }
    } catch (e) {
      if (!timedOut) {
        clearTimeout(timeoutId);
        Taro.hideLoading();
      }
      const message = toFriendlyAuthError(e);
      // ⚠️ 凭据类失败（密码错、账号不存在）是**预期内的业务结果**，绝不能 console.error——
      //    预览端会把 console.error 冒成 RUNTIME_ERROR 红条，用户会以为程序崩了。
      //    只有非预期异常才留 error 级日志。
      console.warn('[login] 登录/注册失败:', (e as Error)?.message || e);

      // 如果是超时后捕获的错误,不再重复提示
      if (timedOut) return;

      if (options.errorModalTitle) {
        Taro.showModal({
          title: options.errorModalTitle,
          content: message,
          confirmText: '知道了',
          showCancel: false,
        });
      } else {
        Taro.showToast({ title: message, icon: 'none', duration: 3000 });
      }
    }
  }

  const onPasswordSubmit = () => {
    if (!username || !password) {
      Taro.showToast({ title: '请输入用户名和密码', icon: 'none' });
      return;
    }
    // 协议勾选只在注册模式校验，老用户登录不受影响
    if (mode === 'signup' && !agreed) {
      Taro.showToast({ title: '请先阅读并同意用户协议', icon: 'none' });
      return;
    }
    const { signInWithUsername, signUpWithUsername } = useAuthStore.getState();
    // ⚠️ 暗号打点必须排在登录动作**之前**：signInWithPassword 成功后 supabase-js 会同步触发
    // onAuthStateChange('SIGNED_IN') → handleRealUser → recordLastLogin → takeSecretEntry()，
    // 打点若放在 await 之后，那一刻额度还是空的（bySecret=false）→ 只刷 last_login_at、
    // 不写 login_events，表现为「login 页登录永远不计上线次数」（实测「健康🎊」账号
    // last_seen_boundary_at 恒为 null、login_events 恒为 0 的根因）。
    // 登录失败时只留下一个 5 分钟自动过期的额度，不会误计数。
    markSecretEntry();
    console.log(`[login] 🔑 账密登录(${mode})已打暗号进入点，本次将计入上线次数`);
    submit(() =>
      mode === 'signin'
        ? signInWithUsername(username, password)
        : signUpWithUsername(username, password),
    );
  };

  const onWeappLogin = () => {
    if (!isWeapp) {
      Taro.showModal({
        title: '微信登录不可用',
        content: '微信一键登录仅在微信小程序内支持。',
        confirmText: '知道了',
        showCancel: false,
      });
      return;
    }
    // 同 onPasswordSubmit：打点必须在登录动作之前，否则 auth 回调先跑、额度还没打上
    markSecretEntry();
    console.log('[login] 🔑 微信一键登录已打暗号进入点，本次将计入上线次数');
    submit(() => useAuthStore.getState().signInWithWeapp(), {
      errorModalTitle: '微信登录失败',
    });
  };

  return (
    <ErrorBoundary route="pages/login/index">
    <PrivacyShield>
      <View className="min-h-screen bg-background flex flex-col">
        {/* custom 导航栏顶栏（与 chat 详情页同款范式）：bg-card + 下边框、chevron-left 返回键、
            居中标题。整行铺满宽度，paddingRight 按胶囊实际位置避让，标题绝对居中不被胶囊压住。 */}
        <View
          className="relative w-full flex flex-row items-center px-3 py-3 bg-card border-b border-border"
          style={{ paddingTop: `${statusBarHeight + 12}px`, paddingRight: `${capsuleRightPadding}px` }}
        >
          <View
            className="w-8 h-8 flex items-center justify-center shrink-0 -ml-1"
            onClick={() => exitToPing('EXIT_BACK')}
          >
            <View className="i-lucide-chevron-left w-6 h-6 text-foreground" />
          </View>
          <Text
            className="absolute left-0 right-0 text-center text-lg font-bold text-foreground pointer-events-none"
            style={{ paddingLeft: `${capsuleRightPadding}px` }}
          >
            {mode === 'signin' ? '登录' : '注册'}
          </Text>
        </View>

        {/* 页面主体：保持原有的居中列布局 */}
        <View className="flex-1 flex flex-col items-center px-6 pt-12">
        <Text className="text-sm text-muted-foreground mb-10">
          {mode === 'signin' ? '欢迎回来' : '创建一个新账号'}
        </Text>

      <View className="w-full bg-card border border-border rounded-lg p-4 mb-3">
        <Input
          className="w-full bg-transparent text-foreground"
          type="text"
          value={username}
          placeholder="用户名"
          placeholderClass="text-muted-foreground"
          onInput={(e) => {
            setUsername(e.detail.value);
            console.log('[login] 🏷️ 输入用户名, 重置 120 秒起点'); bumpGuard(genRef.current);
          }}
        />
      </View>

      <View className="w-full bg-card border border-border rounded-lg p-4 mb-6 flex flex-row items-center">
        <Input
          className="flex-1 bg-transparent text-foreground"
          password={!pwdVisible}
          value={password}
          placeholder="密码"
          placeholderClass="text-muted-foreground"
          onInput={(e) => {
            setPassword(e.detail.value);
            console.log('[login] 🏷️ 输入密码, 重置 120 秒起点'); bumpGuard(genRef.current);
          }}
        />
        {/* 小眼睛：切换密码明文/密文（命中区含左右 padding，约 44px） */}
        <View
          className="pl-3 py-2 shrink-0 cursor-pointer"
          onClick={() => {
            setPwdVisible(!pwdVisible);
            bumpGuard(genRef.current);
          }}
        >
          {/* 类名必须字面量三元：动态拼接 `i-lucide-${...}` Tailwind 扫描不到，
              实测 dist/app-origin.wxss 里 .i-lucide-eye/.i-lucide-eye-off 均缺失，图标渲染为空白 */}
          <View className={pwdVisible ? 'i-lucide-eye-off w-5 h-5 text-muted-foreground' : 'i-lucide-eye w-5 h-5 text-muted-foreground'} />
        </View>
      </View>

      {/* 注册模式的协议勾选行（登录模式不显示，不影响老用户） */}
      {mode === 'signup' && (
        <View className="w-full flex flex-row items-start mb-3">
          <View
            className={`w-4 h-4 rounded mr-2 shrink-0 flex items-center justify-center border ${agreed ? 'bg-primary border-primary' : 'border-border'}`}
            style={{ marginTop: '2px' }}
            onClick={() => {
              setAgreed(!agreed);
              bumpGuard(genRef.current);
            }}
          >
            {agreed && <View className="i-lucide-check w-3 h-3 text-primary-foreground" />}
          </View>
          <View className="flex flex-row flex-wrap items-center">
            <Text className="text-xs text-muted-foreground">我已阅读并同意</Text>
            <Text
              className="text-xs text-primary"
              onClick={() => {
                setTermsVisible(true);
                bumpGuard(genRef.current);
              }}
            >
              《用户协议与隐私政策》
            </Text>
          </View>
        </View>
      )}

      <View
        className={`w-full rounded-lg py-3 flex items-center justify-center ${mode === 'signup' && !agreed ? 'bg-secondary' : 'bg-primary'}`}
        onClick={() => {
          onPasswordSubmit();
          console.log('[login] 🏷️ 点击登录/注册, 重置 120 秒起点'); bumpGuard(genRef.current);
        }}
      >
        <Text className={`font-medium ${mode === 'signup' && !agreed ? 'text-muted-foreground' : 'text-primary-foreground'}`}>
          {mode === 'signin' ? '登录' : '注册'}
        </Text>
      </View>

      <View className="w-full flex items-center justify-between mt-4">
        <View
          className="py-2"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            console.log('[login] 🏷️ 切换登录/注册模式, 重置 120 秒起点'); bumpGuard(genRef.current);
          }}
        >
          <Text className="text-sm text-primary">
            {mode === 'signin' ? '还没有账号？立即注册' : '已有账号？立即登录'}
          </Text>
        </View>

        {/* 「忘记密码」仅在登录态下有意义，注册模式隐藏入口 */}
        {mode === 'signin' ? (
          <View
            className="py-2"
            onClick={() => {
              setForgotVisible(true);
              console.log('[login] 🏷️ 打开忘记密码, 重置 120 秒起点'); bumpGuard(genRef.current);
            }}
          >
            <Text className="text-sm text-muted-foreground">忘记密码？</Text>
          </View>
        ) : null}
      </View>

      <View className="w-full flex items-center gap-3 my-8">
        <View className="flex-1 h-px bg-muted" />
        <Text className="text-xs text-muted-foreground">或</Text>
        <View className="flex-1 h-px bg-muted" />
      </View>

      <View
        className="w-full bg-card border-2 border-wechat rounded-lg py-3 flex items-center justify-center gap-2"
        onClick={() => {
          onWeappLogin();
          console.log('[login] 🏷️ 点击微信一键登录, 重置 120 秒起点'); bumpGuard(genRef.current);
        }}
      >
        <View className="i-mdi-wechat w-5 h-5 text-wechat" />
        <Text className="text-foreground font-medium">微信一键登录</Text>
      </View>

      {/* 条款全文弹层（页面内展示，纯文本） */}
      {termsVisible && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-8"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => setTermsVisible(false)}
        >
          <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-lg font-bold text-foreground mb-3">用户协议与隐私政策</Text>
            <View className="mb-4">
              <Text className="block text-sm font-bold text-foreground mb-1">一、服务说明</Text>
              <Text className="block text-xs text-muted-foreground leading-relaxed mb-3">
                「网络查看」提供网络连通性诊断与 AI 解读功能。账号仅用于识别你的身份、保存你的诊断记录。
              </Text>
              <Text className="block text-sm font-bold text-foreground mb-1">二、数据与隐私</Text>
              <Text className="block text-xs text-muted-foreground leading-relaxed mb-3">
                你上传的头像及诊断目标地址仅用于向你本人提供服务，不会用于其他用途。诊断历史、AI 会话等缓存默认只保存在本机，可在「我的」页面随时清除。
              </Text>
              <Text className="block text-sm font-bold text-foreground mb-1">三、账号安全</Text>
              <Text className="block text-xs text-muted-foreground leading-relaxed mb-3">
                请妥善保管用户名与密码。建议设置真实邮箱以便找回密码；离开设备前请退出登录或依赖应用的自动防护。
              </Text>
              <Text className="block text-sm font-bold text-foreground mb-1">四、使用规范</Text>
              <Text className="block text-xs text-muted-foreground leading-relaxed">
                不得利用本服务传播违法信息、骚扰他人或探测未经授权的网络目标。违规账号可能被停止服务。
              </Text>
            </View>
            <View
              className="bg-primary rounded-lg py-3 flex items-center justify-center"
              onClick={() => {
                setAgreed(true);
                setTermsVisible(false);
                bumpGuard(genRef.current);
              }}
            >
              <Text className="text-primary-foreground font-medium">已阅读并同意</Text>
            </View>
          </View>
        </View>
      )}

      {forgotVisible ? (
        <ForgotPasswordSheet
          onClose={() => setForgotVisible(false)}
          onActivity={() => bumpGuard(genRef.current)}
          onResetSuccess={(email) => {
            // 重置成功：清掉旧密码输入，回到登录模式。用户名不回填——用户填的是邮箱，
            // 而账密登录框要的是用户名，两者不能混用。
            console.log('[login] 🔑 密码已重置（', email, '），清空密码输入并切回登录');
            setPassword('');
            setMode('signin');
            setForgotVisible(false);
          }}
        />
      ) : null}
        </View>
      </View>
    </PrivacyShield>
    </ErrorBoundary>
  );
}
