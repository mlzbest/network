/**
 * 小程序端 Realtime 套接字误报补丁。
 *
 * 背景：weapp 构建里 @supabase/supabase-js 被 alias 到 supabase-wechat-js，
 * 其 RealtimeClient 直接用 wx.connectSocket() 的返回值当 socket 对象。但真机
 * 上该返回值是「全局 SocketTask」，close() 内部走 wx.closeSocket(taskID)；
 * 一旦任务已被微信侧回收（心跳超时主动断开、切后台冻结后关闭等），close()
 * 就以 Promise reject 报 `closeSocket:fail wcwss taskID not exist`。库内调用
 * 处（disconnect / _sendHeartbeat）全是裸调、无 fail 回调也不 catch，try/catch
 * 吞不住异步失败，最终冒成 SystemError (appServiceSDKScriptError) 红字。
 *
 * ⚠️【为什么不能包装 `_initRealtimeClient`（旧实现的做法，已废弃）】
 * 旧版在 `SupabaseClient.prototype._initRealtimeClient` 上包一层，指望「新建
 * RealtimeClient 时顺手包装它的 conn.close」。但 `src/supabase/client.ts` 是在
 * **模块加载时**就执行 `createClient(...)` 的，而 `createClient` 内部会**立即**
 * 调用 `_initRealtimeClient`（见 SupabaseClient.ts 的 `this.realtime = this._initRealtimeClient(...)`）。
 * 本补丁在 `app.tsx` 的 `useLaunch` 里才安装，那时 `_initRealtimeClient` 早已跑完、
 * 再也不会被调用 → 包装函数永远不执行 → 补丁形同虚设，用户仍能看到红字报错。
 *
 * ✅【现在的做法】直接对**已经创建好的** `supabase.realtime` 实例做包装：
 *   ① 包装 `disconnect`：库内唯一的主动 close 出口（`removeChannel` /
 *      `removeAllChannels` / 重连定时器都汇流到它）；
 *   ② 包装 `_sendHeartbeat`：心跳超时那条 `this.conn?.close(...)` 是另一条
 *      独立出口，不经过 disconnect；
 *   ③ 兜底包装 `connect`：让**后续重连新建的** conn 也带上安全 close。
 * 三条路径合起来覆盖了库内全部 close 调用点，且不依赖任何「未来才会发生」的时机。
 *
 * 仅影响本项目自己创建的 client，不改动 node_modules。H5 端不存在该问题，直接跳过。
 */

import { supabase } from '@/supabase/client';
import { isH5 } from '@/lib/platform';
import { logDbg } from './logger';

let applied = false;

/** 判断是否为「套接字已被微信回收」类失败——这类失败是纯噪音，必须吞掉 */
function isStaleSocketError(e: any): boolean {
  const msg = String(e?.errMsg || e?.message || e || '');
  return /taskID not exist|closeSocket:fail|socket.*not exist|not connected/i.test(msg);
}

/** 统一的失败处理：失效套接字静默吞掉，其他错误仍打日志（便于排障） */
function swallowStaleClose(e: any, tag: string): void {
  if (isStaleSocketError(e)) {
    logDbg(`[rt-patch] 忽略失效套接字 close 失败(${tag}):`, e?.errMsg || e?.message || e);
    return;
  }
  logDbg(`[rt-patch] close 失败(${tag}，非失效套接字，仅记录):`, e?.errMsg || e?.message || e);
}

/**
 * 把任意「可能返回 Promise 也可能同步抛」的调用包成安全版本。
 * 微信的 SocketTask.close 在不同基础库上行为不一致：有的返回 Promise、
 * 有的走 fail 回调、有的直接同步抛 —— 三种都要兜住。
 */
function safeInvoke(fn: () => any, tag: string): void {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') {
      r.catch((e: any) => swallowStaleClose(e, tag));
    }
  } catch (e) {
    swallowStaleClose(e, tag);
  }
}

