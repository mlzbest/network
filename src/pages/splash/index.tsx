import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useState, useEffect } from 'react';
import { useAuthStore } from '@/store/auth-store';

export default function SplashPage() {
  const { user, loaded } = useAuthStore();
  const [done, setDone] = useState(false);

  useDidShow(() => {
    if (done) return;
    const timer = setTimeout(() => {
      setDone(true);
      // 已登录 → 聊天列表，未登录 → ping 入口
      if (loaded && user) {
        Taro.reLaunch({ url: '/pages/chats/index' });
      } else {
        Taro.reLaunch({ url: '/pages/ping/index' });
      }
    }, 1500);
    return () => clearTimeout(timer);
  });

  return (
    <View className="splash-page">
      <Text className="splash-text">心静 自然清</Text>
    </View>
  );
}
