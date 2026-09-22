import { View, Text, Input, ScrollView, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/auth-store';
import { supabase } from '@/supabase/client';
import { setCurrentPage, getCurrentPage, setPageSwitching } from '@/lib/inactivity-timer';
import PrivacyShield from '@/components/privacy-shield';
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

const AssistantPage = () => {
  const { user, loaded } = useAuthStore();
  const [activeAgent, setActiveAgent] = useState<AgentType>('main');
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<any>(null);
  const inactivityTimerRef = useRef<any>(null);
  const timerStartTimeRef = useRef<number>(0);

  const resetInactivityTimer = () => {
    const now = Date.now();
    if (inactivityTimerRef.current) {
      clearInterval(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    timerStartTimeRef.current = now;
    inactivityTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - timerStartTimeRef.current;
      if (getCurrentPage() !== 'assistant') {
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        return;
      }
      if (elapsed >= 120000) {
        if (inactivityTimerRef.current) {
          clearInterval(inactivityTimerRef.current);
          inactivityTimerRef.current = null;
        }
        timerStartTimeRef.current = 0;
        Taro.reLaunch({ url: '/pages/ping/index' });
      }
    }, 1000);
  };

  const checkTimeout = () => {
    if (!timerStartTimeRef.current) return;
    const elapsed = Date.now() - timerStartTimeRef.current;
    if (elapsed >= 120000) {
      Taro.reLaunch({ url: '/pages/ping/index' });
    }
  };

  useDidShow(() => {
    if (inactivityTimerRef.current) {
      clearInterval(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    setCurrentPage('assistant');
    const currentPage = getCurrentPage();
    const reallyLeft = currentPage !== '' && currentPage !== 'assistant';
    if (!reallyLeft && timerStartTimeRef.current > 0) {
      checkTimeout();
    } else {
      resetInactivityTimer();
    }
  });

  useDidHide(() => {
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
    setPageSwitching(true);
  });

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
    <PrivacyShield>
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
    </PrivacyShield>
  );
};

export default AssistantPage;
