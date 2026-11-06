import { Canvas, View } from '@tarojs/components';
import Taro, { useLoad } from '@tarojs/taro';
import { claimResizeBatch, isResizeBatchAborted, putResizeItemResult, RESIZER_CANVAS_ID } from '@/lib/image-resizer';
import ErrorBoundary from '@/components/error-boundary';

/**
 * 离屏 canvas 宿主页：仅服务于图片压缩（canvasToTempFilePath 只能在页面内使用）。
 *
 * ⚠️ 批量语义：一次进入认领**整批**任务，在同一页面内逐张绘制导出，
 * 每完成一张立刻 putResizeItemResult 回写（调用方据此实现「边压边传」），
 * 全部做完才 navigateBack。旧版每张图各拉起一轮页面跳转，9 张图光导航就耗掉数秒，
 * 且连续导航会被微信拒绝 —— 这是多图发送慢的根因。
 */
export default function CanvasHostPage() {
  useLoad(() => {
    const batch = claimResizeBatch();
    if (!batch) {
      // 无待处理批次，或这一批已被上一层宿主页认领（调用方补拉的重复页面层）→ 直接退出
      console.warn('[canvas-host] ⚠️ 无可认领的压缩批次，直接返回');
      Taro.navigateBack().catch(() => undefined);
      return;
    }
    console.log(`[canvas-host] 🎨 认领批次 ${batch.length} 张`);

    const query = Taro.createSelectorQuery();
    query
      .select(`#${RESIZER_CANVAS_ID}`)
      .fields({ node: true, size: true })
      .exec((res: any[]) => {
        const canvas = res?.[0]?.node;
        if (!canvas) {
          console.error('[canvas-host] ❌ 拿不到 canvas 节点');
          batch.forEach((t) => putResizeItemResult(t.id, { ok: false, error: 'canvas 节点获取失败' }));
          Taro.navigateBack().catch(() => undefined);
          return;
        }
        const ctx = canvas.getContext('2d');

        // 单张：createImage → onload 缩放绘制 → canvasToTempFilePath
        const processOne = (task: (typeof batch)[number]): Promise<void> =>
          new Promise((resolve) => {
            const finish = (result: { ok: boolean; tempFilePath?: string; error?: string }) => {
              putResizeItemResult(task.id, result);
              resolve();
            };
            let img: any;
            try {
              img = canvas.createImage();
            } catch (e) {
              finish({ ok: false, error: `createImage 异常: ${String(e)}` });
              return;
            }
            img.onload = () => {
              try {
                const scale = Math.min(1, task.maxSide / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                canvas.width = w;
                canvas.height = h;
                ctx.clearRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                Taro.canvasToTempFilePath({
                  canvas,
                  width: w,
                  height: h,
                  destWidth: w,
                  destHeight: h,
                  fileType: 'jpg',
                  quality: task.quality,
                  success: (r) => {
                    console.log(`[canvas-host] ✅ ${task.id} 导出成功`);
                    finish({ ok: true, tempFilePath: r.tempFilePath });
                  },
                  fail: (e: any) => {
                    console.error('[canvas-host] ❌ canvasToTempFilePath 失败:', e?.errMsg || e);
                    finish({ ok: false, error: e?.errMsg || 'canvasToTempFilePath 失败' });
                  },
                } as any);
              } catch (e) {
                console.error('[canvas-host] ❌ 绘制异常:', e);
                finish({ ok: false, error: String(e) });
              }
            };
            img.onerror = (e: any) => {
              console.error('[canvas-host] ❌ 图片加载失败:', e?.errMsg || e);
              finish({ ok: false, error: '图片加载失败' });
            };
            img.src = task.src;
          });

        // 逐张串行：canvas 节点只有一个，宽高复用必须等上一张导出完成
        void (async () => {
          const mark = batch[0].id;
          let handled = 0;
          for (const task of batch) {
            // 【取消】每张开始前检查中止标记：调用方取消后立刻收摊返回，
            // 不做剩余图片（已完成的不撤回，宿主页退出即释放 canvas）。
            if (isResizeBatchAborted(mark)) {
              console.warn(`[canvas-host] 🛑 批次已取消，跳过剩余 ${batch.length - handled} 张`);
              break;
            }
            await processOne(task);
            handled += 1;
          }
          console.log(`[canvas-host] 🏁 批次结束 ${handled}/${batch.length} 张，返回上一页`);
          Taro.navigateBack().catch(() => undefined);
        })();
      });
  });

  // canvas 移出可视区域避免闪现空白画布；实际绘制宽高在每张 img.onload 后按缩放结果设置。
  return (
    <ErrorBoundary route="pages/canvas-host/index">
    <View style={{ position: 'fixed', left: '-2000px', top: '-2000px' }}>
      <Canvas type="2d" id={RESIZER_CANVAS_ID} style={{ width: '400px', height: '400px' }} />
    </View>
    </ErrorBoundary>
  );
}
