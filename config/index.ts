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
import { meooSupabaseUrlPlugin } from './vite-plugins/meoo-supabase-url';

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
    alipay: 'dist-alipay',
    swan: 'dist-baidu',
  };
  const defaultOutputRoot = outputRootMap[process.env.TARO_ENV || ''] || 'dist';
  const outputRoot = process.env.OUTPUT_ROOT?.trim() || defaultOutputRoot;
  const isH5 = process.env.TARO_ENV === 'h5';

  const buildMiniCIPluginConfig = () => {
    const hasWeappConfig = !!process.env.TARO_APP_WEAPP_APPID;
    if (!hasWeappConfig) {
      return [];
    }
    // Skip CI plugin if no private key path configured
    const privateKeyPath = process.env.TARO_APP_WEAPP_PRIVATE_KEY_PATH || '';
    if (!privateKeyPath) {
      return [];
    }
    const miniCIConfig: Record<string, any> = {
      version: pkg.version,
      desc: pkg.description,
    };
    miniCIConfig.weapp = {
      appid: process.env.TARO_APP_WEAPP_APPID,
      privateKeyPath,
    };
    return [['@tarojs/plugin-mini-ci', miniCIConfig]] as PluginItem[];
  };

  const baseConfig: UserConfigExport<'vite'> = {
    projectName: 'network-app',
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
      appName: 'network-app',
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
