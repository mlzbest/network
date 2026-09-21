/**
 * 环境感知的日志工具
 * 仅开发环境(console)下输出，生产环境自动静默
 */
const isDev = process.env.NODE_ENV === 'development' || TARO_ENV !== 'h5' ? true : false;

export const log = (...args: any[]) => {
  if (isDev) console.log(...args);
};

export const warn = (...args: any[]) => {
  if (isDev) console.warn(...args);
};

export const err = (...args: any[]) => {
  console.error(...args);
};
