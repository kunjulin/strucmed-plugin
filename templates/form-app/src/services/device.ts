import { DeviceInfo } from '../types';

/**
 * 偵測裝置類型
 * @returns 裝置資訊
 */
export const detectDevice = (): DeviceInfo => {
  // 確保在瀏覽器環境中執行
  if (typeof window === 'undefined') {
    return { isMobile: false, isTablet: false };
  }

  const userAgent = window.navigator.userAgent;
  
  // 檢測是否為行動裝置
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
  
  // 檢測是否為平板（iPad或Android平板）
  const isTabletDevice = 
    /iPad/i.test(userAgent) || 
    (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) ||
    (window.innerWidth >= 768 && window.innerWidth <= 1024);

  return {
    isMobile: isMobileDevice && !isTabletDevice,
    isTablet: isTabletDevice
  };
};

/**
 * 創建響應式媒體查詢鉤子
 * @param query 媒體查詢字符串
 * @returns 是否匹配查詢
 */
export const useMediaQuery = (query: string): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
    return false;
  }
  
  return window.matchMedia(query).matches;
}; 