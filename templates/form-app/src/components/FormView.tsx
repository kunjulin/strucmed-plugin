import { useEffect, useRef, useState } from 'react';
import { FormPayload, UserInfo } from '../types';
import { fetchFormHtml } from '../services/api';
import { reportError } from '../services/errorlog';
import '../styles/FormView.css';

interface FormViewProps {
  templateId: string;
  chtno: string;
  userInfo: UserInfo;
  onBack: () => void;
}

/**
 * 表單頁：以 iframe（srcDoc，同源）載入 api/v2/forms/{id}/page 回傳的 TempHtml。
 * 「提交」直接呼叫同源 iframe 的 SaveDoc()。
 */
const FormView = ({ templateId, chtno, userInfo, onBack }: FormViewProps) => {
  const [formHtml, setFormHtml] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const fetchForm = async () => {
      if (!templateId || !chtno || !userInfo.userID) {
        setError('缺少必要資訊');
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const payload: FormPayload = { templateid: templateId, chtno, user: userInfo.userID };
        setFormHtml(await fetchFormHtml(payload));
      } catch (err) {
        console.error('Error fetching form:', err);
        setError(`獲取表單失敗: ${(err as Error).message}`);
        void reportError('載入表單失敗', { templateId, where: 'FormView.fetchForm' }, err);
      } finally {
        setLoading(false);
      }
    };
    fetchForm();
  }, [templateId, chtno, userInfo.userID]);

  const handleSubmit = () => {
    const win = iframeRef.current?.contentWindow as (Window & { SaveDoc?: () => void; savedoc?: () => void }) | null | undefined;
    if (!win) {
      alert('無法訪問表單內容');
      return;
    }
    try {
      if (typeof win.SaveDoc === 'function') win.SaveDoc();
      else if (typeof win.savedoc === 'function') win.savedoc();
      else {
        console.warn('SaveDoc 函數未找到');
        alert('表單尚未載入完成，請稍後再試');
      }
    } catch (err) {
      console.error('呼叫 SaveDoc 時發生錯誤:', err);
      void reportError('提交表單失敗', { templateId, where: 'FormView.handleSubmit' }, err);
      alert('提交表單時發生錯誤');
    }
  };

  return (
    <div className="form-view-container">
      <div className="form-view-header">
        <button className="back-button" onClick={onBack}>返回</button>
        <div className="form-info">
          <div>病歷號: {chtno}</div>
          <div className="template-id">表單ID: {templateId}</div>
        </div>
        <button className="submit-button" onClick={handleSubmit}>提交表單</button>
      </div>

      <div className="form-content">
        {loading ? (
          <div className="loading">載入表單中...</div>
        ) : error ? (
          <div className="error">{error}</div>
        ) : (
          <iframe
            ref={iframeRef}
            title="Form Content"
            className="form-iframe"
            srcDoc={formHtml}
            sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups"
            style={{ padding: 0, margin: 0, border: 'none', width: '100%', height: '100%', overflow: 'auto', position: 'relative' }}
          />
        )}
      </div>
    </div>
  );
};

export default FormView;
