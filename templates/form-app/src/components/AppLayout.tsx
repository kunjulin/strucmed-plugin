import { useEffect, useState, useCallback, useRef } from 'react';
import { UserInfo } from '../types';
import { detectDevice } from '../services/device';
import { exitApp, exitAppWithConfirmation } from '../services/exitHandler';
import FormList from './FormList';
import FormView from './FormView';
import NoteConfigList from './NoteConfigList';
import exitIcon from '../assets/exit.png';
import configIcon from '../assets/config.png';
import '../styles/AppLayout.css';
import appConfig from '../app-config';

interface AppLayoutProps {
  userInfo: UserInfo;
}

const AppLayout = ({ userInfo }: AppLayoutProps) => {
  const [chtno, setChtno] = useState<string>('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isTablet, setIsTablet] = useState<boolean>(false);
  const [formActive, setFormActive] = useState<boolean>(false);
  const [showNoteConfig, setShowNoteConfig] = useState<boolean>(false);
  const [idleTime, setIdleTime] = useState<number>(0);
  const [shouldExit, setShouldExit] = useState<boolean>(false);
  const isExitingRef = useRef<boolean>(false);
  const [windowWidth, setWindowWidth] = useState<number>(window.innerWidth);
  
  // 閒置時間（app.config.json 的 idleTimeoutMs，預設 30 分鐘）
  const IDLE_TIMEOUT = appConfig.idleTimeoutMs;

  // 處理應用程式離開/關閉
  const handleExit = useCallback(() => {
    exitAppWithConfirmation();
  }, []);

  // 直接離開應用程式，不確認
  const exitDirectly = useCallback(() => {
    // 防止重複觸發
    if (isExitingRef.current) return;
    
    isExitingRef.current = true;
    exitApp();
  }, []);

  // 重設閒置計時器
  const resetIdleTimer = useCallback(() => {
    setIdleTime(0);
  }, []);

  // 處理自動退出
  useEffect(() => {
    if (shouldExit && !isExitingRef.current) {
      // 顯示提示
      alert('由於長時間沒有操作，應用程式將自動關閉。');
      exitDirectly();
    }
  }, [shouldExit, exitDirectly]);

  // 閒置計時器
  useEffect(() => {
    // 每秒檢查閒置時間
    const idleInterval = setInterval(() => {
      setIdleTime(prevIdleTime => {
        // 如果閒置時間達到閾值，設置應該退出的標記
        if (prevIdleTime >= IDLE_TIMEOUT && !isExitingRef.current) {
          clearInterval(idleInterval);
          setShouldExit(true);
        }
        return prevIdleTime + 1000;
      });
    }, 1000);

    // 監聽用戶活動事件
    const userEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart'];
    
    userEvents.forEach(event => {
      window.addEventListener(event, resetIdleTimer);
    });

    return () => {
      clearInterval(idleInterval);
      userEvents.forEach(event => {
        window.removeEventListener(event, resetIdleTimer);
      });
    };
  }, [resetIdleTimer, IDLE_TIMEOUT]);

  useEffect(() => {
    // 檢測裝置類型
    const { isMobile: isMobileDevice, isTablet: isTabletDevice } = detectDevice();
    setIsMobile(isMobileDevice && !isTabletDevice); // 只有手機才是true，平板為false
    setIsTablet(isTabletDevice);
    setWindowWidth(window.innerWidth);

    // 監聽窗口大小變化
    const handleResize = () => {
      const { isMobile: newIsMobile, isTablet: newIsTablet } = detectDevice();
      setIsMobile(newIsMobile && !newIsTablet);
      setIsTablet(newIsTablet);
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const handleSelectForm = (templateId: string) => {
    setSelectedTemplateId(templateId);
    setFormActive(true);
  };

  const handleBack = () => {
    setSelectedTemplateId(null);
    setFormActive(false);
  };

  const handleOpenNoteConfig = () => {
    setShowNoteConfig(true);
  };

  const handleCloseNoteConfig = () => {
    setShowNoteConfig(false);
  };

  // 使用者自訂清單頁（allowUserList 時才有）
  if (showNoteConfig && appConfig.allowUserList) {
    return (
      <div className="app-layout">
        <NoteConfigList
          userInfo={userInfo}
          isTablet={isTablet}
          onClose={handleCloseNoteConfig}
        />
        <button className="exit-button" onClick={handleExit}>
          <img src={exitIcon} alt="退出" width="40" height="40" />
        </button>
      </div>
    );
  }

  // 在行動裝置上，表單列表和表單內容是分開顯示的
  if (isMobile) {
    return (
      <div className="app-layout mobile">
        {selectedTemplateId ? (
          <FormView
            templateId={selectedTemplateId}
            chtno={chtno}
            userInfo={userInfo}
            onBack={handleBack}
          />
        ) : (
          <>
            <div className="mobile-buttons">
              {appConfig.allowUserList && (
              <button
                className="config-button"
                onClick={handleOpenNoteConfig}
                aria-label="設定"
              >
                <img src={configIcon} alt="設定" width="40" height="40" />
              </button>
              )}
              <button className="exit-button" onClick={handleExit}>
                <img src={exitIcon} alt="退出" width="40" height="40" />
              </button>
            </div>
            <FormList
              userInfo={userInfo}
              onSelectForm={handleSelectForm}
              chtno={chtno}
              onChtnoChange={setChtno}
              isInactive={formActive && !isMobile}
            />
          </>
        )}
      </div>
    );
  }

  // 在平板和桌面上，使用左右分割的主/細節視圖
  const shouldHideSidebar = windowWidth < 768 && selectedTemplateId;

  return (
    <div className="app-layout tablet-desktop">
      {!shouldHideSidebar && (
        <div className={`sidebar ${formActive && !isMobile ? 'inactive' : ''}`}> 
          <FormList
            userInfo={userInfo}
            onSelectForm={handleSelectForm}
            chtno={chtno}
            onChtnoChange={setChtno}
            isInactive={formActive && !isMobile}
            onOpenConfig={appConfig.allowUserList ? handleOpenNoteConfig : undefined}
          />
        </div>
      )}
      <div className="main-content">
        {selectedTemplateId ? (
          <FormView
            templateId={selectedTemplateId}
            chtno={chtno}
            userInfo={userInfo}
            onBack={handleBack}
          />
        ) : (
          <div className="no-form-selected">
            <p>請從左側選擇一個表單</p>
          </div>
        )}
      </div>
      {!selectedTemplateId && (
        <button className="exit-button" onClick={handleExit}>
          <img src={exitIcon} alt="退出" />
        </button>
      )}
    </div>
  );
};

export default AppLayout; 