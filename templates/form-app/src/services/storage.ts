/**
 * 安全的 sessionStorage 操作（strucmed form-app 範本）。
 * 與 原版（localStorage）的差異：token 只存在這個分頁的 sessionStorage，關閉分頁即消失，
 * 其他分頁與之後開啟的 app 看不到；函式名稱與簽章維持不變，呼叫端不用改。
 */
const store = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

/** 檢查 sessionStorage 是否可用（隱私模式或停用 cookie 時可能不可用） */
export const isLocalStorageAvailable = (): boolean => {
  try {
    const s = store();
    if (!s) return false;
    const testKey = '__test__';
    s.setItem(testKey, testKey);
    s.removeItem(testKey);
    return true;
  } catch (e) {
    console.warn('sessionStorage 不可用:', e);
    return false;
  }
};

export const getStorageItem = (key: string): string | null => {
  try { return store()?.getItem(key) ?? null; } catch (e) { console.error(`無法讀取 ${key}:`, e); return null; }
};

export const setStorageItem = (key: string, value: string): boolean => {
  try { store()?.setItem(key, value); return true; } catch (e) { console.error(`無法寫入 ${key}:`, e); return false; }
};

export const removeStorageItem = (key: string): boolean => {
  try { store()?.removeItem(key); return true; } catch (e) { console.error(`無法移除 ${key}:`, e); return false; }
};

export const clearStorage = (): boolean => {
  try { store()?.clear(); return true; } catch (e) { console.error('無法清除 sessionStorage:', e); return false; }
};
