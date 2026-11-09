/**
 * Taro 运行时替身：让前端适配器（src/supabase/selfhost-client.ts）能在 Node 里跑。
 * 只实现适配器真正用到的 4 个能力：本地存储、request、arrayBufferToBase64。
 */
const store = new Map();

export default {
  getStorageSync(key) {
    return store.has(key) ? store.get(key) : '';
  },
  setStorageSync(key, value) {
    store.set(key, value);
  },
  removeStorageSync(key) {
    store.delete(key);
  },
  async request({ url, method = 'GET', header = {}, data }) {
    const res = await fetch(url, {
      method,
      headers: header,
      body: method === 'GET' || data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { statusCode: res.status, data: parsed, header: {} };
  },
  arrayBufferToBase64(buf) {
    return Buffer.from(buf).toString('base64');
  },
};
