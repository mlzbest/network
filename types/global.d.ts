/// <reference types="@tarojs/taro" />

declare const TARO_ENV: "weapp" | "h5" | undefined;
declare const MEOO_URL_ID: string;
/** 构建期由 config/index.ts defineConstants 注入的 package.json 版本号 */
declare const APP_VERSION: string;
/**
 * 构建期注入的**发布版本号**：真源是 src/lib/app-release.ts 的 CHANGELOG 顶部条目，
 * 由 config/app-version.cjs 在构建期解析并同步到 package.json 后注入。「关于」行与
 * 更新日志的「当前版本」徽标都取它，保证与微信后台版本号一致。
 */
declare const APP_RELEASE_VERSION: string;
/** 构建期注入的 NODE_ENV 快照（'development' | 'production' | 'test'），logger 降噪开关 */
declare const APP_NODE_ENV: string;

declare module '*.png';
declare module '*.gif';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.svg';
declare module '*.css';
declare module '*.less';
declare module '*.scss';
declare module '*.sass';
declare module '*.styl';

declare namespace NodeJS {
  interface ProcessEnv {
    /** NODE 内置环境变量, 会影响到最终构建生成产物 */
    NODE_ENV: 'development' | 'production',
    /** 当前构建的平台 */
    TARO_ENV: 'weapp' | 'swan' | 'alipay' | 'h5' | 'rn' | 'tt' | 'qq' | 'jd' | 'harmony' | 'jdrn'
    /**
     * 当前构建的小程序 appid
     * @description 若不同环境有不同的小程序，可通过在 env 文件中配置环境变量`TARO_APP_ID`来方便快速切换 appid， 而不必手动去修改 dist/project.config.json 文件
     * @see https://taro-docs.jd.com/docs/next/env-mode-config#特殊环境变量-taro_app_id
     */
    TARO_APP_ID: string
  }
}


