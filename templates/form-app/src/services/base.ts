/**
 * 站台根路徑（strucmed 整合站台 /strucmed 的前綴）。
 *   - H0 本機 Docker：app 在 /，nginx 把 /strucmed、/llmgw、/FM 反向代理到站台 → SITE_BASE 由 app.config.json 的 siteBase 給（預設 /strucmed）
 *   - H2 站台 /strucmed/apps/<name>/：由網址推算（/apps/ 之前的部分）
 *   - 開發：VITE_API_BASE_URL 覆寫
 * 不論哪一種，瀏覽器看到的都是同一個 Origin，api/v2 不需要 CORS。
 */
import appConfig from '../app-config';

const fromLocation = (): string | null => {
  const m = window.location.pathname.match(/^(.*?)\/(apps|note)(\/|$)/);
  return m ? m[1] : null;
};

export const SITE_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  fromLocation() ??
  appConfig.siteBase;

/** app 首頁（登入頁）的網址：目前路徑的目錄 */
export const APP_HOME = window.location.pathname.replace(/[^/]*$/, '');
/** 與 原版相容的名稱（exitHandler.ts 使用） */
export const NOTE_HOME = APP_HOME;
