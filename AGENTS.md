# 项目技术上下文

## Dependencies
- **Taro 4.x** - 跨端小程序开发框架
- **React 18 + TypeScript** - UI组件库与类型系统
- **Tailwind CSS v4** - 原子化CSS框架
- **shadcn/ui** - UI组件库
- **Zustand** - 状态管理
- **Supabase** - 后端云服务(数据库、认证、存储)

## Architecture
- **页面结构**: Taro标准页面路由,首页为`pages/ping/index`
- **状态管理**: Zustand store分离业务逻辑(`src/store/`)
- **API层**: 统一API封装在`src/api/`,禁止直接调用supabase client
- **云服务**: Meoo Cloud(Supabase),通过`meoo-cli`管理

## What Didn't Work
- ❌ **requiredPrivateInfos声明录音/媒体接口** - 平台CI白名单仅允许8个位置相关接口(getLocation等),声明getRecorderManager/chooseMedia会导致上传失败HTTP 500。解决方案:注释掉配置,真机测试时微信原生运行不受此限制
- ❌ **Edge Function URL硬编码** - ping页面直接写死supabase域名导致真机报错"url not in domain list"。解决方案:从client.ts导入supabaseUrl动态拼接,并在微信公众平台后台配置合法域名
- ❌ **Form内View onClick不触发** - Form的onSubmit会拦截子元素点击事件,需添加`e.stopPropagation()`阻止冒泡
- ❌ **hideLoading无对应showLoading报错** - 异步错误流程中可能调用hideLoading但loading未显示,需用try-catch包裹
- ❌ **图片选择器未选先提示发送中** - handleSelectImage在调起chooseMedia前就setUploading+showLoading,导致用户点加号还没选图就看到"上传中"。解决方案:先await选图,确认files.length>0后再进入上传状态
- ❌ **键盘弹出与输入框间距过大** - 底部输入区固定paddingBottom为env(safe-area-inset-bottom),与bottom:keyboardOffset叠加导致全面屏设备空白过大。解决方案:keyboardOffset>0时paddingBottom设为0
- ❌ **JSX中直接写console.log报TS2322** - `{console.log(...)}`返回void不能赋给ReactNode。解决方案:日志放在事件回调或useEffect中
- ❌ **Edge Function用Deno.Command执行系统ping** - Deno Edge Runtime禁止`child_process`/系统命令且无法发ICMP,原`new Deno.Command('ping')`必然运行时报错。解决方案:改用Web `fetch`向目标发HTTP HEAD请求,连续探测多次统计丢包率与min/avg/max延迟
- ❌ **Edge Function用addEventListener('fetch')写法** - 部署前`deno check`会把event推断为通用Event,报`respondWith/request不存在`。解决方案:直接用`Deno.serve(handler)`
- ❌ **HTTP探测纯IP失败** - 纯IP拼成`https://IP`时因443无HTTPS服务或证书无效导致fetch失败,误判不可达;域名却正常。解决方案:对host生成候选URL列表(IP优先http:80→https:443→http:8080,域名反之),先探可达地址再测延迟
- ❌ **页面级useDidHide无法区分切后台** - chats/chat/profile页的`useDidShow/useDidHide`在页面跳转和切后台时都会触发,不能用于隐私遮挡判断。解决方案:新建`src/components/privacy-shield`组件,用App级事件`Taro.onAppHide/onAppShow`(仅小程序整体切前后台触发),切后台即盖不透明遮罩,回前台保持遮挡需用户点击才解除
- ❌ **多实例PrivacyShield全员亮罩** - 每页各挂一个PrivacyShield实例,onAppHide会同时广播到所有存活页面实例(小程序页面navigateTo后旧页不销毁),导致从聊天详情切后台再返回聊天列表时列表页也被遮挡。解决方案:抽出`src/lib/shield-state.ts`模块级单例记录"切后台时刻最后可见页面的路由",仅路由命中的实例亮罩;点击解除时复位全局标记
- ❌ **fixed遮罩盖不住原生导航栏返回键** - 遮罩期间点系统返回键/右滑仍能跳到其他页面。解决方案:三管齐下——①遮罩时`wx.setSwipeBackMode({mode:0})`禁iOS右滑+`hideHomeButton`(try-catch降级,低版本忽略);②被遮挡页外的其他敏感页`useDidShow`开头检查`isShieldArmed()`且归属路由非本页则立即`reLaunch`回被遮挡页(兜底封堵返回键路径);③TabBar沿用hide/show
- ❌ **聊天页ScrollView高度与滚动停留位置方向相反** - 想让自动滚到底的最新消息在屏幕上更靠上,直觉"减小视口扣减值增高消息区"是反的:滚到底时最新消息始终贴可视区底缘。正确做法:加大扣减值让消息区变矮,底部留白把最新消息向上顶起。
- ❌ **Realtime降级轮询全量重拉导致收消息延迟被放大** - 每秒`listMessages`全量查messages+message_deletes两张表,网络稍慢一轮就超时,新消息实际延迟数秒且要等自己发消息才显示。解决方案:订阅SUBSCRIBED后立即补拉一次(覆盖握手期漏掉的INSERT事件);降级轮询改两条增量小查询(listPeerMessagesSince按created_at游标、listMyReadMessages按read_at非空),游标用服务端时间戳而非本地时钟防设备时钟偏差漏拉。
- ❌ **聊天页长按菜单极易误触发(真因是滚动停顿+热区过大)** - ①500ms纯计时判定长按,滚动时手指停在消息上不动也达标;②touchstart绑在整行flex容器上,点消息两侧空白按住同样弹菜单。解决方案:①热区收窄——触摸四事件只绑气泡+时间行的`max-w-3/4`容器,行层只留onClick勾选;②touchmove位移>10px取消计时;③时长650ms;④selectMode内onMsgTouchStart直接return(多选里只勾选,不再弹菜单);⑤达成只弹ActionSheet,确认才setSelectMode;删除按钮另加showModal二次确认。
- ❌ **Taro子元素onClick不自动阻止冒泡** - 消息行onClick处理完click继续冒泡到ScrollView,被"点空白退出多选"逻辑误判exitSelectMode,表现为"刚勾上第2条就自动取消"。凡外层容器有onClick(退出多选/收起键盘)时,内层交互元素handler必须`(e)=>{e.stopPropagation();...}`;长按抬手补发的click用pendingLongPressRef在行内精确消费并同步复位longPressFiredRef。
- ❌ **chats页useDidShow用currentPage判定"页面切换"** - 小程序切后台不会改写currentPage,超过120秒无操作计时器后从ping页输入暗号reLaunch进列表,旧实例didShow仍认为"未切换"而走checkTimeout立即弹回ping;且遮挡归属页已不在栈里时兜底reLaunch也会把刚进入的本页顶走。解决方案:切后台/回到本页→只checkTimeout;真正导航离开过(currentPage被其他页改写)或首次进入→重置计时器;遮挡兜底先查armedRoute是否仍在getCurrentPages栈内,不在则disarmShield停留本页而非弹回。
- ❌ **armedRoute带斜杠与页面route比较不一致致解除后仍弹回** - shield-state里曾用normalizeRoute补前导斜杠,而各页useDidShow兜底用不带斜杠的`pages/chat/index`比较,永远不等→用户点解除后正常navigateBack也被误判"遮挡未解除"反复reLaunch。解决方案:全链路统一使用getCurrentPages()栈顶原始route(无前导斜杠),reLaunch时才补'/';并在PrivacyShield卸载cleanup里把未解除的遮挡归属移交当前栈顶页,防状态悬挂