/** 给一个 conn 对象挂上安全 close（幂等） */
function patchConnClose(conn: any): void {
  if (!conn || typeof conn.close !== 'function' || conn.__closePatched__) return;
  conn.__closePatched__ = true;
  const origClose = conn.close.bind(conn);
  conn.close = function safeClose(...args: any[]) {
    let opts = args[0];
    let cb: any = args[1];
    // 兼容两种签名：close(code, reason) 与 close({code, reason, success, fail})
    if (typeof opts === 'number') {
      opts = { code: opts, reason: typeof cb === 'string' ? cb : '' };
      cb = undefined;
    }
    if (opts && typeof opts === 'object') {
      // 补上 fail 回调：库内 disconnect 只传了 success，没有 fail，
      // 于是失败只能冒成未捕获的 Promise 拒绝。
      opts = {
        ...opts,
        fail: (e: any) => swallowStaleClose(e, 'fail-cb'),
      };
    }
    safeInvoke(() => origClose(opts), 'close');
  };
}

export function patchRealtimeSocket(): void {
  if (applied) return;
  applied = true;
  if (isH5()) {
    logDbg('[rt-patch] H5 环境无需修补 closeSocket');
    return;
  }
  try {
    const rt = (supabase as any)?.realtime;
    if (!rt) {
      logDbg('[rt-patch] 未找到 supabase.realtime 实例, 跳过(库结构可能已变化)');
      return;
    }
    const proto = Object.getPrototypeOf(rt);
    if (!proto) {
      logDbg('[rt-patch] 无法取得 RealtimeClient 原型, 跳过');
      return;
    }

    // ① 包装 disconnect —— 库内唯一的主动 close 出口。
    //    removeChannel / removeAllChannels / 重连定时器都汇流到这里。
    const origDisconnect = proto.disconnect;
    if (typeof origDisconnect === 'function' && !proto.__disconnectPatched__) {
      proto.__disconnectPatched__ = true;
      proto.disconnect = function safeDisconnect(this: any, ...args: any[]) {
        // 先把当前 conn 的 close 换成安全版，再交给原实现去调。
        // 这样即使原实现内部是裸调 close()，失败也会被吞掉。
        patchConnClose(this.conn);
        try {
          return origDisconnect.apply(this, args);
        } catch (e) {
          swallowStaleClose(e, 'disconnect');
        }
      };
    }

    // ② 包装 _sendHeartbeat —— 心跳超时那条 `this.conn?.close(...)` 是独立出口，
    //    不经过 disconnect，必须单独兜住。
    const origHeartbeat = proto._sendHeartbeat;
    if (typeof origHeartbeat === 'function' && !proto.__heartbeatPatched__) {
      proto.__heartbeatPatched__ = true;
      proto._sendHeartbeat = function safeHeartbeat(this: any, ...args: any[]) {
        patchConnClose(this.conn);
        try {
          return origHeartbeat.apply(this, args);
        } catch (e) {
          swallowStaleClose(e, 'heartbeat');
        }
      };
    }

    // ③ 兜底包装 connect —— 让后续重连新建的 conn 也带上安全 close。
    //    ⚠️ 这一步是「面向未来」的：当前 conn 由 ①② 覆盖，重连后的新 conn 靠它。
    const origConnect = proto.connect;
    if (typeof origConnect === 'function' && !proto.__connectPatched__) {
      proto.__connectPatched__ = true;
      proto.connect = function safeConnect(this: any, ...args: any[]) {
        try {
          const r = origConnect.apply(this, args);
          patchConnClose(this.conn);
          return r;
        } catch (e) {
          swallowStaleClose(e, 'connect');
        }
      };
    }

    // ④ 立即给「当前已存在的 conn」打上补丁：补丁安装时 socket 可能已经建好了
    //    （createClient 在模块加载时就执行，早于 useLaunch）。
    patchConnClose(rt.conn);

    logDbg(
      `[rt-patch] ✅ closeSocket 安全包装已启用（disconnect=${!!proto.__disconnectPatched__} heartbeat=${!!proto.__heartbeatPatched__} connect=${!!proto.__connectPatched__} 当前conn=${rt.conn ? '已包装' : '尚未建立'}）`,
    );
  } catch (e) {
    logDbg('[rt-patch] 补丁安装失败:', (e as Error)?.message || e);
  }
}
