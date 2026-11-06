import fs from 'node:fs';
import path from 'node:path';

import tailwindcss from '@tailwindcss/postcss';
import { UnifiedViteWeappTailwindcssPlugin } from 'weapp-tailwindcss/vite';
import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import type { PluginItem } from '@tarojs/taro/types/compile/config/project';
import dotenv from 'dotenv';
import devConfig from './dev';
import prodConfig from './prod';
import pkg from '../package.json';
import { ensurePackageVersionSynced } from './app-version.cjs';
import { meooSupabaseUrlPlugin } from './vite-plugins/meoo-supabase-url';

/**
 * 版本号真源在 src/lib/app-release.ts 的 CHANGELOG 顶部条目。构建期先把它同步到
 * package.json（mini-ci 上传时用的就是 pkg.version），再取同步后的值注入给前端，
 * 保证「微信后台版本号 / 关于行 / 更新日志」三处永远一致。解析失败时回退 pkg.version。
 */
const APP_RELEASE_VERSION = ensurePackageVersionSynced().version ?? pkg.version;

const useLegacySupabaseUrlPlugin = (() => {
  try {
    const marker = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../.meoo-template-version.json'),
        'utf8',
      ),
    );
    return Number(marker?.cloudClientVersion) < 2;
  } catch {
    // 历史项目没有版本标记，继续使用编译期 URL 切换插件。
    return true;
  }
})();

const cloudEnvFile =
  process.env.TARO_ENV === 'weapp' ? '.env.miniprogram' : '.env';