## Lessons
- **Edge Function部署前置**: 每个函数独立打包,不复用根目录package.json/node_modules;第三方依赖用完整URL/jsr:/npm:导入;禁用Buffer等Node专属API。CORS由网关统一处理,函数代码不要自设`Access-Control-Allow-*`头也不要处理OPTIONS。改代码后必须重新`deploy-function`才生效
- **verify_jwt=true的函数测试**: 前端调用需带`Authorization`(登录token或anon key)+`apikey`头;沙箱侧用`meoo-cli cloud test-request --method POST --path /functions/v1/{name} --json '{...}'`走平台托管登录态做真实验证
- **Taro小程序隐私接口声明**: 使用录音(`recorderManager`)或媒体选择(`chooseMedia`)等涉及用户隐私的API时,必须在`src/app.config.ts`中添加`requiredPrivateInfos`数组声明对应接口名(不带`wx.`前缀),否则真机运行时报错`api scope is not declared in the privacy agreement`。**但Meoo平台CI有额外白名单限制**,只允许位置接口,录音/媒体接口需注释掉配置,依赖微信公众平台后台的隐私保护指引审核
- **Supabase Edge Function域名配置**: 真机调用Edge Function前,必须在微信公众平台【开发管理】→【服务器域名】→【request合法域名】中添加Supabase域名,否则报错`request:fail url not in domain list`
- **Form内按钮点击**: Form包裹的View/Text等非Button元素的onClick会被Form的onSubmit拦截,必须添加`e.stopPropagation()`阻止事件冒泡
- **hideLoading容错处理**: 所有`Taro.hideLoading()`调用都应包裹在try-catch中,避免在loading未显示时调用导致报错
- **表情发送后关闭面板**: 发送表情后需手动调用`setShowEmojiPanel(false)`关闭面板,并提供成功反馈(toast)
- **聊天页滚动到底部机制**: ScrollView用递增计数器`scrollTop = 999999 + timerIdCounter.current`强制触发滚到底部(相同值不会触发更新)。键盘弹出自动滚到最新消息需在`keyboardOffset`从0变>0的边沿触发,并setTimeout约250ms等输入区高度稳定
- **Input adjustPosition={false}**: 聊天页禁用系统自动上推,改用监听键盘高度手动设置`bottom`,因此键盘相关的布局问题都要在这一套自定义定位逻辑里处理
