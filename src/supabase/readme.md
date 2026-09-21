`client.ts` 和 `types.ts` 由 Meoo Cloud 自动生成并管理，请勿手动修改、覆盖或重新创建。

执行 `meoo-cli cloud init` 或平台恢复云服务时，平台会自动生成客户端和云服务环境配置：

Database、Auth、Storage 和 Realtime 必须使用 `client.ts` 导出的 `supabase` Client；不要自行调用 `createClient()`。云函数如果使用裸 `fetch` / `Taro.request`，URL 必须基于 `client.ts` 导出的 `supabaseUrl`，并携带必要的 `apikey`、`Authorization` 和 `OneDay-App-Id` 请求头。
