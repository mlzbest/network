import { useAuthStore } from '@/store/auth-store';

/**
 * 「真实登录态是否已就绪」的唯一判定入口。
 *
 * 【为什么必须有它】auth-store 冷启动时会先用本地缓存资料拼出一个「过渡 user」
 * （`bootstrapped: true`、`loaded: false`），目的是让依赖 user 的渲染链路不必等
 * `getSession()` 的网络往返。但过渡态**没有 access token**——此刻发起的任何
 * PostgREST 请求都会被 RLS 当匿名挡掉，在预览端表现为
 * `Failed to fetch: .../auth/v1/token?grant_type=password 状态码: 400` 这类噪音错误，
 * 用户看到的是「登录失败」，实际只是「还没登录完就发了请求」。
 *
 * 因此凡是「需要真实 token 才能成功」的请求，门控必须用本函数，而不是裸 `loaded`：
 * - `loaded === true`  → 真实登录态已到达（user 可能为 null，即确实未登录）
 * - `bootstrapped === true` → 仍是本地缓存拼的过渡态，**不可发请求**
 *
 * ⚠️ 本函数读的是 store 快照，不是响应式值。在 React 组件里做门控时，
 *    必须把 `loaded` 一并放进 effect 依赖，靠它的变化触发重跑。
 */
export function isAuthReady(): boolean {
  const { loaded, bootstrapped } = useAuthStore.getState();
  return loaded && !bootstrapped;
}
