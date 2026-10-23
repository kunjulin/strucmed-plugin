import { useEffect, useState } from 'react';
import { FormTemplate, UserInfo } from '../types';
import { getFormConfig } from '../api/client';
import configIcon from '../assets/config.png';
import '../styles/FormList.css';
import BarcodeScanner from './BarcodeScanner';
import appConfig from '../app-config';
import { reportError } from '../services/errorlog';

interface FormListProps {
  userInfo: UserInfo;
  onSelectForm: (templateId: string) => void;
  chtno: string;
  onChtnoChange: (chtno: string) => void;
  isInactive?: boolean;
  onOpenConfig?: () => void;
}

const FormList = ({ userInfo, onSelectForm, chtno, onChtnoChange, isInactive = false, onOpenConfig }: FormListProps) => {
  const [formTemplates, setFormTemplates] = useState<FormTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [showScanner, setShowScanner] = useState<boolean>(false);

  useEffect(() => {
    const fetchFormTemplates = async () => {
      // app.config.json 的固定範本永遠在最前面；使用者自己的清單（me/notes）接在後面（allowUserList 時）
      const fixed: FormTemplate[] = appConfig.templates.map(t => ({ tempalteid: t.id, tempaltename: t.name }));
      try {
        setLoading(true);
        let user: FormTemplate[] = [];
        if (appConfig.allowUserList) {
          const formConfig = await getFormConfig(userInfo.userID);
          if (formConfig && formConfig.formlist && formConfig.msg === 'success') user = formConfig.formlist;
          else if (formConfig && formConfig.msg === 'failure') void reportError('讀取使用者表單清單失敗', { where: 'FormList.fetch' });
        }
        const seen = new Set(fixed.map(t => t.tempalteid));
        setFormTemplates([...fixed, ...user.filter(t => !seen.has(t.tempalteid))]);
        setError(null);
      } catch (err) {
        console.error('Error fetching form templates:', err);
        void reportError('讀取表單清單失敗', { where: 'FormList.fetch' }, err);
        setFormTemplates(fixed);
        setError(null);
      } finally {
        setLoading(false);
      }
    };

    fetchFormTemplates();
  }, [userInfo.userID]);

  // 過濾表單
  const filteredTemplates = searchTerm
    ? formTemplates.filter(template => 
        template.tempaltename.toLowerCase().includes(searchTerm.toLowerCase()))
    : formTemplates;

  const handleFormSelect = (templateId: string) => {
    if (!chtno.trim()) {
      alert('請先輸入病歷號');
      return;
    }
    onSelectForm(templateId);
  };

  const handleScan = (scannedText: string) => {
    onChtnoChange(scannedText);
    setShowScanner(false);
    // 掃描成功時震動提示
    if (navigator.vibrate) {
      navigator.vibrate(200);
    }
  };

  if (loading) {
    return <div className="loading">載入表單列表中...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  return (
    <div className={`form-list-container ${isInactive ? 'inactive' : ''}`}>
      <div className="form-list-header">
        <div className="user-info">
          <span>{userInfo.name}</span>
          {onOpenConfig && appConfig.allowUserList && (
            <button 
              className="config-button-header" 
              onClick={onOpenConfig}
              aria-label="配置記事清單"
            >
              <img src={configIcon} alt="設定" width="40" height="40" />
            </button>
          )}
          {/* {!onOpenConfig && (
            <span className="user-location">{userInfo.loc}</span>
          )} */}
        </div>
        <div className="chtno-input">
          <label htmlFor="chtno">病歷號</label>
          <div className="chtno-input-container">
            <input
              type="text"
              id="chtno"
              value={chtno}
              onChange={(e) => onChtnoChange(e.target.value)}
              placeholder="請輸入病歷號"
              inputMode="numeric"
              autoComplete="off"
            />
            <button 
              className="barcode-scan-button" 
              onClick={() => setShowScanner(true)}
              aria-label="掃描病歷號條碼"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 1a.5.5 0 0 0-.5.5v3a.5.5 0 0 1-1 0v-3A1.5 1.5 0 0 1 1.5 0h3a.5.5 0 0 1 0 1h-3zM11 .5a.5.5 0 0 1 .5-.5h3A1.5 1.5 0 0 1 16 1.5v3a.5.5 0 0 1-1 0v-3a.5.5 0 0 0-.5-.5h-3a.5.5 0 0 1-.5-.5zM.5 11a.5.5 0 0 1 .5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 1 0 1h-3A1.5 1.5 0 0 1 0 14.5v-3a.5.5 0 0 1 .5-.5zm15 0a.5.5 0 0 1 .5.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a.5.5 0 0 1 0-1h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 1 .5-.5zM3 4.5a.5.5 0 0 1 1 0v7a.5.5 0 0 1-1 0v-7zm2 0a.5.5 0 0 1 1 0v7a.5.5 0 0 1-1 0v-7zm2 0a.5.5 0 0 1 1 0v7a.5.5 0 0 1-1 0v-7zm2 0a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5v-7zm3 0a.5.5 0 0 1 1 0v7a.5.5 0 0 1-1 0v-7z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
      
      <div className="search-bar">
        <input
          type="text"
          placeholder="搜尋表單..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="form-templates-list">
        {filteredTemplates.length > 0 ? (
          filteredTemplates.map((template) => (
            <div
              key={template.tempalteid}
              className="form-template-item"
              onClick={() => handleFormSelect(template.tempalteid)}
            >
              <div className="template-name">{template.tempaltename}</div>
              <div className="template-id">{template.tempalteid}</div>
            </div>
          ))
        ) : (
          <div className="no-templates">
            {searchTerm ? '沒有符合的表單' : '沒有可用表單'}
          </div>
        )}
      </div>

      {showScanner && (
        <div className="barcode-scanner-overlay">
          <div className="barcode-scanner-container">
            <BarcodeScanner 
              onScan={handleScan} 
              onClose={() => setShowScanner(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default FormList; 