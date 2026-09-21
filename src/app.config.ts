export default defineAppConfig({
  pages: [
    'pages/ping/index',
    'pages/chats/index',
    'pages/chat/index',
    'pages/login/index',
    'pages/profile/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fff',
    navigationBarTitleText: '',
    navigationBarTextStyle: 'black'
  },
  // 隐私协议配置:平台CI仅允许位置相关接口,录音/媒体接口需在真机测试
  // requiredPrivateInfos: ['getRecorderManager', 'chooseMedia'] as any,
  tabBar: {
    color: '#999999',
    selectedColor: '#07c160',
    backgroundColor: '#ffffff',
    list: [
      {
        pagePath: 'pages/chats/index',
        text: '会话',
        iconPath: './assets/tabbar/message-square.png',
        selectedIconPath: './assets/tabbar/message-square-active.png',
      },
      {
        pagePath: 'pages/profile/index',
        text: '我的',
        iconPath: './assets/tabbar/user.png',
        selectedIconPath: './assets/tabbar/user-active.png',
      },
    ],
  },
})
