import { DEV } from '../../utils/dev';
import { useEffect, useState, useRef } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { View, Text, Input } from '@tarojs/components';
import { useAuthStore } from '@/store/auth-store';
import { consumeReturnPath } from '@/lib/redirect-to-login';
import { setPageSwitching, resetPageSwitching, setCurrentPage, getCurrentPage } from '@/lib/inactivity-timer';

type Mode = 'signin' | 'signup';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<Mode>('signin');
  const timerIdCounter = useRef<number>(0); // 计时器ID计数器,用于验证setTimeout是否是当前有效的

  // 无操作计时器（v1.0.33 内联实现）
  const timerStartTimeRef = useRef<number>(0);
  const inactivityTimerRef = useRef<any>(null);
  const INACTIVITY_TIMEOUT_MS = 120_000; // 120秒

  const resetInactivityTimer = () => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
    }
    timerStartTimeRef.current = Date.now();
    inactivityTimerRef.current = setTimeout(() => {
      [DEV]('[login] ⏰ 无操作120秒，自动返回Ping页');
      inactivityTimerRef.current = null;
      timerStartTimeRef.current = 0;
      Taro.reLaunch({ url: '/pages/ping/index' });
    }, INACTIVITY_TIMEOUT_MS);
  };

  const checkInactivityTimeout = () => {
    if (!timerStartTimeRef.current) return;
    const elapsed = Date.now() - timerStartTimeRef.current;
    if (elapsed >= INACTIVITY_TIMEOUT_MS) {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
        inactivityTimerRef.current = null;
      }
      timerStartTimeRef.current = 0;
      [DEV]('[login] ⏰ 进入时已超时，立即返回Ping页');
      Taro.reLaunch({ url: '/pages/ping/index' });
    }
  };

  useDidShow(() => {
    const currentPage = getCurrentPage();
    setCurrentPage('login');
    const isPageSwitch = currentPage !== '' && currentPage !== 'login';
    if (isPageSwitch) {
      resetInactivityTimer();
    } else if (timerStartTimeRef.current) {
      checkInactivityTimeout();
    } else {
      resetInactivityTimer();
    }
  });

  useDidHide(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    timerStartTimeRef.current = 0;
    setPageSwitching(true);
  });

  const isWeapp = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  const isAlipay = Taro.getEnv() === Taro.ENV_TYPE.ALIPAY;
  const isBaidu = Taro.getEnv() === Taro.ENV_TYPE.SWAN;

  // 跳转由 store 订阅驱动：避免依赖 supabase 事件触发时机；也覆盖已登录用户误进本页自动跳走。
  // mount 时一次性消费暂存的 returnPath，避免后续访问拿到陈旧值
  useEffect(() => {
    const target = consumeReturnPath();
    const goBack = () => {
      [DEV]('[login] 检测到已登录，准备跳转到:', target);
      Taro.reLaunch({ url: target });
    };

    // 订阅 store 变化
    const unsubscribe = useAuthStore.subscribe((state, prev) => {
      if (state.user && !prev.user) {
        [DEV]('[login] subscribe 检测到 user 变化，触发跳转');
        goBack();
        return;
      }
      // 登录过期:曾经已登录(user非空)被鉴权链路清成未登录 → 自动跳回ping入口页
      if (!state.user && prev.user && prev.loaded) {
        [DEV]('[login] ⏰ 检测到登录态过期，自动跳转到ping页面');
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
        [DEV]('[login] 登录成功，等待 store 更新触发跳转');
      }
    } catch (e) {
      if (!timedOut) {
        clearTimeout(timeoutId);
        Taro.hideLoading();
      }
      const error = e as Error & { errorType?: string };
      const message = error.message;
      const errorType = error.errorType || '';
      
      console.error('[login] 登录/注册失败:', error);

      // 如果是超时后捕获的错误,不再重复提示
      if (timedOut) return;

      // 根据错误类型返回友好提示
      let displayMessage = message;
      if (mode === 'signin') {
        if (errorType === 'invalid_credentials' || message.includes('Invalid')) {
          displayMessage = '用户名或密码错误';
        } else if (errorType === 'user_not_found' || message.includes('not found') || message.includes('does not exist')) {
          displayMessage = '该用户名尚未注册';
        } else if (errorType === 'rate_limit' || message.includes('rate limit')) {
          displayMessage = '登录尝试过多，请稍后再试';
        } else if (errorType === 'email_not_confirmed') {
          displayMessage = '请先验证邮箱';
        }
      } else {
        if (message.includes('already') || message.includes('exists')) {
          displayMessage = '该用户名已存在，请直接登录';
        } else if (message.includes('weak')) {
          displayMessage = '密码强度不够，请至少6位';
        } else if (message.includes('validation') || message.includes('format')) {
          displayMessage = '用户名格式不正确';
        }
      }

      if (options.errorModalTitle) {
        Taro.showModal({
          title: options.errorModalTitle,
          content: displayMessage,
          confirmText: '知道了',
          showCancel: false,
        });
      } else {
        Taro.showToast({ title: displayMessage, icon: 'none', duration: 3000 });
      }
    }
  }

  const onPasswordSubmit = () => {
    if (!username || !password) {
      Taro.showToast({ title: '请输入用户名和密码', icon: 'none' });
      return;
    }
    const { signInWithUsername, signUpWithUsername } = useAuthStore.getState();
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
    submit(() => useAuthStore.getState().signInWithWeapp(), {
      errorModalTitle: '微信登录失败',
    });
  };

  const onAlipayLogin = () => {
    if (!isAlipay) {
      Taro.showModal({
        title: '支付宝登录不可用',
        content: '支付宝一键登录仅在支付宝小程序内支持。',
        confirmText: '知道了',
        showCancel: false,
      });
      return;
    }
    submit(() => useAuthStore.getState().signInWithAlipay(), {
      errorModalTitle: '支付宝登录失败',
    });
  };

  const onBaiduLogin = () => {
    if (!isBaidu) {
      Taro.showModal({
        title: '百度登录不可用',
        content: '百度一键登录仅在百度智能小程序内支持。',
        confirmText: '知道了',
        showCancel: false,
      });
      return;
    }
    submit(() => useAuthStore.getState().signInWithBaidu(), {
      errorModalTitle: '百度登录失败',
    });
  };

  return (
    <View className="min-h-screen bg-background flex flex-col items-center px-6 pt-20">
      {/* 调试信息:显示计时器状态 */}
      {/* 计时器状态条已隐藏,功能保留 */}
      {/* <View className="fixed top-0 left-0 right-0 px-4 py-2 bg-yellow-100 border-b border-yellow-300 z-50">
        <Text className="text-xs text-yellow-800">⏱️ 计时器状态: {timerStatus}</Text>
      </View> */}
      <Text className="text-2xl font-bold text-foreground mb-2">
        {mode === 'signin' ? '登录' : '注册'}
      </Text>
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
          }}
        />
      </View>

      <View className="w-full bg-card border border-border rounded-lg p-4 mb-6">
        <Input
          className="w-full bg-transparent text-foreground"
          password
          value={password}
          placeholder="密码"
          placeholderClass="text-muted-foreground"
          onInput={(e) => {
            setPassword(e.detail.value);
          }}
        />
      </View>

      <View
        className="w-full bg-primary rounded-lg py-3 flex items-center justify-center"
        onClick={() => {
          onPasswordSubmit();
        }}
      >
        <Text className="text-primary-foreground font-medium">
          {mode === 'signin' ? '登录' : '注册'}
        </Text>
      </View>

      <View
        className="mt-4 py-2"
        onClick={() => {
          setMode(mode === 'signin' ? 'signup' : 'signin');
        }}
      >
        <Text className="text-sm text-primary">
          {mode === 'signin' ? '还没有账号？立即注册' : '已有账号？立即登录'}
        </Text>
      </View>

      <View className="w-full flex items-center gap-3 my-8">
        <View className="flex-1 h-px bg-muted" />
        <Text className="text-xs text-muted-foreground">或</Text>
        <View className="flex-1 h-px bg-muted" />
      </View>

      <View
        className="w-full bg-card border-2 border-wechat rounded-lg py-3 flex items-center justify-center gap-2 mb-3"
        onClick={() => {
          onWeappLogin();
        }}
      >
        <View className="i-mdi-wechat w-5 h-5 text-wechat" />
        <Text className="text-foreground font-medium">微信一键登录</Text>
      </View>

      {(isAlipay || isBaidu) && (
        <View
          className="w-full bg-card border-2 border-alipay rounded-lg py-3 flex items-center justify-center gap-2 mb-3"
          onClick={() => {
            onAlipayLogin();
          }}
        >
          <Text className="text-alipay font-bold text-lg">支</Text>
          <Text className="text-foreground font-medium">支付宝一键登录</Text>
        </View>
      )}

      {isBaidu && (
        <View
          className="w-full bg-card border-2 border-baidu rounded-lg py-3 flex items-center justify-center gap-2"
          onClick={() => {
            onBaiduLogin();
          }}
        >
          <View className="w-5 h-5 rounded-full bg-baidu" />
          <Text className="text-foreground font-medium">百度一键登录</Text>
        </View>
      )}
    </View>
  );
}
