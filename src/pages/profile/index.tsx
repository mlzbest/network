import { View, Text, Input, Image } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useAuthStore } from '@/store/auth-store';
import { getAccountEmail } from '@/api/auth';
import { redirectToLogin } from '@/lib/redirect-to-login';
import { useRef, useEffect, useState, useCallback } from 'react';
import * as profilesApi from '@/api/profiles';
import { useProfilesStore } from '@/store/profiles-store';
import { getWindowInfo } from '@/lib/system-info';
import { logDbg } from '@/lib/logger';
import { uploadToSupabase, selectMediaFiles, compressAndUploadAvatar } from '@/lib/upload';
import { supabaseUrl } from '@/supabase/client';
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
import PrivacyShield from '@/components/privacy-shield';
import ChangelogList from '@/components/changelog-list';
import { formatVersionLabel, RELEASE_VERSION, buildChangelogList, withCurrentVersionPlaceholder } from '@/lib/app-release';
import { isShieldArmed, getArmedRoute, setMediaPickerGrace, endMediaPickerGrace } from '@/lib/shield-state';
import { clearDiagHistory } from '@/lib/diag-history';
import { clearAllAiStorage } from '@/lib/ai-store';
import { markChatExit } from '@/lib/secret-entry';
import { reportPresence } from '@/lib/presence';
import { clearPresenceQueue } from '@/lib/presence-queue';
import ErrorBoundary from '@/components/error-boundary';
import ErrorLogPanel from '@/components/error-log-panel';

// 本页 route（与 app.config.ts pages 一致），供 guard 做栈顶前台校验与代次归属
const PAGE_ROUTE = 'pages/profile/index';

function getDisplayName(user: { user_metadata?: { nickname?: string; username?: string } } | null): string {
  const meta = user?.user_metadata ?? {};
  return meta.nickname || meta.username || '微信用户';
}

function getInitial(name: string): string {
  return name.charAt(0) || '?';
}

/**
 * 「关于」里的版本号真源解析（按可信度从高到低取第一个可用值）：
 * ① 微信小程序后台的**实际发布版本号** —— `getAccountInfoSync().miniProgram.version`
 *    （仅正式版返回，形如 `64`；开发版与体验版该字段为空字符串）
 * ② 兜底 `APP_RELEASE_VERSION`（构建期注入，真源是 src/lib/app-release.ts 的 CHANGELOG
 *    顶部条目，由 config/app-version.cjs 解析并同步到 package.json）。
 * ⚠️ 为什么不直接用 package.json 的 version：那个值历史上长期停在脚手架占位、从不递增。
 *    现在它由构建脚本自动对齐 CHANGELOG，所以两者等价；前端统一读注入常量，避免运行时
 *    依赖文件读取。正式版仍以微信回包为准。
 * ⚠️ 展示格式统一走 `formatVersionLabel`（大写 V + 纯数字发布序号，如 `V64`）——
 *    与更新日志条目同源同格式，避免两处前缀/大小写不一致。
 * ⚠️ Taro 类型里 miniProgram 只有 appId/envVersion/version 三字段，真机透传的其它字段
 *    需先断言再取用。
 *
 * ⚠️ **必须先按环境门控，不能只靠 try/catch**（H5 预览实测踩过）：
 *    `Taro.getAccountInfoSync()` 在 H5 端**返回 rejected Promise**（errMsg:
 *    `getAccountInfoSync:fail 暂时不支持 API`），同步 try/catch **捕不到**，
 *    会冒成 `unhandledrejection` → 控制台 `Uncaught Object`。
 *    与 `getMenuButtonBoundingClientRect` 是同一类坑（见 AGENTS.md 自绘导航栏条目），
 *    统一做法：先用 `Taro.getEnv() === Taro.ENV_TYPE.WEAPP` 门控，非小程序端直接走兜底分支。
 */
function resolveAppVersion(): { text: string; source: string; raw: string } {
  const fallback = { text: formatVersionLabel(APP_RELEASE_VERSION), source: '构建版本', raw: APP_RELEASE_VERSION };
  // 非微信小程序端（H5 预览 / 其它端）没有账号信息接口，直接兜底，避免 rejected Promise 冒成未捕获异常
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) return fallback;
  try {
    const info = Taro.getAccountInfoSync();
    const mp = info?.miniProgram as { appId?: string; envVersion?: string; version?: string } | undefined;
    const envVersion = mp?.envVersion ?? '';
    const released = (mp?.version ?? '').trim();
    if (released) return { text: formatVersionLabel(released), source: '微信正式版', raw: released };
    return {
      text: formatVersionLabel(APP_RELEASE_VERSION),
      source: envVersion === 'develop' ? '开发版(构建版本)' : '构建版本',
      raw: APP_RELEASE_VERSION,
    };
  } catch (e) {
    console.warn('[profile] 读取小程序账号信息失败，版本号回退发布版本常量:', e);
    return fallback;
  }
}

