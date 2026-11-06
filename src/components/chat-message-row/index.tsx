import { View, Text, Image } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { memo } from 'react';
import type { ReactNode } from 'react';
import type { Message } from '@/api/messages';

/**
 * 聊天详情页的单条消息行（独立 memo 子组件）。
 *
 * ⚠️ 为什么必须拆出来：chat 页有 3 个定时器（在线状态 30s / 登录统计 30s / 撤回倒计时 60s）
 *    会持续触发整页重渲染。长会话下几百行消息全部重跑 JSX 是主要卡顿来源。
 *    拆成 memo 后，只要本行的 props 不变就整行跳过渲染。
 *
 * ⚠️ props 设计铁律：**只收原始值 + 引用稳定的回调**。
 *    - 绝不能把 `messages` 数组、`selectedIds` 数组、`failedIds`/`sendingIds`/`avatarErrorIds`
 *      这些 Set 直接传进来：它们每次父组件渲染都可能换引用，memo 会全部失效。
 *      父组件必须先把「本行相关的那一个布尔值」算好再传（isSelected / isFailed / ...）。
 *    - `renderContent` 必须是父组件的 useCallback（依赖数组只列渲染分支真正读到的值），
 *      否则每行都会因为函数引用变化而重渲染。
 */
export interface ChatMessageRowProps {
  msg: Message;
  isMine: boolean;
  /** 与上一条消息不同天 → 本行前插入日期分隔头 */
  showDateHeader: boolean;
  /** 日期头文案（父组件已格式化，避免子组件重复算） */
  dateHeaderText: string;
  /** 时间文案（父组件已格式化） */
  timeText: string;
  /** 是否为列表最后一条（用于滚动定位锚点 id） */
  isLast: boolean;
  /** 被引用的原消息是否已不在列表里（置灰且不可点） */
  quoteGone: boolean;
  senderAvatar: string;
  senderName: string;
  isFailed: boolean;
  isSending: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  selectMode: boolean;
  renderContent: (msg: Message, isMine: boolean) => ReactNode;
  onTapInSelectMode: (messageId: string, e?: any) => void;
  onTouchStart: (e: any, messageId: string) => void;
  onTouchMove: (e: any) => void;
  onTouchEnd: () => void;
  onQuoteTap: (messageId: string) => void;
  onAvatarError: (senderId: string) => void;
  onRetry: (messageId: string) => void;
  onDismissFailed: (messageId: string) => void;
}

