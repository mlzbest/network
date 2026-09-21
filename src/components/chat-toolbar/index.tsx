import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { selectMediaFiles, uploadToSupabase } from '@/lib/upload';
import { supabaseUrl, supabaseAnonKey, supabase } from '@/supabase/client';

interface ChatToolbarProps {
  onSendImage: (url: string) => Promise<void>;
  onSendVoice: () => void;
  onToggleEmoji: () => void;
}

export default function ChatToolbar({ onSendImage, onSendVoice, onToggleEmoji }: ChatToolbarProps) {
  const [uploading, setUploading] = useState(false);

  const handleSelectImage = async () => {
    if (uploading) return;
    try {
      setUploading(true);
      Taro.showLoading({ title: '上传中...' });

      const files = await selectMediaFiles({ count: 1, mediaType: ['image'] });
      if (files.length === 0) {
        Taro.hideLoading();
        return;
      }

      // 使用统一的上传函数(自动处理小程序/Web环境)
      const file = files[0];
      const result = await uploadToSupabase(file, { bucket: 'chat-media' });

      if (!result.success) {
        throw new Error(result.error || '上传失败');
      }

      // 获取公开 URL
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${result.data.path}`;

      await onSendImage(publicUrl);
      Taro.showToast({ title: '发送成功', icon: 'success' });
    } catch (e: any) {
      console.error('上传图片失败:', e);
      Taro.showToast({ title: e.message || '上传失败', icon: 'none' });
    } finally {
      setUploading(false);
      Taro.hideLoading();
    }
  };

  return (
    <View className="flex flex-row items-center gap-5 px-3 py-2">
      {/* 表情按钮 */}
      <View onClick={onToggleEmoji} className="flex items-center justify-center w-8 h-8">
        <View className="i-lucide-smile w-6 h-6 text-muted-foreground" />
      </View>

      {/* 图片按钮 */}
      <View
        onClick={handleSelectImage}
        className={`flex items-center justify-center w-8 h-8 ${uploading ? 'opacity-50' : ''}`}
      >
        <View className="i-lucide-image w-6 h-6 text-muted-foreground" />
      </View>

      {/* 语音按钮 */}
      <View onClick={onSendVoice} className="flex items-center justify-center w-8 h-8">
        <View className="i-lucide-mic w-6 h-6 text-muted-foreground" />
      </View>
    </View>
  );
}
