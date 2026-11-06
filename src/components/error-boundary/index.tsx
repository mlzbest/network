import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { recordError } from '@/lib/error-log';
import { logErr } from '@/lib/logger';

/**
 * 页面级错误边界：页面渲染崩溃时兜住白屏，显示友好提示 + 重试按钮。
 *
 * ⚠️ 为什么这里必须是**类组件**（全项目唯一的类组件，不是风格倒退）：
 *   React 的错误边界只能由类组件的 `getDerivedStateFromError` / `componentDidCatch`
 *   实现，函数组件 + Hooks 没有等价能力（没有 useErrorBoundary 这类官方 API）。
 *   项目其余部分一律保持函数组件 + Hooks，只有本文件例外。
 *
 * ⚠️ 为什么必须在**每个页面各自包一层**，而不是在 app.tsx 包一次：
 *   Taro 小程序的每个页面是独立渲染的 Page 实例，不在 app.tsx 的 React 组件树里
 *   （app.tsx 返回的 children 并不是「所有页面的容器」）。因此 app.tsx 里包一层
 *   根本拦不到页面渲染错误，只能逐页包裹——与项目里 PrivacyShield 的接线方式一致。
 *
 * ⚠️ 与 App 级钩子的分工：
 *   - 本组件负责「渲染阶段抛错」→ 能阻止白屏、能原地恢复；
 *   - app.tsx 注册的 Taro.onError / Taro.onUnhandledRejection 负责「异步未捕获错误」
 *     → 拦不住白屏（错误已发生），只做记录。
 *   两者都调 recordError()，记录口径统一。
 *
 * ⚠️ 自动重试（崩溃后先自动重试一次，仍失败才显示提示卡）：
 *   很多渲染崩溃是**瞬时**的——数据还没到位、异步状态竞态、某个字段偶发为 undefined。
 *   这类错误重新挂载一次子树就自愈了，直接甩给用户一张「页面出了点问题」的卡片
 *   属于把可自愈的问题包装成故障。所以先自动重试一次，把这类抖动吃掉。
 *   但**只重试一次**：如果是确定性错误（代码 bug、数据必然缺失），重试必然再崩，
 *   无限重试会变成「崩溃 → 重挂载 → 再崩溃」的死循环，页面持续闪烁且用户无法操作。
 *   一次之后仍失败就认账，交给用户手动决定（手动重试不受次数限制，因为那是用户主动行为）。
 */

interface Props {
  children: ReactNode;
  /** 本页路由（如 'pages/chat/index'），用于记录崩溃发生在哪个页面 */
  route?: string;
}

interface State {
  hasError: boolean;
  /** 崩溃时的错误摘要，供「复制详情」使用；不直接展示给用户 */
  detail: string;
  /** 是否已用掉自动重试机会（每次崩溃周期只自动重试一次） */
  autoRetried: boolean;
}

/** 自动重试前的等待时长：给异步数据/布局一点时间落定，避免立刻重挂载又踩同一个坑 */
const AUTO_RETRY_DELAY_MS = 300;

export default class ErrorBoundary extends Component<Props, State> {
  /** 渲染阶段抛错时由 React 调用：切到兜底 UI（本方法内不能有副作用） */
  static getDerivedStateFromError(error: unknown): State {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    // ⚠️ 这里不能读 this.state（静态方法无实例），所以 autoRetried 只能先置 false，
    // 真正的「是否已重试过」判断与置位放在 componentDidCatch 里做。
    return { hasError: true, detail: msg, autoRetried: false };
  }

  state: State = { hasError: false, detail: '', autoRetried: false };

  /** 提交阶段调用：这里才做副作用（记录错误 + 安排自动重试） */
  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const route = this.props.route ?? '';
    // 记录到本机存储（recordError 内部永不抛错，不会把兜底 UI 也搞崩）
    recordError({ route, error, extraStack: info?.componentStack ?? undefined });
    logErr(`[error-boundary] 💥 页面渲染崩溃，已兜底: ${route || '(未知页面)'}`, error);

    // 首次崩溃：安排一次自动重试；已重试过则不再安排，直接停在提示卡上
    if (!this.state.autoRetried) {
      logErr(`[error-boundary] ⏳ ${AUTO_RETRY_DELAY_MS}ms 后自动重试一次: ${route || '(未知页面)'}`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        // 标记已用掉自动重试机会，再复位错误态触发子树重新挂载
        this.setState({ hasError: false, detail: '', autoRetried: true });
      }, AUTO_RETRY_DELAY_MS);
    } else {
      logErr(`[error-boundary] ⛔ 自动重试后仍崩溃，停止重试并展示提示卡: ${route || '(未知页面)'}`);
    }
  }

  componentWillUnmount(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 自动重试的定时器句柄；组件卸载时必须清掉，否则会对已卸载组件 setState */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** 重试：复位状态让子树重新挂载渲染 */
  private handleRetry = (): void => {
    logErr(`[error-boundary] 🔄 用户点击重新加载: ${this.props.route ?? '(未知页面)'}`);
    // 用户手动重试：重置 autoRetried，让下一次崩溃仍能享受一次自动重试
    this.setState({ hasError: false, detail: '', autoRetried: false });
  };

  /** 复制错误详情：剪贴板被拒时降级为页面内长按可选文本 */
  private handleCopy = (): void => {
    const text = `页面：${this.props.route ?? '(未知)'}\n错误：${this.state.detail || '(无详情)'}`;
    Taro.setClipboardData({ data: text })
      .then(() => {
        Taro.showToast({ title: '已复制', icon: 'none' });
      })
      .catch((e: unknown) => {
        // 真机常见 errno 112 = 隐私指引未声明「读取剪贴板」；此时不弹 toast，
        // 由下方 <Text selectable> 让用户长按手动复制。
        logErr('[error-boundary] 复制失败（已降级为长按选择）:', e);
      });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <View className="min-h-screen bg-background flex flex-col items-center justify-center px-8">
        <View className="i-lucide-alert-triangle w-16 h-16 text-muted-foreground" />
        <Text className="text-foreground text-base font-medium mt-4 leading-none">页面出了点问题</Text>
        <Text className="text-muted-foreground text-sm mt-3 text-center leading-relaxed">
          已经自动重试过一次还是不行。可以点下面的按钮再试一次；如果仍然不行，退出小程序再进来试试。
        </Text>

        <View
          onClick={this.handleRetry}
          className="active:opacity-60 mt-6 px-6 py-2 rounded-full bg-secondary"
        >
          <Text className="text-primary text-sm leading-none">重新加载</Text>
        </View>

        <View onClick={this.handleCopy} className="active:opacity-60 mt-4 px-4 py-2">
          <Text className="text-muted-foreground text-xs leading-none">复制错误详情</Text>
        </View>

        {/* 剪贴板被拒时的兜底：长按可选中复制（与项目其他复制场景同款降级） */}
        <Text selectable className="text-muted-foreground text-xs mt-4 text-center leading-relaxed">
          {this.state.detail || '(无详情)'}
        </Text>
      </View>
    );
  }
}
