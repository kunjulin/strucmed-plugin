import { useEffect, useState } from 'react';
import { FormTemplate, UserInfo } from '../types';
import { getFormConfig, uploadNoteList } from '../api/client';
import deleteIcon from '../assets/delete.png';
import '../styles/NoteConfigList.css';

interface NoteConfigListProps {
  userInfo: UserInfo;
  isTablet: boolean;
  onClose: () => void;
}

const NoteConfigList = ({ userInfo, isTablet, onClose }: NoteConfigListProps) => {
  const [formTemplates, setFormTemplates] = useState<FormTemplate[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [newTemplate, setNewTemplate] = useState<{ id: string; name: string }>({ id: '', name: '' });
  const [isSaving, setIsSaving] = useState<boolean>(false);

  useEffect(() => {
    const fetchNoteList = async () => {
      try {
        setLoading(true);
        const formConfig = await getFormConfig(userInfo.userID);
        
        if (formConfig && formConfig.formlist) {
          setFormTemplates(formConfig.formlist);
        } else {
          setError('無法取得記事清單配置');
        }
      } catch (err) {
        console.error('Error fetching note list:', err);
        setError('獲取記事清單時發生錯誤');
      } finally {
        setLoading(false);
      }
    };

    fetchNoteList();
  }, [userInfo.userID]);

  // 過濾記事列表
  const filteredTemplates = searchTerm
    ? formTemplates.filter(template => 
        template.tempaltename.toLowerCase().includes(searchTerm.toLowerCase()) ||
        template.tempalteid.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : formTemplates;

  const handleAddTemplate = () => {
    if (!newTemplate.id.trim() || !newTemplate.name.trim()) {
      alert('請填寫完整的記事 ID 和名稱');
      return;
    }
    
    // 檢查 ID 是否已存在
    if (formTemplates.some(t => t.tempalteid === newTemplate.id)) {
      alert('記事 ID 已存在，請使用不同的 ID');
      return;
    }
    
    // 新增記事到列表
    const updatedTemplates = [
      ...formTemplates, 
      { tempalteid: newTemplate.id, tempaltename: newTemplate.name }
    ];
    
    setFormTemplates(updatedTemplates);
    setNewTemplate({ id: '', name: '' });
  };

  const handleRemoveTemplate = (templateId: string) => {
    // 增加確認對話框
    if (window.confirm('確定要刪除此記事項目嗎？')) {
      const updatedTemplates = formTemplates.filter(t => t.tempalteid !== templateId);
      setFormTemplates(updatedTemplates);
    }
  };

  const handleSaveConfig = async () => {
    try {
      setIsSaving(true);
      await uploadNoteList(userInfo.userID, formTemplates);
      alert('記事清單配置已保存');
      onClose();
    } catch (err) {
      console.error('Error saving note list:', err);
      alert('保存記事清單時發生錯誤');
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return <div className="loading">載入記事清單中...</div>;
  }

  if (error) {
    return <div className="error">{error}</div>;
  }

  return (
    <div className={`note-config-container ${isTablet ? 'tablet' : 'mobile'}`}>
      <div className="note-config-header">
        <div className="header-title">
          <h2>範本清單設定</h2>
          <div className="user-info">
            <span>{userInfo.name}</span>
            {/* <span className="user-location">{userInfo.loc}</span> */}
          </div>
        </div>
      </div>
      
      <div className="search-bar">
        <input
          type="text"
          placeholder="搜尋記事..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="add-template-form">
        <div className="add-template-inputs">
          <input
            type="text"
            placeholder="記事 ID"
            value={newTemplate.id}
            onChange={(e) => setNewTemplate({...newTemplate, id: e.target.value})}
          />
          <input
            type="text"
            placeholder="記事名稱"
            value={newTemplate.name}
            onChange={(e) => setNewTemplate({...newTemplate, name: e.target.value})}
          />
        </div>
        <button onClick={handleAddTemplate}>新增</button>
      </div>

      <div className="note-templates-list">
        {filteredTemplates.length > 0 ? (
          filteredTemplates.map((template) => (
            <div key={template.tempalteid} className="note-template-item">
              <div className="template-info">
                <div className="template-name">{template.tempaltename}</div>
                <div className="template-id">{template.tempalteid}</div>
              </div>
              <button 
                className="delete-button"
                onClick={() => handleRemoveTemplate(template.tempalteid)}
                aria-label="刪除"
              >
                <img src={deleteIcon} alt="刪除"  />
              </button>
            </div>
          ))
        ) : (
          <div className="no-templates">
            {searchTerm ? '沒有符合的記事' : '沒有可用記事，請新增記事'}
          </div>
        )}
      </div>
      
      <div className="note-config-footer">
        <button 
          className="save-button"
          onClick={handleSaveConfig}
          disabled={isSaving}
        >
          {isSaving ? '儲存中...' : '儲存清單'}
        </button>
        <button className="close-button" onClick={onClose}>取消</button>
      </div>
    </div>
  );
};

export default NoteConfigList; 