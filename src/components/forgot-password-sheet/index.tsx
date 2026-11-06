import { useEffect, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import { View, Text, Input } from '@tarojs/components';
import {
  NoRealEmailError,
  resetPasswordWithCode,
  sendPasswordRecoveryCode,
} from '@/api/auth';
import { logDbg } from '@/lib/logger';

interface ForgotPasswordSheetProps {
  /** 关闭弹层 */
  onClose: () => void;
  /** 每次交互都要刷新 120 秒无操作计时起点 */
  onActivity: () => void;
  /** 密码重置成功：调用方应清空密码输入并回到登录态 */
  onResetSuccess: (account: string) => void;
}

type Step = 'send' | 'verify';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
/** 重新发送倒计时（秒），略短于服务端令牌 10 分钟有效期 */
const RESEND_COOLDOWN = 60;

/**
 * 「忘记密码」弹层：两步式。
 * ① 输入注册邮箱 → 服务端生成恢复令牌并用 SMTP 发到该邮箱；
 * ② 输入邮件里的数字验证码 + 新密码 → 服务端校验令牌哈希后改写密码。
 *
 * 之所以把两步都放在服务端（而不是前端 supabase.auth.verifyOtp）：本应用账密登录的
 * email 可能是 `{username}@meoo.local` 占位地址，与按真实邮箱生成的 recovery 令牌对不上，
 * 前端直连必然失败。实现见 functions/set-account-email/shared/password-recovery.ts
 * （挂在 set-account-email 函数内路由，为节省云函数额度不单独开新函数）。
 */
export function ForgotPasswordSheet({
  onClose,
  onActivity,
  onResetSuccess,
}: ForgotPasswordSheetProps) {
  const [step, setStep] = useState<Step>('send');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    };
  }, []);

  const startCooldown = () => {
    setCooldown(RESEND_COOLDOWN);
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current);
    cooldownTimerRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownTimerRef.current) {
            clearInterval(cooldownTimerRef.current);
            cooldownTimerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  /** 统一执行 + loading/toast 反馈（Edge Function 冷启动可能较慢，超时给足 30 秒） */
  const run = async (action: () => Promise<unknown>, pendingTitle: string) => {
    if (busy) return;
    setBusy(true);
    Taro.showLoading({ title: pendingTitle, mask: true });
    try {
      await action();
      Taro.hideLoading();
    } catch (e) {
      Taro.hideLoading();
      const message = (e as Error).message || '操作失败，请稍后再试';
      console.error('[forgot-password] 失败:', e);
      if (e instanceof NoRealEmailError) {
        // 该账号还没绑定可用邮箱：给出可执行的下一步，而不是笼统报错
        Taro.showModal({
          title: '无法发送重置邮件',
          content: `${message}\n\n若你记得当前密码，可先登录后在「我的」页面填写自己的真实邮箱。`,
          confirmText: '知道了',
          showCancel: false,
        });
      } else {
        Taro.showToast({ title: message, icon: 'none', duration: 3000 });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleSend = () => {
    const trimmed = email.trim();
    if (!trimmed) {
      Taro.showToast({ title: '请输入注册邮箱', icon: 'none' });
      return;
    }
    if (!EMAIL_RE.test(trimmed)) {
      Taro.showToast({ title: '邮箱格式不正确', icon: 'none' });
      return;
    }
    void run(async () => {
      const result = await sendPasswordRecoveryCode(trimmed);
      setMaskedEmail(result.maskedEmail);
      setStep('verify');
      startCooldown();
      logDbg('[login] 🔑 重置验证码邮件已投递至', result.maskedEmail || '(未透露)');
      Taro.showToast({ title: '验证码已发送到邮箱', icon: 'none', duration: 3000 });
    }, '正在发送验证码...');
  };

  const handleSubmitReset = () => {
    if (!/^\d{4,10}$/.test(code.trim())) {
      Taro.showToast({ title: '请输入邮件中的数字验证码', icon: 'none' });
      return;
    }
    if (newPassword.length < 6) {
      Taro.showToast({ title: '新密码至少 6 位', icon: 'none' });
      return;
    }
    void run(async () => {
      // username 由「发送验证码」的响应带回（见 api/auth.ts），此处无需用户再输一遍
      await resetPasswordWithCode(code.trim(), newPassword);
      Taro.showModal({
        title: '密码已重置',
        content: '请用新密码登录。',
        confirmText: '去登录',
        showCancel: false,
        success: () => {
          setCode('');
          setNewPassword('');
          onResetSuccess(email.trim().toLowerCase());
        },
      });
    }, '正在重置密码...');
  };

  return (
    <View
      className="fixed inset-0 z-50 flex items-center justify-center px-8"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
      onClick={onClose}
    >
      <View
        className="w-full bg-card rounded-xl p-6"
        onClick={(e) => {
          e.stopPropagation();
          onActivity();
        }}
      >
        <Text className="text-lg font-bold text-foreground">
          {step === 'send' ? '忘记密码' : '设置新密码'}
        </Text>
        <Text className="text-sm text-muted-foreground mt-1 leading-6">
          {step === 'send'
            ? '输入注册时使用的邮箱，我们会把重置验证码发到这里。'
            : `验证码已发送至 ${maskedEmail || '你的邮箱'}，10 分钟内有效。`}
        </Text>

        <View className="bg-secondary rounded-lg px-4 py-3 mt-4">
          <Input
            className="w-full bg-transparent text-foreground"
            type="text"
            value={email}
            placeholder="注册邮箱"
            placeholderClass="text-muted-foreground"
            disabled={step === 'verify'}
            onInput={(e) => {
              setEmail(e.detail.value);
              onActivity();
            }}
          />
        </View>

        {step === 'verify' ? (
          <>
            <View className="bg-secondary rounded-lg px-4 py-3 mt-3">
              <Input
                className="w-full bg-transparent text-foreground"
                type="number"
                maxlength={10}
                value={code}
                placeholder="邮件中的数字验证码"
                placeholderClass="text-muted-foreground"
                onInput={(e) => {
                  setCode(e.detail.value);
                  onActivity();
                }}
              />
            </View>
            <View className="bg-secondary rounded-lg px-4 py-3 mt-3">
              <Input
                className="w-full bg-transparent text-foreground"
                password
                value={newPassword}
                placeholder="新密码（至少 6 位）"
                placeholderClass="text-muted-foreground"
                onInput={(e) => {
                  setNewPassword(e.detail.value);
                  onActivity();
                }}
              />
            </View>
          </>
        ) : null}

        <View className="flex flex-row gap-3 mt-6">
          <View
            className="flex-1 bg-secondary rounded-lg py-3 flex items-center justify-center"
            onClick={() => {
              if (step === 'verify') {
                setStep('send');
                setCode('');
                setNewPassword('');
              } else {
                onClose();
              }
              onActivity();
            }}
          >
            <Text className="text-muted-foreground">{step === 'verify' ? '返回' : '取消'}</Text>
          </View>

          {step === 'send' ? (
            <View
              className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
              onClick={handleSend}
            >
              <Text className="text-primary-foreground font-medium">
                {busy ? '发送中...' : '发送验证码'}
              </Text>
            </View>
          ) : (
            <View
              className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
              onClick={handleSubmitReset}
            >
              <Text className="text-primary-foreground font-medium">
                {busy ? '提交中...' : '确认重置'}
              </Text>
            </View>
          )}
        </View>

        {step === 'verify' ? (
          <View
            className="mt-4 flex items-center justify-center"
            onClick={() => {
              if (cooldown > 0 || busy) {
                Taro.showToast({ title: `请 ${cooldown} 秒后再试`, icon: 'none' });
              } else {
                handleSend();
              }
              onActivity();
            }}
          >
            <Text className={`text-sm ${cooldown > 0 ? 'text-muted-foreground' : 'text-primary'}`}>
              {cooldown > 0 ? `重新发送（${cooldown}s）` : '没收到？重新发送验证码'}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}
