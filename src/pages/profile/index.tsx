import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useAuthStore } from '@/store/auth-store';
import { redirectToLogin } from '@/lib/redirect-to-login';
import PrivacyShield from '@/components/privacy-shield';
import { useInactivityTimer } from '@/lib/use-inactivity-timer';

function getDisplayName(user: { user_metadata?: { nickname?: string; username?: string } } | null): string {
  const meta = user?.user_metadata ?? {};
  return meta.nickname || meta.username || '微信用户';
}

function getInitial(name: string): string {
  return name.charAt(0) || '?';
}

export default function ProfilePage() {
  const { user, loaded, signOut } = useAuthStore();

  // 使用共享的无操作超时 Hook
  const { startTimer, checkTimeout, clearTimer } = useInactivityTimer('profile');

  if (!loaded) {
    return (
      <View className="min-h-screen bg-background flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    );
  }

  if (!user) return null;

  const name = getDisplayName(user);

  const handleSignOut = async () => {
    const confirm = await Taro.showModal({
      title: '确认退出',
      content: '退出后需要重新登录',
      confirmText: '退出',
      cancelText: '取消',
    });
    if (confirm.confirm) {
      try {
        await signOut();
        Taro.reLaunch({ url: '/pages/chats/index' });
      } catch (e) {
        Taro.showToast({ title: (e as Error).message, icon: 'none' });
      }
    }
  };

  return (
    <PrivacyShield>
      <View className="min-h-screen flex flex-col items-center pt-16 px-6 bg-background">
        <View className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-4">
          <Text className="text-secondary-foreground text-2xl font-bold">{getInitial(name)}</Text>
        </View>
        <Text className="text-xl font-bold text-foreground mb-2">{name}</Text>

        <View
          className="w-full bg-card border border-border rounded-lg py-3 flex items-center justify-center mt-12"
          onClick={handleSignOut}
        >
          <Text className="text-destructive font-medium">退出登录</Text>
        </View>
      </View>
    </PrivacyShield>
  );
}
