import { useState, useEffect } from 'react'
import Login from './components/Login'
import AppLayout from './components/AppLayout'
import { UserInfo } from './types'
import { isLocalStorageAvailable } from './services/storage'
import { exitApp } from './services/exitHandler'
import './App.css'

function App() {
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
  const [storageAvailable, setStorageAvailable] = useState<boolean>(true)

  // 啟動時檢查 sessionStorage 是否可用（token 只存在本分頁）
  useEffect(() => {
    // 使用直接導入的函數
    const isAvailable = isLocalStorageAvailable();
    setStorageAvailable(isAvailable);
    
    if (!isAvailable) {
      console.warn('本地存儲不可用，這可能會導致應用功能受限');
    }
  }, []);

  const handleLoginSuccess = (info: UserInfo) => {
    setUserInfo(info)
  }

  if (!storageAvailable) {
    return (
      <div className="app">
        <div className="storage-error">
          <h2>瀏覽器的工作階段儲存不可用</h2>
          <p>您的瀏覽器可能：</p>
          <ul>
            <li>禁用了本地存儲功能</li>
            <li>處於隱私模式</li>
            <li>存儲空間已滿</li>
          </ul>
          <p>請嘗試：</p>
          <ul>
            <li>退出隱私/無痕模式</li>
            <li>在瀏覽器設置中啟用 Cookies 和本地存儲</li>
            <li>清理瀏覽器存儲空間</li>
            <li>使用不同的瀏覽器</li>
          </ul>
          <button onClick={() => exitApp(true)}>返回登入頁面</button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {userInfo ? (
        <AppLayout userInfo={userInfo} />
      ) : (
        <Login onLoginSuccess={handleLoginSuccess} />
      )}
    </div>
  )
}

export default App
