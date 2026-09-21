import Taro from '@tarojs/taro';

// 使用Taro全局存储共享状态,确保跨页面一致
const PAGE_SWITCHING_KEY = '__inactivity_page_switching__';
const LAST_HIDE_TIME_KEY = '__inactivity_last_hide_time__';
const CURRENT_PAGE_KEY = '__inactivity_current_page__'; // 记录当前活跃页面

export function setCurrentPage(pageName: string) {
  try {
    Taro.setStorageSync(CURRENT_PAGE_KEY, pageName);
    console.log(`[inactivity-timer] 📄 setCurrentPage: ${pageName}`);
  } catch (e) {
    console.error('[inactivity-timer] setCurrentPage失败:', e);
  }
}

export function getCurrentPage(): string {
  try {
    return Taro.getStorageSync(CURRENT_PAGE_KEY) || '';
  } catch (e) {
    console.error('[inactivity-timer] getCurrentPage失败:', e);
    return '';
  }
}

export function setPageSwitching(value: boolean) {
  try {
    const timestamp = Date.now();
    Taro.setStorageSync(PAGE_SWITCHING_KEY, value);
    if (value) {
      Taro.setStorageSync(LAST_HIDE_TIME_KEY, timestamp);
      console.log(`[inactivity-timer] ✅ setPageSwitching(true), lastHideTime=${timestamp}`);
    } else {
      console.log(`[inactivity-timer] ❌ setPageSwitching(false)`);
    }
  } catch (e) {
    console.error('[inactivity-timer] setPageSwitching失败:', e);
  }
}

export function getPageSwitching(): boolean {
  try {
    const isSwitching = Taro.getStorageSync(PAGE_SWITCHING_KEY) || false;
    const lastHideTime = Taro.getStorageSync(LAST_HIDE_TIME_KEY) || 0;

    // 如果距离上次hide超过5000ms,说明是小程序后台,不是页面切换
    // 页面切换通常在几秒内完成,但小程序后台可能持续很久
    const elapsed = Date.now() - lastHideTime;
    console.log(`[inactivity-timer] 🔍 getPageSwitching: isSwitching=${isSwitching}, lastHideTime=${lastHideTime}, elapsed=${elapsed}ms`);
    if (elapsed > 5000 && lastHideTime > 0) {
      console.log(`[inactivity-timer] ⏱️ 距离上次hide已${elapsed}ms,判定为小程序后台`);
      return false;
    }
    return isSwitching;
  } catch (e) {
    console.error('[inactivity-timer] getPageSwitching失败:', e);
    return false;
  }
}

export function resetPageSwitching() {
  try {
    Taro.setStorageSync(PAGE_SWITCHING_KEY, false);
    Taro.setStorageSync(LAST_HIDE_TIME_KEY, 0);
  } catch (e) {
    console.error('[inactivity-timer] resetPageSwitching失败:', e);
  }
}
