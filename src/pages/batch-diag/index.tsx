import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useEffect, useState } from 'react';
import BatchProbePanel from '@/components/batch-probe-panel';
import FullDiagPanel from '@/components/full-diag-panel';
import { saveDeepDiagnoseTarget, takeBatchInput } from '@/lib/batch-diag-handoff';
import { getWindowInfo } from '@/lib/system-info';
import { markChatExit } from '@/lib/secret-entry';
import { reportPresence } from '@/lib/presence';
import ErrorBoundary from '@/components/error-boundary';

/**
 * 批量诊断独立页：从 ping 页输入区「多个地址一起测？」入口 navigateTo 进入。
 * 面板本体复用 components/batch-probe-panel（withCardShell=false，标题与外壳由本页提供）。
 *
 * 「详情」下钻在**本页内**展开全量分层诊断（components/full-diag-panel）——
 * 批量列表只跑 DNS + Ping 轻量两项，点详情后补齐多DNS比对/端口/路由/HTTP/TLS/
 * 多点拨测/吞吐等后续各项，不再跳回 ping 页。同时仍写入一次性交接 key：
 * 若用户之后手动返回 ping 页，可自动回填该目标并跑一次全量诊断（take 后即焚）。
 */
export default function BatchDiagPage() {
  const sysInfo = getWindowInfo();
  const statusBarHeight = sysInfo.statusBarHeight ?? 20;
  const isWeappEnv = Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
  // 胶囊右留白 = 屏宽 - 胶囊左缘 + 8px，保证标题不被胶囊压住。
  // getMenuButtonBoundingClientRect 在 H5 会 reject Promise（同步 try-catch 捕不到，
  // 会泄漏成 Uncaught），故仅微信端调用，H5 回退固定留白。
  const [capsuleRightPadding, setCapsuleRightPadding] = useState(96);
  useEffect(() => {
    if (!isWeappEnv) return;
    try {
      const rect = Taro.getMenuButtonBoundingClientRect();
      const winW = sysInfo.windowWidth;
      if (rect && typeof rect.left === 'number' && rect.left > 0 && winW > 0) {
        setCapsuleRightPadding(Math.round(winW - rect.left + 8));
      }
    } catch (e) {
      console.log('[batch-diag] getMenuButtonBoundingClientRect 异常，回退固定留白');
    }
  }, [isWeappEnv, sysInfo]);

  // 初始输入由 ping 页经 Storage 一次性交接（take 后即焚）
  const [initialText] = useState(() => {
    const v = takeBatchInput();
    console.log(`[batch-diag] 📥 初始输入长度: ${v.length}`);
    return v;
  });

  // 下钻中的目标：非空时在本页内渲染全量诊断面板（null=停留在批量结果列表）
  const [deepTarget, setDeepTarget] = useState('');

  /** 下钻全量诊断：本页内展开完整分层诊断面板，并留一份交接给 ping 页备用 */
  const handleDeepDiagnose = (target: string) => {
    console.log('[batch-diag] 🔬 页内下钻全量诊断:', target);
    saveDeepDiagnoseTarget(target);
    setDeepTarget(target);
  };

  return (
    <ErrorBoundary route="pages/batch-diag/index">
    <View className="min-h-screen bg-background flex flex-col px-4 py-6" style={{ paddingTop: `${statusBarHeight + 16}px` }}>
      {/* 顶部：返回 + 标题（custom 导航栏自绘） */}
      <View className="flex flex-row items-center mb-1" style={{ paddingRight: `${capsuleRightPadding}px` }}>
        <View
          className="mr-2"
          onClick={() => {
            if (deepTarget !== '') {
              // 下钻态下先收起全量面板回到批量结果，再点返回才离开本页
              console.log('[batch-diag] ↩️ 从全量诊断收起面板，回到批量结果');
              setDeepTarget('');
              return;
            }
            console.log('[batch-diag] 点击返回, navigateBack');
            // 此前遗漏的退场出口：navigateBack 回 ping（或栈空时 reLaunch）都算离开聊天区。
            // batch-diag 由 ping 页 navigateTo 进入，返回即回到 ping → 打退场点 + 上报「不在线」。
            markChatExit();
            reportPresence('offline');
            Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/ping/index' }));
          }}
        >
          <View className="i-lucide-chevron-left w-6 h-6 text-foreground" />
        </View>
        <Text className="text-xl font-bold text-foreground flex-1">批量诊断</Text>
      </View>
      <Text className="text-muted-foreground text-xs mb-5 leading-relaxed">
        {deepTarget !== ''
          ? '正在对该目标执行全量分层诊断（含 DNS、Ping 之后的端口、路由、HTTP、TLS、多点拨测、吞吐等各项）。'
          : '一次输入多个地址，轮流做 DNS + Ping 轻量探测，快速判断是不是只有某个网站打不开；点某行「详情」可在本页跑完全部检测项。'}
      </Text>

      {deepTarget !== '' ? (
        <FullDiagPanel target={deepTarget} onClose={() => { console.log('[batch-diag] 关闭全量诊断，回到批量结果'); setDeepTarget(''); }} />
      ) : (
        <BatchProbePanel initialText={initialText} onDeepDiagnose={handleDeepDiagnose} withCardShell={false} />
      )}
    </View>
    </ErrorBoundary>
  );
}
