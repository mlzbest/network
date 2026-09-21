/**
 * 无操作超时 Hook
 * 封装120秒无操作返回ping页的逻辑，供所有业务页面复用
 *
 * @param pageName 当前页面标识 (如 'profile'、'chat'、'chats')
 * @param enabled 是否启用计时器，默认 true
 */
import { useRef, useEffect, useCallback } from 'react';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { setPageSwitching, resetPageSwitching, setCurrentPage, getCurrentPage } from './inactivity-timer';
import { isShieldArmed, getArmedRoute } from './shield-state';

const TIMEOUT_MS = 120_000; // 120秒

export function useInactivityTimer(pageName: string, enabled = true) {
  const timerRef = useRef<any>(null);
  const startTimeRef = useRef<number>(0);

  /** 清除旧计时器 */
  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  /** 启动计时器 */
  const startTimer = useCallback(() => {
    clearTimer();
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      if (elapsed >= TIMEOUT_MS) {
        clearTimer();
        startTimeRef.current = 0;
        Taro.reLaunch({ url: '/pages/ping/index' });
      }
    }, 1000);
  }, []);

  /** 检查是否已超时，超时则立即跳转 */
  const checkTimeout = useCallback(() => {
    if (!startTimeRef.current) return;
    const elapsed = Date.now() - startTimeRef.current;
    if (elapsed >= TIMEOUT_MS) {
      clearTimer();
      startTimeRef.current = 0;
      Taro.reLaunch({ url: '/pages/ping/index' });
    }
  }, []);

  // 页面显示时:区分页面切换vs从后台切回
  useEffect(() => {
    if (!enabled) return;

    const onShow = () => {
      // 兜底：遮挡未解除时弹回被遮挡页
      const ownRoute = `pages/${pageName}/index`;
      if (isShieldArmed() && getArmedRoute() !== ownRoute) {
        Taro.reLaunch({ url: '/' + getArmedRoute() });
        return;
      }

      const currentPage = getCurrentPage();
      const isPageSwitch = currentPage !== '' && currentPage !== pageName;

      clearTimer();
      setCurrentPage(pageName);

      if (isPageSwitch) {
        // 页面间切换：重置计时器
        startTimer();
      } else if (startTimeRef.current) {
        // 从后台切回：检查是否超时
        checkTimeout();
      } else {
        // 首次进入：启动计时器
        startTimer();
      }
    };

    const onHide = () => {
      clearTimer();
      setPageSwitching(true);
    };

    useDidShow(onShow);
    useDidHide(onHide);

    return () => {
      clearTimer();
      resetPageSwitching();
    };
  }, [pageName, enabled, startTimer, checkTimeout]);

  return { startTimer, checkTimeout, clearTimer };
}
