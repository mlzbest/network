import { View, Text, Input, ScrollView, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { supabase } from '@/supabase/client';
import './index.scss';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
};

type AgentType = 'main' | 'word';

const AGENTS: Record<AgentType, { name: string; desc: string }> = {
  main: { name: '小艾', desc: '通用 AI 助手' },
  word: { name: '元宝', desc: '元智能助手' },
};

export default function AssistantPage() {
  const { user, loaded } = useAuthStore();
  const [activeAgent, setActiveAgent] = useState<AgentType>('main');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<any>(null);

  // 欢迎消息
  useEffect(() => {
    if (loaded && !user) {
      Taro.navigateTo({ url: '/pages/login/index' });
    }
  }, [user, loaded]);

  useEffect(() => {
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: `你好！我是${AGENTS[activeAgent].name}，有什么可以帮你的？`,
        timestamp: Date.now(),
      },
    ]);
  }, [activeAgent]);

  // 滚动到底部
  useEffect(() => {
    setTimeout(() => {
      scrollRef.current?.scrollIntoView();
    }, 100);
  }, [messages]);

  const handleSend = async () => {
    const text = inputValue.trim();
    if (!text || isTyping) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputValue('');
    setIsTyping(true);

    try {
      const { data, error } = await supabase.functions.invoke('openclaw-bridge', {
        method: 'POST',
        body: {
          sessionKey: activeAgent,
          message: text,
          userId: user?.id,
        },
      });

      if (error) throw error;

      const assistantMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.reply || '暂无回复',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      console.error('[assistant] send error:', err);
      const errMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '发送失败，请稍后重试',
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsTyping(false);
    }
  };

  const handleKeyDown = (e: any) => {
    if (e.detail.value === '\n') {
      handleSend();
    }
  };

  return (
    <View className='assistant-page'>
      {/* Agent 选择器 */}
      <View className='agent-selector'>
        {(Object.keys(AGENTS) as AgentType[]).map((key) => (
          <View
            key={key}
            className={`agent-btn ${activeAgent === key ? 'active' : ''}`}
            onClick={() => setActiveAgent(key)}
          >
            <Text className='agent-name'>{AGENTS[key].name}</Text>
            <Text className='agent-desc'>{AGENTS[key].desc}</Text>
          </View>
        ))}
      </View>

      {/* 消息列表 */}
      <ScrollView
        ref={scrollRef}
        scrollY
        className='message-list'
        scrollIntoView={messages[messages.length - 1]?.id}
      >
        {messages.map((msg) => (
          <View
            key={msg.id}
            id={msg.id}
            className={`message ${msg.role}`}
          >
            <View className='message-avatar'>
              <Text>{msg.role === 'user' ? '我' : AGENTS[activeAgent].name[0]}</Text>
            </View>
            <View className='message-bubble'>
              <Text className='message-content'>{msg.content}</Text>
              <Text className='message-time'>
                {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          </View>
        ))}
        {isTyping && (
          <View className='message assistant typing'>
            <View className='message-avatar'>
              <Text>{AGENTS[activeAgent].name[0]}</Text>
            </View>
            <View className='message-bubble'>
              <Text className='typing-indicator'>思考中...</Text>
            </View>
          </View>
        )}
        <View ref={scrollRef} />
      </ScrollView>

      {/* 输入框 */}
      <View className='input-bar'>
        <Input
          className='input-field'
          value={inputValue}
          placeholder='输入消息...'
          confirm-type='send'
          onInput={(e) => setInputValue(e.detail.value)}
          onKeyDown={handleKeyDown}
          disabled={isTyping}
        />
        <Button
          className={`send-btn ${!inputValue.trim() || isTyping ? 'disabled' : ''}`}
          onClick={handleSend}
          disabled={!inputValue.trim() || isTyping}
        >
          发送
        </Button>
      </View>
    </View>
  );
}
