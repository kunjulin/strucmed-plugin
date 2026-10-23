import { useState } from 'react';
import { authenticateUser } from '../services/api';
import { LoginPayload, UserInfo } from '../types';
import appConfig from '../app-config';
import '../styles/Login.css';

interface LoginProps {
  onLoginSuccess: (userInfo: UserInfo) => void;
}

const Login = ({ onLoginSuccess }: LoginProps) => {
  const [hospital, setHospital] = useState<string>('CGMH');
  const [account, setAccount] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // 組建登錄資料
    const loginData: LoginPayload = {
      account,
      deptno: 'APP', // 固定值（token 的科部；表單頁的科別由伺服器設定）
      hospital,
      password
    };

    try {
      const response = await authenticateUser(loginData);
      
      if (response.success && response.userInfo) {
        onLoginSuccess(response.userInfo);
      } else {
        setError(response.message || '登入失敗，請檢查您的帳號和密碼');
      }
    } catch (err) {
      setError('登入過程中發生錯誤，請稍後再試');
      console.error('Login error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-logo">
        <img src="./logo.png" alt={appConfig.appName} />
      </div>
      <div className="login-form-container">
        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="hospital">醫院:</label>
            <select 
              id="hospital" 
              name="hospital"
              value={hospital} 
              onChange={(e) => setHospital(e.target.value)}
              required
            >
              <option value="CGMH">CGMH</option>
              <option value="大里仁愛">大里仁愛</option>
              <option value="台中仁愛">台中仁愛</option>
              <option value="CGM">CGM</option>
            </select>
          </div>
          
          <div className="form-group">
            <label htmlFor="account">HIS帳號</label>
            <input 
              type="text" 
              id="account" 
              value={account} 
              onChange={(e) => setAccount(e.target.value)} 
              placeholder="請輸入HIS帳號"
              required
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="password">HIS密碼</label>
            <input 
              type="password" 
              id="password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              placeholder="請輸入HIS密碼"
              required
            />
          </div>
          
          {error && <div className="error-message">{error}</div>}
          
          <button type="submit" disabled={loading} className="login-button">
            {loading ? '登入中...' : '登入系統'}
          </button>
        </form>
        
        <div className="version-info">
          <p>{appConfig.appName} {appConfig.version}</p>
          <p>StrucMed 表單 APP（strucmed plugin 產生）</p>
        </div>
      </div>
    </div>
  );
};

export default Login; 