export default function ProfilePage() {
  const { user, loaded, signOut, updatePassword, updateEmail } = useAuthStore();
  // 120秒无操作自动返回 ping 页：起点/代次统一由模块级 page-guard 管理，
  // 组件内只持有本实例代次号（旧实例补跑一律静默忽略，防误踢新页面）。
  const genRef = useRef(0);

  // 修改密码弹层状态
  const [pwdModalVisible, setPwdModalVisible] = useState(false);
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [submittingPwd, setSubmittingPwd] = useState(false);

  // 修改登录邮箱弹层状态
  const [emailModalVisible, setEmailModalVisible] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [submittingEmail, setSubmittingEmail] = useState(false);

  // 清除本地数据弹层状态（诊断历史 / AI 会话与模型配置 / 聊天缓存，勾选后清除）
  const [clearModalVisible, setClearModalVisible] = useState(false);
  const [clearDiag, setClearDiag] = useState(true);
  const [clearAi, setClearAi] = useState(false);
  const [clearChat, setClearChat] = useState(false);

  // 功能⑦：在线状态可见性确认弹层（开/关都先说明后果再落库，避免误触导致对方看不到自己）
  const [presenceModalVisible, setPresenceModalVisible] = useState(false);
  const [savingPresence, setSavingPresence] = useState(false);

  // 个人资料（昵称/头像）：直接派生自全局资料 store —— store 创建时已同步读本地缓存，
  // 进页首帧即有值；网络拉回最新后 upsert → 本页与其它页面同时刷新，无需私有 state。
  const myProfile = useProfilesStore((s) => (user ? s.byId[user.id] : undefined));
  const upsertProfiles = useProfilesStore((s) => s.upsert);
  const ensureProfiles = useProfilesStore((s) => s.ensure);
  const [nickModalVisible, setNickModalVisible] = useState(false);
  const [nickInput, setNickInput] = useState('');
  const [savingNick, setSavingNick] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // 进页即确保自己的资料在全局 store 里（命中内存则零请求）。
  useEffect(() => {
    if (!user) return;
    ensureProfiles([user.id]);
  }, [user, ensureProfiles]);

  // 存量头像自愈：旧版本上传的是手机直传原图（几 MB），是头像"不停在解析"的根源。
  // 判定不能只看 av400- 前缀——resizeImage 曾静默无效，产生过「带前缀却仍是原图」的文件，
  // 故先发 HEAD 请求读 content-length，超过阈值即重压重传。
  const selfHealRef = useRef(false);
  useEffect(() => {
    if (!loaded || !user || selfHealRef.current) return;
    const url = myProfile?.avatar_url;
    if (!url || !url.includes('/chat-media/')) return;
    (async () => {
      try {
        // 探测真实体积（小程序不支持 HEAD，用 GET + Range 只取 1 字节，从 206 响应头拿总大小）
        let total = 0;
        try {
          const head = await Taro.request({ url, method: 'GET', header: { Range: 'bytes=0-0' } });
          const cr = String(head.header?.['content-range'] || head.header?.['Content-Range'] || '');
          total = cr ? Number(cr.split('/')[1]) || 0 : Number(head.header?.['content-length'] || 0);
        } catch (e) {
          console.warn('[profile] 头像体积探测失败，按前缀判定跳过:', e);
        }
        const hasPrefix = !!url.split('/').pop()?.startsWith('av400-');
        // 无 av400- 前缀 → 必是原图；有前缀但体积仍 >300KB → 说明上次压缩静默失效，仍需重压
        const needHeal = total > 300 * 1024 || (!hasPrefix && !total);
        if (!needHeal) {
          logDbg(`[profile] ✅ 头像无需自愈（体积 ${total || '?'} bytes，前缀 ${hasPrefix}）`);
          return;
        }
        selfHealRef.current = true;
        logDbg(`[profile] 🗜️ 检测到未压缩头像（体积 ${total || '未知'} bytes），开始一次性压缩自愈:`, url.slice(0, 60));
        const res = await Taro.downloadFile({ url });
        if (res.statusCode !== 200) throw new Error(`下载原图失败: ${res.statusCode}`);
        let file: Parameters<typeof compressAndUploadAvatar>[0];
        if (Taro.getEnv() === Taro.ENV_TYPE.WEAPP) {
          // size 留空由 compressImageFile 自行 stat 真实体积
          // （此前塞 MAX_SAFE_INTEGER 会污染压缩前后体积校验，导致误判「压缩未生效」）
          file = { name: 'avatar.jpg', type: 'image/jpeg', size: 0, tempFilePath: res.tempFilePath };
        } else {
          const blob = await fetch(res.tempFilePath).then((r) => r.blob());
          file = new File([blob], 'avatar.jpg', { type: blob.type || 'image/jpeg' });
        }
        const { publicUrl, size } = await compressAndUploadAvatar(file, 'chat-media');
        const updated = await profilesApi.updateProfile(user.id, { avatar_url: publicUrl });
        upsertProfiles([updated]);
        logDbg(`[profile] ✅ 存量头像自愈完成，新体积 ${size} bytes，地址:`, publicUrl.slice(0, 60));
        Taro.showToast({ title: '头像已优化', icon: 'none' });
      } catch (e) {
        console.warn('[profile] 存量头像自愈失败（不影响使用）:', e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, user, myProfile?.avatar_url]);

  // navigationStyle custom 后需自绘顶部并避让状态栏（与 chat 详情页同款做法）
  const statusBarHeight = getWindowInfo().statusBarHeight ?? 20;
  logDbg('[profile] custom 导航栏生效，状态栏高度:', statusBarHeight);

  // 「关于」版本号延迟到早退分支（加载中 / 未登录 return）之后再解析，见下方 version。

  /** 所有「离开 profile 页」出口的统一收口：只有最新代次实例才允许发起跳转 */
  const exitToPing = useCallback((tag: string) => {
    if (genRef.current !== getLatestGeneration()) {
      logDbg(`[profile] 🛑 [GUARD_STALE] ${tag} 但本实例代次(${genRef.current})已过期, 忽略跳转`);
      return;
    }
    logDbg(`[profile] 🚪 [${tag}] 废弃计时, reLaunch 回 ping 页`);
    markChatExit(); // 打退场点：下一次进入聊天区的登录统计窗口从这里起算
    reportPresence('offline'); // 退回 ping 页 = 不在线（必须在 reLaunch 前发起）
    abandonGuard();
    Taro.reLaunch({ url: '/pages/ping/index' });
  }, []);

  // 页面显示时:区分页面切换vs从后台切回
  useDidShow(() => {
    const timeStr = new Date().toLocaleTimeString();
    // ① resolveEntryMode 一次性完成「栈顶前台校验 + didHide/onAppHide 配对判定」。
    //    ⚠️ 原实现在 setInterval tick 里读存储的「当前活跃页」判归属——微信切后台会冻结
    //    JS 定时器，回前台瞬间挂起的 tick 抢在 didShow 前补跑，读到旧值就把计时器 clear
    //    掉，导致「停在页面不操作也永不跳转」（本次 bug 根因）。
    const entry = resolveEntryMode(PAGE_ROUTE);
    if (entry.mode === 'stale') {
      logDbg(`[profile] 👻 [GUARD_STALE] [${timeStr}] didShow 但栈顶非本页(旧实例补触发), 忽略本次生命周期`);
      return;
    }
    genRef.current = entry.mode === 'resume' ? retainGeneration(PAGE_ROUTE) : claimFreshEntry(PAGE_ROUTE);
    clearBackgroundNote();

    // ② 兜底拦截：遮挡未解除期间落到本页，立即弹回被遮挡页
    if (isShieldArmed() && getArmedRoute() !== PAGE_ROUTE) {
      logDbg('[profile] 检测到遮挡未解除, 兜底弹回:', getArmedRoute());
      abandonGuard();
      Taro.reLaunch({ url: '/' + getArmedRoute() });
      return;
    }

    // ③ 计时决策：resume 按已流逝时长补判/续跑；fresh 全新起表 120s
    const elapsed = entry.elapsedMs;
    logDbg(`[profile] 🧭 [${timeStr}] didShow — mode:`, entry.mode, '| 已流逝(s):', Math.floor(elapsed / 1000), '| 代次:', genRef.current);
    if (entry.mode === 'resume') {
      if (elapsed >= 120000) {
        logDbg(`[profile] 🔙 后台切回补判已超时(${Math.floor(elapsed / 1000)}秒)`);
        exitToPing('EXIT_RESUME');
        return;
      }
      resumeGuard(genRef.current);
    } else {
      startGuard({ pageRoute: PAGE_ROUTE, generation: genRef.current, onTimeout: () => exitToPing('EXIT_TICK') });
    }

    if (loaded && !user) {
      redirectToLogin();
      return;
    }

    // ④ 在场状态：停留在我的页 = 在线（与聊天页/会话列表页等价）。
    //    必须在 stale/遮挡弹回/超时退场分支 return 之后。
    reportPresence('online');
  });

  // 页面隐藏时:记录 hide 时刻 + 仅停表（保留起点供后台切回补判）
  useDidHide(() => {
    const timeStr = new Date().toLocaleTimeString();
    logDbg(`[profile] 👻 [${timeStr}] useDidHide 触发, 记录 hide 时刻 + 仅停表(保留计时起点供切回补判)`);
    // 导航离开或切后台都会触发 hide → 先记「不在当前」；若随后退回 ping 页，
    // exitToPing 会用 offline 覆盖（offline 不参与抑制、保证送达）。
    reportPresence('away');
    // 记录 hide 时刻：与随后的 App onAppHide 配对，供下次 didShow 区分
    // 「切后台导致的 hide」(保留起点) vs 「导航离开导致的 hide」(作废旧起点)。
    notePageHidden(PAGE_ROUTE);
  });

  // ===== 所有事件处理函数必须在 early return 之前定义（hooks 规则要求）=====

  const handleSignOut = useCallback(async () => {
    const confirm = await Taro.showModal({
      title: '确认退出',
      content: '退出后需要重新登录',
      confirmText: '退出',
      cancelText: '取消',
    });
    if (confirm.confirm) {
      try {
        logDbg('[profile] 🚪 [EXIT_SIGN_OUT] 主动退出登录, 废弃计时起点');
        markChatExit(); // 退出登录同样离开聊天区：打退场点，下次进入的统计窗口从这里起算
        reportPresence('offline'); // 主动退出 = 不在线（必须在跳转前发起）
        abandonGuard();
        await signOut();
        Taro.reLaunch({ url: '/pages/chats/index' });
      } catch (e) {
        Taro.showToast({ title: (e as Error).message, icon: 'none' });
      }
    }
  }, [signOut]);

  const openPwdModal = useCallback(() => {
    setNewPwd('');
    setConfirmPwd('');
    setPwdModalVisible(true);
    logDbg('[profile] 🏷️ 打开修改密码弹层, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  }, []);

  // 打开昵称编辑弹层（回填当前昵称）
  const openNickModal = useCallback(() => {
    setNickInput(myProfile?.nickname || myProfile?.username || '');
    setNickModalVisible(true);
    logDbg('[profile] 🏷️ 打开昵称弹层, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  }, [myProfile?.nickname, myProfile?.username]);

  const closeNickModal = useCallback(() => {
    if (savingNick) return;
    setNickModalVisible(false);
  }, [savingNick]);

  // 保存昵称：写 profiles 表并本地同步
  const handleSaveNick = useCallback(async () => {
    if (savingNick || !user) return;
    const trimmed = nickInput.trim();
    if (!trimmed) {
      Taro.showToast({ title: '昵称不能为空', icon: 'none' });
      return;
    }
    if (trimmed.length > 20) {
      Taro.showToast({ title: '昵称最多 20 个字', icon: 'none' });
      return;
    }
    setSavingNick(true);
    try {
      const updated = await profilesApi.updateProfile(user.id, { nickname: trimmed });
      // 写回全局 store：会话列表/聊天页无需重进即显示新昵称
      upsertProfiles([updated]);
      setNickModalVisible(false);
      logDbg('[profile] ✅ 昵称已保存, 视为用户操作, 重置 120 秒起点');
      bumpGuard(genRef.current);
      Taro.showToast({ title: '昵称已更新', icon: 'success' });
    } catch (e) {
      Taro.showModal({
        title: '修改失败',
        content: (e as Error).message,
        confirmText: '知道了',
        showCancel: false,
      });
    } finally {
      setSavingNick(false);
    }
  }, [savingNick, user, nickInput, upsertProfiles]);

  // 更换头像：选图 → 上传 chat-media 桶 → 写 profiles.avatar_url
  const handleChangeAvatar = useCallback(async () => {
    if (uploadingAvatar || !user) return;
    // chooseMedia 拉起系统相册会触发瞬时 onAppHide，开豁免窗口避免误弹防护罩
    setMediaPickerGrace();
    let files;
    try {
      files = await selectMediaFiles({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'] });
    } finally {
      endMediaPickerGrace();
    }
    if (!files || files.length === 0) return;
    setUploadingAvatar(true);
    try {
      // 压缩 + 上传一体化：内部会校验「压完必须真的变小」，
      // 无效时直接抛错拒绝上传原图（此前 av400- 前缀却是 11.8MB 原图的根因）
      const { publicUrl, size } = await compressAndUploadAvatar(files[0], 'chat-media');
      logDbg(`[profile] ✅ 新头像已压缩上传，体积 ${size} bytes, 视为用户操作, 重置 120 秒起点`);
      bumpGuard(genRef.current);
      const updated = await profilesApi.updateProfile(user.id, { avatar_url: publicUrl });
      // 写回全局 store：所有消费方（本页 + 列表 + 聊天页）同步刷新头像
      upsertProfiles([updated]);
      Taro.showToast({ title: '头像已更新', icon: 'success' });
    } catch (e) {
      console.error('[profile] ❌ 头像设置失败:', e);
      Taro.showModal({
        title: '头像设置失败',
        content: (e as Error).message,
        confirmText: '知道了',
        showCancel: false,
      });
    } finally {
      setUploadingAvatar(false);
    }
  }, [uploadingAvatar, user, upsertProfiles]);

  const closePwdModal = useCallback(() => {
    if (submittingPwd) return;
    setPwdModalVisible(false);
  }, [submittingPwd]);

  // ===== 功能⑦：在线状态可见性开关 =====
  /** 打开确认弹层（回填当前值，文案随目标态变化） */
  const openPresenceModal = useCallback(() => {
    setPresenceModalVisible(true);
    logDbg('[profile] 🏷️ 打开在线状态可见性弹层, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  }, []);

  const closePresenceModal = useCallback(() => {
    if (savingPresence) return;
    setPresenceModalVisible(false);
  }, [savingPresence]);

  /**
   * 保存 hide_presence。⚠️ 必须走 profilesApi.updateProfile + upsertProfiles 既有范式：
   * updateProfile 内部 `.select('*').single()` 会校验受影响行数（RLS 静默 0 行时抛错），
   * upsert 则让本页与其它页面（列表/聊天页展示侧）立刻同步，无需重进页面。
   * 关闭开关时立即补报一次当前状态——此前被门控拦掉的 online/away 不会自动重发，
   * 不补报的话对方要等到下一次生命周期点才能看到我的状态。
   */
  const handleSavePresence = useCallback(async (next: boolean) => {
    if (savingPresence || !user) return;
    setSavingPresence(true);
    try {
      const updated = await profilesApi.updateProfile(user.id, { hide_presence: next });
      upsertProfiles([updated]);
      setPresenceModalVisible(false);
      logDbg(`[profile] ✅ 在线状态可见性已设为 ${next ? '隐藏' : '公开'}, 重置 120 秒起点`);
      bumpGuard(genRef.current);
      if (next) {
        // 开启隐藏：清掉待补发队列里可能残留的旧状态，避免下次 flush 把「不在线」又发出去
        clearPresenceQueue();
        Taro.showToast({ title: '已隐藏，对方看不到你的在线状态', icon: 'none' });
      } else {
        void reportPresence('online');
        Taro.showToast({ title: '已公开在线状态', icon: 'success' });
      }
    } catch (e) {
      Taro.showModal({
        title: '设置失败',
        content: (e as Error).message,
        confirmText: '知道了',
        showCancel: false,
      });
    } finally {
      setSavingPresence(false);
    }
  }, [savingPresence, user, upsertProfiles]);

  // ---------- 登录邮箱（真实邮箱，用于接收重置密码邮件） ----------
  /** 当前可用于收信的邮箱；仍是系统占位时为空串 */
  const accountEmail = getAccountEmail(user);

  const openEmailModal = useCallback(() => {
    setEmailInput(accountEmail || '');
    setEmailModalVisible(true);
    logDbg('[profile] 🏷️ 打开修改邮箱弹层, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  }, [accountEmail]);

  const closeEmailModal = useCallback(() => {
    if (submittingEmail) return;
    setEmailModalVisible(false);
  }, [submittingEmail]);

  const handleSubmitEmail = useCallback(async () => {
    if (submittingEmail || !user) return;
    const trimmed = emailInput.trim().toLowerCase();
    if (!trimmed) {
      Taro.showToast({ title: '请输入邮箱地址', icon: 'none' });
      return;
    }
    // 与 Edge Function 侧同一套宽松校验：本地先拦一道，避免无谓的网络往返
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
      Taro.showToast({ title: '邮箱格式不正确', icon: 'none' });
      return;
    }
    if (trimmed === accountEmail.toLowerCase()) {
      Taro.showToast({ title: '新邮箱与当前邮箱相同', icon: 'none' });
      return;
    }
    const confirm = await Taro.showModal({
      title: '确认修改邮箱',
      content: `新邮箱将作为登录账号并接收重置密码邮件：${trimmed}`,
      confirmText: '确认修改',
      cancelText: '再想想',
    });
    if (!confirm.confirm) return;

    setSubmittingEmail(true);
    try {
      const saved = await updateEmail(trimmed);
      // 同步写回全局资料 store：其它消费方与本入口展示值保持一致
      const updated = await profilesApi.updateProfile(user.id, { email: saved });
      upsertProfiles([updated]);
      setEmailModalVisible(false);
      logDbg('[profile] ✅ 登录邮箱已更新, 视为用户操作, 重置 120 秒起点');
      bumpGuard(genRef.current);
      Taro.showToast({ title: '邮箱已修改', icon: 'success' });
    } catch (e) {
      console.error('[profile] ❌ 修改邮箱失败:', e);
      Taro.showModal({
        title: '修改失败',
        content: (e as Error).message,
        confirmText: '知道了',
        showCancel: false,
      });
    } finally {
      setSubmittingEmail(false);
    }
  }, [submittingEmail, user, emailInput, accountEmail, updateEmail, upsertProfiles]);

  // ---------- 清除本地数据（仅本机 Storage，不碰云端） ----------
  /** 聊天相关缓存 key 前缀白名单：按当前账号 uid 精确匹配，绝不清 chat_last_uid_v1 */
  const CHAT_CACHE_PREFIXES = ['chat_msg_cache_', 'chat_msg_deleted_', 'chat_profile_cache_'];

  const openClearModal = useCallback(() => {
    setClearModalVisible(true);
    logDbg('[profile] 🧹 打开清除本地数据弹层, 视为用户操作, 重置 120 秒起点');
    bumpGuard(genRef.current);
  }, []);

  const closeClearModal = useCallback(() => {
    setClearModalVisible(false);
  }, []);

  /** 按前缀白名单扫描并删除聊天缓存 key（跳过登录标记等其它 key） */
  const removeChatCacheKeys = (): number => {
    let removed = 0;
    try {
      const info = Taro.getStorageInfoSync();
      for (const k of info.keys ?? []) {
        if (!CHAT_CACHE_PREFIXES.some((p) => k.startsWith(p))) continue;
        try {
          Taro.removeStorageSync(k);
          removed += 1;
        } catch { /* 单个 key 删除失败忽略 */ }
      }
    } catch (e) {
      console.warn('[profile] 扫描聊天缓存失败:', e);
    }
    return removed;
  };

  const handleConfirmClear = useCallback(async () => {
    if (!clearDiag && !clearAi && !clearChat) {
      Taro.showToast({ title: '请至少勾选一项', icon: 'none' });
      return;
    }
    const parts: string[] = [];
    if (clearDiag) parts.push('诊断历史');
    if (clearAi) parts.push('AI 会话与模型配置');
    if (clearChat) parts.push('本地缓存');
    const confirm = await Taro.showModal({
      title: '确认清除',
      content: `将清除本机保存的${parts.join('、')}。云端的消息与资料不受影响，重新联网后会再次拉取。`,
      confirmText: '清除',
      cancelText: '取消',
    });
    if (!confirm.confirm) return;
    let removedChat = 0;
    try {
      if (clearDiag) clearDiagHistory();
      if (clearAi) clearAllAiStorage();
      if (clearChat) removedChat = removeChatCacheKeys();
      logDbg(`[profile] 🧹 本地数据已清除（diag=${clearDiag}, ai=${clearAi}, chatKeys=${removedChat}）`);
      bumpGuard(genRef.current);
      setClearModalVisible(false);
      Taro.showToast({ title: '已清除', icon: 'success' });
    } catch (e) {
      console.error('[profile] ❌ 清除本地数据失败:', e);
      Taro.showModal({
        title: '清除失败',
        content: (e as Error).message,
        confirmText: '知道了',
        showCancel: false,
      });
    }
  }, [clearDiag, clearAi, clearChat]);

  const handleSubmitPwd = useCallback(async () => {
    if (submittingPwd) return;
    if (newPwd.length < 6) {
      Taro.showToast({ title: '新密码至少 6 位', icon: 'none' });
      return;
    }
    if (newPwd !== confirmPwd) {
      Taro.showToast({ title: '两次输入的密码不一致', icon: 'none' });
      return;
    }
    setSubmittingPwd(true);
    try {
      await updatePassword(newPwd);
      setPwdModalVisible(false);
      Taro.showToast({ title: '密码已修改', icon: 'success' });
    } catch (e) {
      Taro.showModal({
        title: '修改失败',
        content: (e as Error).message,
        confirmText: '知道了',
        showCancel: false,
      });
    } finally {
      setSubmittingPwd(false);
    }
  }, [submittingPwd, newPwd, confirmPwd, updatePassword]);

  if (!loaded) {
    return (
      <View className="min-h-screen bg-background flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    );
  }

  if (!user) return null;

  const name = getDisplayName(user);

  // 「关于」版本号：早退分支之后现取（避免未登录/加载中无意义调用）。
  // 日志同时打印来源，便于真机核对「显示的版本到底取自哪里」。
  const version = resolveAppVersion();
  logDbg(`[profile] ℹ️ 版本号展示: ${version.text} (来源 ${version.source})`);
  // ⚠️ 更新日志的「当前版本」基准必须用**构建期常量**，不能用 version.raw。
  // 正式版里 version.raw 是微信回包的真实发布号（如 66），而 CHANGELOG 是随代码一起打包的
  // 静态数据——若本次发版忘了在 CHANGELOG 顶部追加条目，两者就会不一致：徽标会落到旧条目上，
  // 用户看到「关于显示 V66、更新日志最新却是 V65」。这里显式比对并告警，让漂移在日志里可见。
  const changelogVersion = RELEASE_VERSION;
  if (version.raw && version.raw !== changelogVersion) {
    console.warn(
      `[profile] ⚠️ 版本号与更新日志不一致：关于=${version.text}(${version.source})，` +
        `更新日志最新=${formatVersionLabel(changelogVersion)}。` +
        '请在 src/lib/app-release.ts 的 CHANGELOG 顶部追加本次发版条目。',
    );
  }

  // ⚠️ 更新日志列表的构造（缺陷⑮，用户报「版本号与更新日志对不上 + 有跳版本 V73--V64-V63 + 日期不符」）：
  //    旧实现是「把微信回包的真实发布号硬覆盖到 CHANGELOG 顶部条目上」——CHANGELOG 只记录
  //    「有内容可写」的版本，发布号序列天然有空档（如 73 之后直接是 64），覆盖后渲染成
  //    73 → 64 → 63：既不是降幂连续、又让人以为中间版本被漏掉了；日期也被「早于今天就用今天覆盖」
  //    的规则改成了访问当天，与真实发布日不符。
  //    正解：**发布记录（RELEASES）与更新日志（CHANGELOG）分开**，由 buildChangelogList() 合并——
  //    以发布记录为骨架（每个真实发布号都在列表里、带真实发布日期），按发布号**降幂**排序，
  //    有说明文案的版本挂上 title/items，没有的只显示版本号与日期。
  //    这样「关于」行的版本号、列表首条、发布日期三者天然同源，不再需要任何覆盖式校正。
  const changelogEntries = withCurrentVersionPlaceholder(version.raw, buildChangelogList());
  logDbg(
    `[profile] 🧾 更新日志已按发布记录合并: 共 ${changelogEntries.length} 条，` +
      `首条 ${formatVersionLabel(changelogEntries[0]?.version)}（${changelogEntries[0]?.date ?? '-'}），` +
      `关于行 ${version.text}（来源 ${version.source}）`,
  );

  return (
    <ErrorBoundary route="pages/profile/index">
    <PrivacyShield>
    <View className="min-h-screen bg-background flex flex-col items-center px-6" style={{ paddingTop: `${statusBarHeight + 48}px` }}>
      <View className="w-20 h-20 rounded-full bg-secondary flex items-center justify-center mb-4 overflow-hidden" onClick={handleChangeAvatar}>
        {myProfile?.avatar_url ? (
          <Image src={myProfile.avatar_url} className="w-20 h-20" mode="aspectFill" />
        ) : (
          <Text className="text-secondary-foreground text-2xl font-bold">{getInitial(name)}</Text>
        )}
      </View>
      <Text className="text-xl font-bold text-foreground mb-1">
        {myProfile?.nickname || myProfile?.username || name}
      </Text>
      <Text className="text-xs text-muted-foreground mb-2">
        {uploadingAvatar ? '头像上传中...' : '点击头像更换'}
      </Text>

      {/* 昵称编辑入口 */}
      <View
        className="w-full bg-card border border-border rounded-lg px-4 py-3 flex flex-row items-center justify-between mt-6"
        onClick={openNickModal}
      >
        <View className="flex flex-col">
          <Text className="text-xs text-muted-foreground">昵称</Text>
          <Text className="text-foreground mt-1">
            {myProfile?.nickname || myProfile?.username || '未设置'}
          </Text>
        </View>
        <View className="i-lucide-chevron-right w-5 h-5 text-muted-foreground" />
      </View>

      <View
        className="w-full bg-card border border-border rounded-lg px-4 py-3 flex flex-row items-center justify-between mt-4"
        onClick={openEmailModal}
      >
        <View className="flex flex-col flex-1 overflow-hidden">
          <Text className="text-xs text-muted-foreground">登录邮箱</Text>
          <Text className={accountEmail ? 'text-foreground mt-1' : 'text-muted-foreground mt-1'}>
            {accountEmail || '未设置（建议填写，否则无法接收重置密码邮件）'}
          </Text>
        </View>
        <View className="i-lucide-chevron-right w-5 h-5 text-muted-foreground shrink-0" />
      </View>

      <View
        className="w-full bg-card border border-border rounded-lg py-3 flex items-center justify-center mt-12"
        onClick={openPwdModal}
      >
        <Text className="text-foreground font-medium">修改密码</Text>
      </View>

      <View
        className="w-full bg-card border border-border rounded-lg px-4 py-3 flex flex-row items-center justify-between mt-4"
        onClick={openClearModal}
      >
        <View className="flex flex-col">
          <Text className="text-xs text-muted-foreground">清除本地数据</Text>
          <Text className="text-foreground mt-1">诊断历史 / AI 会话 / 本地缓存</Text>
        </View>
        <View className="i-lucide-chevron-right w-5 h-5 text-muted-foreground shrink-0" />
      </View>

      <View
        className="w-full bg-card border border-border rounded-lg px-4 py-3 flex flex-row items-center justify-between mt-4"
        onClick={openPresenceModal}
      >
        <View className="flex flex-col flex-1 min-w-0 mr-3">
          <Text className="text-xs text-muted-foreground">在线状态可见性</Text>
          <Text className="text-foreground mt-1">{myProfile?.hide_presence ? '已隐藏：对方看不到你在不在' : '公开：对方可看到你的在线状态'}</Text>
        </View>
        <View
          className="w-5 h-5 rounded shrink-0 flex items-center justify-center border"
          style={
            myProfile?.hide_presence
              ? { backgroundColor: '#2563eb', borderColor: '#2563eb' }
              : { borderColor: 'rgba(120, 120, 128, 0.35)' }
          }
          onClick={(e) => {
            e.stopPropagation();
            openPresenceModal();
          }}
        >
          {myProfile?.hide_presence ? <View className="i-lucide-check w-4 h-4 text-white" /> : null}
        </View>
      </View>

      {/* 关于：应用名 + 实际版本号（正式版取微信后台版本，体验版带构建号，其余兜底 package.json） */}
      <View className="w-full bg-card border border-border rounded-lg px-4 py-3 mt-4">
        <View className="flex flex-row items-center justify-between">
          <Text className="text-xs text-muted-foreground">关于</Text>
          <Text className="text-xs text-muted-foreground">{version.text}</Text>
        </View>
        <Text className="text-foreground mt-1">检测网络</Text>
        <Text className="text-xs text-muted-foreground mt-1 leading-relaxed">
          网络诊断 + AI 解读，帮你快速判断「是网络的问题还是网站的问题」。
        </Text>
        <Text className="text-xs text-muted-foreground mt-2">当前运行环境：{version.source}</Text>
      </View>

      {/* 更新日志：默认收起只显最近 2 条，点击标题行展开全部（展开偏好按 key 记忆） */}
      <ChangelogList
        currentVersion={version.raw || changelogVersion}
        entries={changelogEntries}
        onToggle={() => bumpGuard(genRef.current)}
      />

      {/* 错误记录：页面崩溃 / 未捕获异常的事后查看入口（数据源与 ErrorBoundary 同源） */}
      <ErrorLogPanel onToggle={() => bumpGuard(genRef.current)} />

      <View
        className="w-full bg-card border border-border rounded-lg py-3 flex items-center justify-center mt-4"
        onClick={handleSignOut}
      >
        <Text className="text-destructive font-medium">退出登录</Text>
      </View>

      {/* 昵称编辑弹层 */}
      {nickModalVisible && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-8"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={closeNickModal}
        >
          <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-lg font-bold text-foreground mb-1">修改昵称</Text>
            <Text className="block text-xs text-muted-foreground mb-5">昵称会展示在个人资料中，最多 20 个字</Text>

            <View className="bg-secondary rounded-lg px-4 py-3 mb-6">
              <Input
                className="w-full bg-transparent text-foreground"
                value={nickInput}
                maxlength={20}
                placeholder="输入新昵称"
                placeholderClass="text-muted-foreground"
                onInput={(e) => setNickInput(e.detail.value)}
              />
            </View>

            <View className="flex flex-row gap-3">
              <View
                className="flex-1 bg-secondary rounded-lg py-3 flex items-center justify-center"
                onClick={closeNickModal}
              >
                <Text className="text-secondary-foreground">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={handleSaveNick}
              >
                <Text className="text-primary-foreground font-medium">
                  {savingNick ? '保存中...' : '保存'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* 修改登录邮箱弹层 */}
      {emailModalVisible && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-8"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={closeEmailModal}
        >
          <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-lg font-bold text-foreground mb-1">修改登录邮箱</Text>
            <Text className="block text-xs text-muted-foreground mb-5">
              请填写你自己的真实邮箱。忘记密码时，重置邮件会发到这里；填写后仍可用原来的用户名和密码登录。
            </Text>

            <View className="bg-secondary rounded-lg px-4 py-3 mb-6">
              <Input
                className="w-full bg-transparent text-foreground"
                value={emailInput}
                maxlength={254}
                placeholder="name@example.com"
                placeholderClass="text-muted-foreground"
                onInput={(e) => setEmailInput(e.detail.value)}
              />
            </View>

            <View className="flex flex-row gap-3">
              <View
                className="flex-1 bg-secondary rounded-lg py-3 flex items-center justify-center"
                onClick={closeEmailModal}
              >
                <Text className="text-secondary-foreground">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={handleSubmitEmail}
              >
                <Text className="text-primary-foreground font-medium">
                  {submittingEmail ? '提交中...' : '确认修改'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* 清除本地数据弹层（勾选式，仅清本机 Storage） */}
      {clearModalVisible && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-8"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={closeClearModal}
        >
          <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-lg font-bold text-foreground mb-1">清除本地数据</Text>
            <Text className="block text-xs text-muted-foreground mb-4">
              只清除保存在本机的数据，云端的消息与资料不受影响
            </Text>

            {[
              { label: '网络诊断历史', desc: '历史探测记录与对比数据', checked: clearDiag, setter: setClearDiag },
              { label: 'AI 会话与模型配置', desc: '全部对话记录、自定义模型及 Key', checked: clearAi, setter: setClearAi },
              { label: '本地缓存', desc: '离线快照与头像缓存，联网后可重新拉取', checked: clearChat, setter: setClearChat },
            ].map((item) => (
              <View
                key={item.label}
                className="flex flex-row items-center py-3 border-b border-border"
                onClick={() => item.setter(!item.checked)}
              >
                <View
                  className={`w-5 h-5 rounded mr-3 flex items-center justify-center shrink-0 border ${item.checked ? 'bg-primary border-primary' : 'border-border'}`}
                >
                  {item.checked && <View className="i-lucide-check w-4 h-4 text-primary-foreground" />}
                </View>
                <View className="flex flex-col flex-1">
                  <Text className="text-foreground text-sm">{item.label}</Text>
                  <Text className="text-xs text-muted-foreground mt-1">{item.desc}</Text>
                </View>
              </View>
            ))}

            <View className="flex flex-row gap-3 mt-6">
              <View
                className="flex-1 bg-secondary rounded-lg py-3 flex items-center justify-center"
                onClick={closeClearModal}
              >
                <Text className="text-secondary-foreground">取消</Text>
              </View>
              <View
                className="flex-1 bg-destructive rounded-lg py-3 flex items-center justify-center"
                onClick={handleConfirmClear}
              >
                <Text className="text-white font-medium">确认清除</Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {/* 功能⑦：在线状态可见性确认弹层（两个按钮即两个目标值，无需再勾选） */}
      {presenceModalVisible && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-8"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={closePresenceModal}
        >
          <View className="w-full bg-card rounded-xl p-6" onClick={(e) => e.stopPropagation()}>
            <Text className="block text-lg font-bold text-foreground mb-1">在线状态可见性</Text>
            <Text className="block text-xs text-muted-foreground mb-4">
              {myProfile?.hide_presence
                ? '当前已隐藏。对方将看不到你的在线状态，也不会收到你的输入提示。'
                : '当前公开。对方可看到你在不在、以及最后活跃时间。'}
            </Text>
            <Text className="block text-xs text-muted-foreground mb-6 leading-relaxed">
              该设置保存在云端，换设备或重新登录后依然生效。
            </Text>

            <View className="flex flex-row gap-3">
              <View
                className="flex-1 bg-secondary rounded-lg py-3 flex items-center justify-center"
                onClick={closePresenceModal}
              >
                <Text className="text-secondary-foreground">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={() => handleSavePresence(!myProfile?.hide_presence)}
              >
                <Text className="text-primary-foreground font-medium">
                  {savingPresence ? '保存中...' : myProfile?.hide_presence ? '改为公开' : '改为隐藏'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}

      {pwdModalVisible && (
        <View
          className="fixed inset-0 z-50 flex items-center justify-center px-8"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={closePwdModal}
        >
          <View
            className="w-full bg-card rounded-xl p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <Text className="block text-lg font-bold text-foreground mb-1">修改密码</Text>
            <Text className="block text-xs text-muted-foreground mb-5">新密码至少 6 位，修改后请用新密码重新登录</Text>

            <View className="bg-secondary rounded-lg px-4 py-3 mb-3">
              <Input
                className="w-full bg-transparent text-foreground"
                password
                value={newPwd}
                placeholder="输入新密码"
                placeholderClass="text-muted-foreground"
                onInput={(e) => setNewPwd(e.detail.value)}
              />
            </View>

            <View className="bg-secondary rounded-lg px-4 py-3 mb-6">
              <Input
                className="w-full bg-transparent text-foreground"
                password
                value={confirmPwd}
                placeholder="再次输入新密码"
                placeholderClass="text-muted-foreground"
                onInput={(e) => setConfirmPwd(e.detail.value)}
              />
            </View>

            <View className="flex flex-row gap-3">
              <View
                className="flex-1 bg-secondary rounded-lg py-3 flex items-center justify-center"
                onClick={closePwdModal}
              >
                <Text className="text-secondary-foreground">取消</Text>
              </View>
              <View
                className="flex-1 bg-primary rounded-lg py-3 flex items-center justify-center"
                onClick={handleSubmitPwd}
              >
                <Text className="text-primary-foreground font-medium">
                  {submittingPwd ? '提交中...' : '确认修改'}
                </Text>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
    </PrivacyShield>
    </ErrorBoundary>
  );
}
