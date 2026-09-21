/**
 * H5 预览特殊样式注入
 * 如无必要，请勿修改本文件
 */

import { IS_H5_ENV } from './env';

const H5_BASE_STYLES = `
/* H5 端隐藏 TabBar 空图标（只隐藏没有 src 的图标） */
.weui-tabbar__icon:not([src]),
.weui-tabbar__icon[src=''] {
  display: none !important;
}

.weui-tabbar__item:has(.weui-tabbar__icon:not([src])) .weui-tabbar__label,
.weui-tabbar__item:has(.weui-tabbar__icon[src='']) .weui-tabbar__label {
  margin-top: 0 !important;
}

/* Vite 错误覆盖层无法选择文本的问题 */
vite-error-overlay {
  /* stylelint-disable-next-line property-no-vendor-prefix */
  -webkit-user-select: text !important;
}

vite-error-overlay::part(window) {
  max-width: 90vw;
  padding: 10px;
}

.taro_page {
  overflow: auto;
}

::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 2px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.3);
}

/* H5 顶部 navbar / 底部 tabbar 高度变量（无对应栏时为 0） */
body { --navbar-h: 0px; --tabbar-h: 0px; }
body.h5-navbar-visible { --navbar-h: 44px; }
body:not(.no-tabbar) { --tabbar-h: calc(50px + env(safe-area-inset-bottom)); }

/* 模拟真机效果 */
.taro_page {
  box-sizing: border-box;
  border-top: var(--navbar-h) solid transparent;
  border-bottom: var(--tabbar-h) solid transparent;
  transform: translateZ(0);
}

/* min-h-screen / h-screen 这类用 100vh 的内层容器：把锚点从视口换成"可见内容区"，避免被 navbar / tabbar 盖住 */
.taro_page .min-h-screen {
  min-height: calc(100vh - var(--navbar-h) - var(--tabbar-h));
}
.taro_page .h-screen {
  height: calc(100vh - var(--navbar-h) - var(--tabbar-h));
}

/*
 * H5 端 rem 适配：与小程序 rpx 缩放一致
 * 375px 屏幕：1rem = 16px，小程序 32rpx = 16px
 */
html {
    font-size: 4vw !important;
}

/* H5 端组件默认样式修复 */
taro-view-core {
    display: block;
}

taro-text-core {
    display: inline;
}

taro-input-core {
    display: block;
    width: 100%;
}

taro-input-core.taro-otp-hidden-input input {
    color: transparent;
    caret-color: transparent;
    -webkit-text-fill-color: transparent;
}

/* Textarea 关闭浏览器自带 resize 把手（移动端无意义） */
taro-textarea-core > textarea,
.taro-textarea,
textarea.taro-textarea {
    resize: none !important;
}
`;


function injectStyles() {
  const style = document.createElement('style');
  style.innerHTML =
    H5_BASE_STYLES;
  document.head.appendChild(style);
}

function setupTabbarDetection() {
  const checkTabbar = () => {
    const hasTabbar = !!document.querySelector('.taro-tabbar__container');
    document.body.classList.toggle('no-tabbar', !hasTabbar);
  };

  checkTabbar();

  const observer = new MutationObserver(checkTabbar);
  observer.observe(document.body, { childList: true, subtree: true });
}

export function injectH5Styles() {
  if (!IS_H5_ENV) return;

  injectStyles();
  setupTabbarDetection();
}
