import { supabase } from '@/supabase/client';
import type { Database } from '@/supabase/types';

export type Profile = Database['public']['Tables']['profiles']['Row'];

/** 获取所有用户资料（用于用户列表选人发起聊天） */
export async function listProfiles(): Promise<Profile[]> {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('查询用户列表失败，降级为空数组:', error.message);
      return [];
    }
    return data ?? [];
  } catch (err) {
    // 云服务不可用(502/网络错误)时降级处理
    console.warn('查询用户列表异常，降级为空数组:', err);
    return [];
  }
}

/** 获取单个用户资料 */
export async function getProfile(id: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`查询用户资料失败: ${error.message}`);
  return data;
}

/** 更新自己的资料（昵称、头像） */
export async function updateProfile(
  id: string,
  input: { nickname?: string; avatar_url?: string },
): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .update(input)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`更新资料失败: ${error.message}`);
  if (!data) throw new Error('更新资料失败：可能被 RLS 策略拦截');
  return data;
}
