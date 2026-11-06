export default definePageConfig({
  // custom 导航栏：隐私遮罩是 fixed 层，盖不住原生导航栏；本页原生标题为空串时
  // 切后台会在顶部露出一条空白导航栏。改自绘顶栏后遮罩可真正全屏（与 ping/chats 同款范式）。
  navigationStyle: 'custom',
  navigationBarTitleText: '',
});
