export default defineAppConfig({
  pages: [
    'pages/ping/index',
    'pages/chats/index',
    'pages/chat/index',
    'pages/login/index',
    'pages/profile/index',
    'pages/ai-chat/index',
    // 批量诊断独立页：由 ping 页输入区「多个地址一起测？」navigateTo 进入
    'pages/batch-diag/index',
    // 离屏 canvas 宿主页：小程序端图片压缩专用（canvasToTempFilePath 只能在页面内使用）。
    // 不在 tabBar/pages 导航里出现，仅由 lib/image-resizer 内部 Taro.navigateTo 拉起。
    'pages/canvas-host/index',
    // 位置轨迹地图页：隐藏命令 `check stats` 结果区「查看轨迹」navigateTo 进入。
    // 微信 <Map> 组件不支持 h5，页面内按环境降级为点列表。
    'pages/location-track/index',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#fff',
    navigationBarTitleText: '检测网络',
    navigationBarTextStyle: 'black'
  },
  // ===== 位置能力声明（聊天「发送位置」功能）=====
  // ✅ 这里**只允许**出现下面这 8 个地理位置类接口名，且**不带 `wx.` 前缀**：
  //    chooseAddress / chooseLocation / choosePoi / getFuzzyLocation / getLocation /
  //    onLocationChange / startLocationUpdate / startLocationUpdateBackground
  //    决定性证据——上一轮误把采集类接口写进来时，生成预览码微信直接返回：
  //      CI_PREVIEW_FAILED / app.json: requiredPrivateInfos[0..4] field needs to be
  //      chooseAddress,chooseLocation,choosePoi,getFuzzyLocation,getLocation,
  //      onLocationChange,startLocationUpdate,startLocationUpdateBackground
  //    即 `chooseMessageFile`/`chooseMedia`/`getRecorderManager`/`getClipboardData`/
  //    `setClipboardData` 这些采集类接口**根本不属于它的合法取值**，写进去会让整个
  //    预览码都生成不出来（比原问题严重得多）。
  // ⚠️ 本项目的位置能力只有两项，故只声明这两个接口，不要为了"保险"把 8 个全写上——
  //    声明与实际功能不符会影响审核观感，且 getLocation 与 getFuzzyLocation 互斥
  //    （上传校验错误码 85311），全量声明必然踩中互斥对而上传失败。
  //    · chooseLocation：用户在地图上挑一个点发出去（「发送位置」按钮）
  //    · getLocation：进入聊天页时自动读取当前坐标（「发送我的位置」）
  //      ⚠️ 用 getLocation 而不是 getFuzzyLocation：需要精确坐标才能在地图上标点，
  //         且两者互斥，本项目已选精确定位，**绝不能**再声明 getFuzzyLocation。
  // ⚠️ 删掉位置功能时，必须同步删掉这里的声明与下面的 permission 文案。
  requiredPrivateInfos: ['chooseLocation', 'getLocation'],
  // 位置接口的授权弹窗文案：微信在首次调用 chooseLocation 时展示给用户。
  // 文案要说明「用来做什么」，不能只写「需要位置权限」。
  permission: {
    'scope.userLocation': {
      desc: '用于在诊断记录中标注你的位置，方便查看网络所在区域',
    },
  },
  // ✅ 采集类接口（相册/麦克风/剪切板/所选文件）的隐私授权走的是**另一套机制**：
  //    微信公众平台后台「设置 → 服务内容声明 → 用户隐私保护指引」勾选对应信息类型。
  //    那是纯后台配置，**代码里没有任何可写的地方**，不要试图写进 requiredPrivateInfos。
  //    真机报 "api scope is not declared in the privacy agreement" 的正解只有去后台勾选。
  //    ⚠️ 位置信息同样需要在后台《用户隐私保护指引》里勾选「位置信息」，
  //       否则真机 chooseLocation 会被微信拦下（代码侧声明只是发布门禁的一半）。
  // ⛔ 语音转文字的「免密通道」（微信同声传译插件 WechatSI）**已从配置注释掉**，不是代码写错：
  //    声明 plugins 后，平台 CI 在生成小程序预览码时会向微信拉取该插件包，而本项目的
  //    AppID 尚未在微信公众平台后台添加并使用该插件 → 微信直接返回
  //    `errcode 80082 / permission deny`，导致整个预览构建失败（连不进页面都无所谓）。
  //    保留声明 = 用户拿不到预览码；故先注释，让预览恢复正常。
  // ⚠️ 为什么用户在后台「搜不到」这个插件（实测反馈）：微信侧对该插件有两道硬门槛——
  //    ① **个人主体小程序不支持添加**（只能企业/政府/媒体/其他组织主体）；
  //    ② 搜索入口不在「插件管理」列表页里，必须走「添加插件」→ 输入插件 AppID
  //       `wx069ba97219f66d99` 或名称「微信同声传译」，也可从「微信服务市场」搜到后
  //       点「添加到我的小程序」。若主体是个人，两条路都会被挡。
  // 恢复步骤（用户侧动作，代码无需改动）：
  //    1) 确认小程序主体为非个人 → 公众平台后台 → 设置 → 第三方设置 → 插件管理
  //       → 「添加插件」→ 搜 `wx069ba97219f66d99` → 等待状态变为「已通过」；
  //    2) 取消下方 plugins 注释（version 以详情页展示的可用版本号为准）；
  //    3) 重新生成预览码。
  // src/lib/wechat-asr.ts 与 chat 页的调用点**保持原样**：requirePlugin 拿不到时全程
  // try/catch 静默降级，绝不打断录音与发送，所以这段注释不会引发运行时报错。
  // plugins: {
  //   WechatSI: {
  //     version: '0.3.5',
  //     provider: 'wx069ba97219f66d99',
  //   },
  // },
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
