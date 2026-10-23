import { FormConfig, FormTemplate } from '../types';
import { apiFetch } from '../services/api';

// 表單清單（api/v2/me/notes）：擁有者由伺服器依 token 決定

/**
 * 上傳noteList到API（整份取代）
 * @param _userId 用戶ID（保留參數；伺服器以 token 的使用者為準）
 * @param templates 表單模板列表
 * @returns 清單的 fillID
 */
export const uploadNoteList = async (_userId: string, templates: FormTemplate[]): Promise<string> => {
  const response = await apiFetch('/me/notes', {
    method: 'PUT',
    body: JSON.stringify({
      items: templates.map(template => ({ dictID: template.tempalteid, dictVal: template.tempaltename })),
    }),
  });
  if (!response.ok) {
    throw new Error(`上傳失敗: ${response.status}`);
  }
  const result = await response.json();
  return result.fillID || '';
};

/**
 * 從API查詢用戶的noteList
 * @param userId 用戶ID
 * @returns 表單配置資訊
 */
export const getFormConfig = async (userId: string): Promise<FormConfig | null> => {
  try {
    const response = await apiFetch('/me/notes');
    if (!response.ok) {
      throw new Error(`查詢失敗: ${response.status}`);
    }

    const result = await response.json();
    const formList: FormTemplate[] = (result.items || []).map((item: { dictID: string; dictVal: string }) => ({
      tempalteid: item.dictID,
      tempaltename: item.dictVal
    }));

    // 依照tempaltename字母順序排序
    formList.sort((a, b) => a.tempaltename.localeCompare(b.tempaltename));

    return {
      user: userId,
      formlist: formList,
      msg: formList.length > 0 ? "success" : "empty"
    };
  } catch (error) {
    console.error('獲取表單配置失敗:', error);
    // 如果API請求失敗，返回空列表而不是null，避免應用程式出錯
    return {
      user: userId,
      formlist: [],
      msg: "failure"
    };
  }
};