dotenv.config({
  path: path.resolve(__dirname, '..', cloudEnvFile),
  override: true,
});

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'vite'>(async (merge, _env) => {
  const outputRootMap: Record<string, string> = {
    weapp: 'dist',
    h5: 'dist-web',
  };
  const defaultOutputRoot = outputRootMap[process.env.TARO_ENV || ''] || 'dist';
  const outputRoot = process.env.OUTPUT_ROOT?.trim() || defaultOutputRoot;
  const isH5 = process.env.TARO_ENV === 'h5';

  const buildMiniCIPluginConfig = () => {
    const hasWeappConfig = !!process.env.TARO_APP_WEAPP_APPID;
    if (!hasWeappConfig) {
      return [];
    }
    const miniCIConfig: Record<string, any> = {
      version: pkg.version,
      desc: pkg.description,
    };
    if (hasWeappConfig) {
      miniCIConfig.weapp = {
        appid: process.env.TARO_APP_WEAPP_APPID,
        privateKeyPath: '',
      };
    }
    return [['@tarojs/plugin-mini-ci', miniCIConfig]] as PluginItem[];
  };

  const baseConfig: UserConfigExport<'vite'> = {
    projectName: 'meoo-app-name',
    alias: {
      '@': path.resolve(__dirname, '..', 'src'),
      '@supabase/supabase-js': isH5
      ? '@supabase/supabase-js'
      : 'supabase-wechat-js',
    },
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot,
    plugins: ['@tarojs/plugin-generator', ...buildMiniCIPluginConfig()],
    defineConstants: {
      TARO_ENV: JSON.stringify(process.env.TARO_ENV),
      MEOO_URL_ID: JSON.stringify((pkg as any).meoo?.['app-id'] ?? ''),
      // 构建期注入版本号：真源是 src/lib/app-release.ts 的 CHANGELOG 顶部条目（profile 页「关于」行展示）
      APP_VERSION: JSON.stringify(pkg.version),
      APP_RELEASE_VERSION: JSON.stringify(APP_RELEASE_VERSION),
      // 构建模式标记，供 lib/logger.ts 判定生产环境是否静默 debug 日志
      APP_NODE_ENV: JSON.stringify(process.env.NODE_ENV),
    },
    copy: {
      patterns: [],
      options: {},
    },
    jsMinimizer: 'esbuild',
    framework: 'react',
    compiler: {
      type: 'vite',
      vitePlugins: [
        {
          name: 'postcss-config-loader-plugin',
          config(config) {
            // 通过 postcss 配置注册 tailwindcss 插件
            if (typeof config.css?.postcss === 'object') {
              config.css?.postcss.plugins?.unshift(tailwindcss());
            }
          },
        },
        {
          /**
           * 预构建全部运行期依赖，消除「运行中 optimizeDeps 重载 → 旧 hash 504」。
           *
           * 【为什么需要】Vite dev server 启动时只扫描「入口可达」的依赖做预构建。
           * 本项目是 Taro H5 + 多页懒加载，Taro 运行时依赖（@tarojs/*）、react-dom/client、
           * zustand、@supabase/supabase-js 等会在 dev server 启动**之后**才被陆续发现，
           * 于是触发 `✨ new dependencies optimized` + `optimized dependencies changed. reloading`。
           * 浏览器在 reload 瞬间请求的旧 hash chunk 会被 dev server 以 **504** 拒绝，
           * 浏览器随即抛 `TypeError: Importing a module script failed.`
           * （用户实测报错时间戳与 vite reload 日志同一秒，可复现）。
           *
           * 【为什么清单是这 11 个】不是凭经验列的，而是直接取自 dev server 日志里
           * `✨ new dependencies optimized:` 那一行实际打印的包名——上一轮只补了
           * `zustand/shallow` 一个，而实际触发重载的是 10 个依赖，所以报错仍复现。
           * 以日志为准，不要以「哪个页面用到」为准。
           *
           * 【为什么用 vite 插件而不是 Taro 的 prebundle】Taro 的 `compiler.prebundle`
           * 是给 webpack 模式用的；vite 模式下真正生效的是 vite 自己的 `optimizeDeps`，
           * 而 Taro 的 `h5` 配置里没有暴露 `vite` 字段，只能通过 vitePlugins 的
           * `config()` 钩子注入。
           *
           * ⚠️ 新增依赖后若 dev 日志再次出现 `✨ new dependencies optimized`，
           *    把新包名补进这个数组即可（这是唯一需要改的地方）。
           */
          name: 'optimize-deps-include-plugin',
          config() {
            const include = [
              '@tarojs/taro',
              '@tarojs/router',
              '@tarojs/runtime',
              '@tarojs/components',
              '@tarojs/components/dist/components',
              '@tarojs/plugin-platform-h5/dist/runtime',
              '@tarojs/plugin-framework-react/dist/runtime',
              'react-dom/client',
              'zustand',
              'zustand/shallow',
              '@supabase/supabase-js',
            ];
            // 构建期日志：确认插件真的被 Taro 调用、且 include 已注入（排查「配置写了不生效」的第一依据）
            console.log(
              `[optimize-deps] 注入 optimizeDeps.include（${include.length} 项，消除运行中重载）: ${include.join(', ')}`,
            );
            return {
              optimizeDeps: {
                include,
              },
            };
          },
        },
        {
          name: 'hmr-config-plugin',
          config() {
            return;
          },
        },
        ...(isH5
          ? []
          : [
              ...(useLegacySupabaseUrlPlugin
                ? [
                    meooSupabaseUrlPlugin({
                      url: (pkg as any).meoo?.['api-url'] ?? '',
                      urlId: (pkg as any).meoo?.['app-id'] ?? '',
                    }),
                  ]
                : []),
              UnifiedViteWeappTailwindcssPlugin({
                rem2rpx: true,
                cssEntries: [path.resolve(__dirname, '../src/app.css')],
              }),
            ]),
      ],
    },
    mini: {
      /**
       * 图片资源内联阈值。
       *
       * 【为什么必须显式设成 0】Taro 默认会把小于 10KB 的图片转成 base64 内联进 JS。
       * 轨迹页的起点/终点图钉是 96×96 的透明 PNG（各约 8KB），会被内联成
       * `data:image/png;base64,...` 塞进 `pages/location-track/index.js`。
       * 而微信 `<Map>` 的 `marker.iconPath` **只接受包内文件路径或网络 URL**，
       * 传 data URI 不会报错、但图钉完全不显示——是这类功能最隐蔽的静默失败。
       * 设成 0 后所有图片都落成真实文件，`iconPath` 拿到的是 `/assets/xxx.png`。
       */
      imageUrlLoaderOption: {
        limit: 0,
        /**
         * 【为什么必须显式接管 name】Taro 4.2.0 的 vite-plugin-assets 在 Windows 上
         * 用 `id.replace(sourceDir + '/', '')` 生成 emitFile 的 fileName，但 sourceDir
         * 是反斜杠的原生路径（`D:\...\src`），而 id 是正斜杠（`D:/.../src/...`），
         * replace 永远不命中，绝对路径被直接传给 Rollup，构建报 VALIDATION_ERROR：
         * "fileName ... must be strings that are neither absolute nor relative paths"。
         * 这里用插件自带的 name 钩子返回稳定的、相对 src 的路径（等价于插件本意）。
         * 非 Windows 环境同样生效，行为一致。
         */
        name: (id: string) => {
          const normalized = String(id).replace(/\\/g, '/');
          const marker = '/src/';
          const idx = normalized.lastIndexOf(marker);
          return idx >= 0
            ? normalized.slice(idx + marker.length)
            : (normalized.split('/').pop() || 'asset');
        },
      },
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
    h5: {
      publicPath: './',
      staticDirectory: 'static',
      router: {
        mode: 'hash',
      },
      devServer: {
        port: 3015,
        host: '0.0.0.0',
        strictPort: true,
        open: false,
        hmr: {
          overlay: false,
        },
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css',
      },
      postcss: {
        autoprefixer: {
          enable: true,
          config: {},
        },
        pxtransform: {
          enable: true,
          config: {
            platform: 'h5',
          },
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
    rn: {
      appName: 'meoo-app-name',
      postcss: {
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
        },
      },
    },
  };

  process.env.BROWSERSLIST_ENV = process.env.NODE_ENV;

  if (process.env.NODE_ENV === 'development') {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig);
  }
  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig);
});