function ChatMessageRowInner(props: ChatMessageRowProps) {
  const {
    msg,
    isMine,
    showDateHeader,
    dateHeaderText,
    timeText,
    isLast,
    quoteGone,
    senderAvatar,
    senderName,
    isFailed,
    isSending,
    isSelected,
    isHighlighted,
    selectMode,
    renderContent,
    onTapInSelectMode,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onQuoteTap,
    onAvatarError,
    onRetry,
    onDismissFailed,
  } = props;

  // 撤回占位：居中灰字提示，不渲染气泡/长按热区/勾选框（日期头照常参与跨天判断）
  if (msg.revoked_at) {
    return (
      <View>
        {showDateHeader && (
          <View className="flex justify-center my-3">
            <Text className="text-xs text-muted-foreground">{dateHeaderText}</Text>
          </View>
        )}
        <View className="flex justify-center my-2">
          <Text className="text-xs text-muted-foreground">
            {isMine ? '你撤回了一条消息' : '对方撤回了一条消息'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View id={`msg-row-${msg.id}`}>
      {showDateHeader && (
        <View className="flex justify-center my-3">
          <Text className="text-xs text-muted-foreground">{dateHeaderText}</Text>
        </View>
      )}
      <View
        className={`flex mb-3 items-start gap-2 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}
        onClick={(e) => onTapInSelectMode(msg.id, e)}
      >
        {/* 发送失败的占位消息：不显示头像，避免与正常消息混淆 */}
        {!isFailed && (
          senderAvatar ? (
            <Image
              src={senderAvatar}
              className="w-9 h-9 rounded-full shrink-0"
              mode="aspectFill"
              onError={() => onAvatarError(msg.sender_id)}
            />
          ) : (
            <View className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center shrink-0">
              <Text className="text-secondary-foreground text-sm font-medium">
                {senderName.charAt(0)}
              </Text>
            </View>
          )
        )}
        {/* 多选模式下的勾选框(视觉圆点不变,外层扩大点击热区并加高整行可点范围) */}
        {selectMode && (
          <View className="w-10 h-10 flex items-center justify-center shrink-0">
            <View
              className={`w-7 h-7 rounded-full border-2 flex items-center justify-center ${
                isSelected ? 'bg-primary border-primary' : 'border-muted-foreground'
              }`}
            >
              {isSelected && <View className="i-lucide-check w-4 h-4 text-white" />}
            </View>
          </View>
        )}
        {/* 消息内容(长按热区只包气泡+时间行,不覆盖整行两侧空白;
            之前整行绑touchstart导致点消息旁空白也弹删除菜单) */}
        <View
          className="flex flex-col min-w-0"
          style={{ maxWidth: '75%', alignItems: isMine ? 'flex-end' : 'flex-start' }}
          onTouchStart={(e) => onTouchStart(e, msg.id)}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
        >
          {/* 对方消息上方显示昵称（自己消息不显示） */}
          {!isMine && (
            <Text className="text-xs text-muted-foreground mb-1">{senderName}</Text>
          )}
          {/* 气泡按内容收缩(max-content),短消息不再被撑满出现空白;
              长文本在父级 maxWidth 75% 内自动换行填满 */}
          <View
            id={isLast ? 'msg-bubble-last' : undefined}
            style={{ width: 'max-content', maxWidth: '100%' }}
            className={`rounded-2xl px-3 py-2 ${isMine ? 'bg-primary rounded-br-sm' : 'bg-card border border-border rounded-bl-sm'} ${
              isFailed ? 'opacity-50' : ''
            } ${selectMode && isSelected ? 'opacity-80' : ''} ${
              isHighlighted ? 'ring-2 ring-primary' : ''
            }`}
          >
            {/* 引用回复气泡：展示被引消息内容快照，点击可定位原消息。
                ⚠️ 原消息已不在列表里（被彻底删除）时置灰且不可点——点了也只会弹提示，
                   不如直接给出视觉反馈，避免用户反复点。 */}
            {msg.reply_to_id && (
              <View
                onClick={(e) => {
                  e.stopPropagation();
                  if (quoteGone) return;
                  onQuoteTap(msg.reply_to_id!);
                }}
                className={`mb-1 rounded-lg px-2 py-1 ${isMine ? 'bg-white' : 'bg-muted'} ${
                  isMine ? 'border-l-2 border-primary' : 'border-l-2 border-border'
                } ${quoteGone ? 'opacity-50' : ''}`}
              >
                <Text
                  className={`text-xs ${isMine ? 'text-muted-foreground' : 'text-secondary-foreground'}`}
                  style={{
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2,
                    overflow: 'hidden',
                  }}
                >
                  {msg.reply_to_content || '[原消息]'}
                </Text>
              </View>
            )}
            {renderContent(msg, isMine)}
          </View>
          <View className={`flex flex-row items-center gap-1 mt-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
            {/* 发送失败标记：点击弹出「重新发送 / 删除」菜单 */}
            {isFailed && (
              <View
                className="i-lucide-alert-circle w-4 h-4 text-destructive shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  Taro.showActionSheet({
                    itemList: ['重新发送', '删除这条消息'],
                    success: (res) => {
                      if (res.tapIndex === 0) {
                        onRetry(msg.id);
                      } else if (res.tapIndex === 1) {
                        onDismissFailed(msg.id);
                      }
                    },
                  });
                }}
              />
            )}
            <Text className="text-muted-foreground text-xs">{timeText}</Text>
            {/* 消息状态标识(仅自己发送的消息显示；失败占位行不显示状态，由红色感叹号表达)
                微信风格对勾：发送中=转圈，已送达=单勾，已读=双勾(主题色)，未送达=单勾(浅灰) */}
            {isMine && !isFailed && (
              isSending ? (
                <View className="msg-sending-spin i-lucide-loader-circle w-3 h-3 text-muted-foreground" />
              ) : msg.read_at ? (
                <View className="i-lucide-check-check w-3 h-3 text-primary" />
              ) : (
                <View className="i-lucide-check w-3 h-3 text-muted-foreground" />
              )
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const ChatMessageRow = memo(ChatMessageRowInner);
ChatMessageRow.displayName = 'ChatMessageRow';

export default ChatMessageRow;
