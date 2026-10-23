/**
 * 提供應用程式退出相關功能
 */

import { NOTE_HOME } from './base';

/**
 * 檢測當前是否為 PWA 環境
 */
export const isPwaMode = (): boolean => {
  return window.matchMedia('(display-mode: standalone)').matches || 
         (window.navigator as any).standalone === true;
};

/**
 * 安全地關閉應用程式或跳轉到登入頁
 * 在 PWA 模式下，直接跳轉到登入頁
 * 在普通瀏覽器模式下，先嘗試關閉窗口，失敗則跳轉
 */
export const exitApp = (redirect = true): void => {
  // 標記是否已開始退出
  let exitStarted = false;

  // 跳轉到登入頁的函數
  const redirectToLogin = () => {
    if (exitStarted) return;
    exitStarted = true;
    window.location.href = NOTE_HOME;
  };

  try {
    // 如果在 PWA 模式下，直接跳轉
    if (isPwaMode() || !redirect) {
      redirectToLogin();
      return;
    }

    // 嘗試關閉窗口
    window.close();
    
    // 計時器確保即使 window.close() 沒有效果也能跳轉
    setTimeout(() => {
      // 如果窗口還在，重定向到登入頁
      redirectToLogin();
    }, 300);
  } catch (err) {
    console.error('退出應用時發生錯誤:', err);
    // 出錯時也跳轉到登入頁
    redirectToLogin();
  }
};

/**
 * 帶確認對話框的應用程式退出函數
 */
export const exitAppWithConfirmation = (): void => {
  if (window.confirm('確定要離開應用程式嗎？')) {
    exitApp();
  }
}; 