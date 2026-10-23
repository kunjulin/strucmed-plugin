import { FormPayload, LoginPayload, LoginResponse } from '../types';
import { getStorageItem, removeStorageItem, setStorageItem } from './storage';
import { SITE_BASE } from './base';

// strucmed 組合 API v2（需要 token；身分一律取自 token，不再由用戶端帶 user）
const API_V2 = `${SITE_BASE}/api/v2`;

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = await response.json();
    return body?.error?.message || body?.message || `伺服器回應 ${response.status}`;
  } catch {
    return `伺服器回應 ${response.status}`;
  }
};

const saveTokens = (result: { accessToken?: string; refreshToken?: string }) => {
  if (result.accessToken) setStorageItem('accessToken', result.accessToken);
  if (result.refreshToken) setStorageItem('refreshToken', result.refreshToken);
};

/** 清除登入狀態（refresh 失敗或登出時）。 */
export const clearTokens = () => {
  removeStorageItem('accessToken');
  removeStorageItem('refreshToken');
};

let refreshing: Promise<boolean> | null = null;

/** 以 refresh token 換新的一組 token；同時多個請求 401 時只換一次。 */
const refreshTokens = (): Promise<boolean> => {
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = getStorageItem('refreshToken');
      if (!refreshToken) return false;
      try {
        const response = await fetch(`${API_V2}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) return false;
        saveTokens(await response.json());
        return true;
      } catch {
        return false;
      }
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
};

/**
 * 帶 access token 呼叫 api/v2；回 401 時以 refresh token 換新後重試一次，仍失敗就清除登入狀態。
 * @param path api/v2 之後的路徑（例如 /me/notes）
 */
export const apiFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const send = () => {
    const accessToken = getStorageItem('accessToken');
    const headers = new Headers(init.headers);
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetch(`${API_V2}${path}`, { ...init, headers });
  };
  let response = await send();
  if (response.status === 401) {
    if (await refreshTokens()) {
      response = await send();
    }
    if (response.status === 401) {
      clearTokens();
      throw new Error('登入已逾時，請重新登入');
    }
  }
  return response;
};

/**
 * 用戶登錄API（院內帳號，api/v2/auth/token）
 * @param payload 登錄資訊
 * @returns 登錄回應
 */
export const authenticateUser = async (payload: LoginPayload): Promise<LoginResponse> => {
  try {
    const response = await fetch(`${API_V2}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hospital: payload.hospital,
        account: payload.account,
        password: payload.password,
        deptNo: payload.deptno,
      }),
    });

    if (!response.ok) {
      return { success: false, message: await errorMessage(response) };
    }

    const result = await response.json();
    saveTokens(result);
    const user = result.userInfo || {};
    return {
      success: true,
      message: '登入成功',
      userInfo: {
        userID: user.userId || '',
        deptNo: user.deptNo || '',
        name: user.name || '',
        idno: '',
        loc: user.loc || '',
      },
    };
  } catch (error) {
    console.error('Authentication error:', error);
    return {
      success: false,
      message: `登入失敗: ${(error as Error).message}`,
    };
  }
};

/**
 * 獲取表單HTML內容（api/v2/forms/{id}/page；使用者由伺服器依 token 填入）
 * @param payload 表單請求資訊
 * @returns 表單HTML內容
 */
export const fetchFormHtml = async (payload: FormPayload): Promise<string> => {
  const query = new URLSearchParams({ chtno: payload.chtno });
  const response = await apiFetch(`/forms/${encodeURIComponent(payload.templateid)}/page?${query}`);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return await response.text();
};
