/**
 * 錯誤回報到 FMapi（POST {base}/api/errorlog，本文 ErrorMessage／ErrorStack／Configuration）。
 * 只送錯誤訊息、堆疊與「app 名稱／範本 ID」；不送 token、帳號、病歷號或表單內容。失敗時靜默。
 */
import appConfig from '../app-config';

const SENSITIVE = /(Bearer\s+\S+|accessToken|refreshToken|password|[A-Z][12]\d{8})/g;

export const reportError = async (message: string, context: { templateId?: string; where?: string }, err?: unknown): Promise<void> => {
  if (!appConfig.errorlog.enabled) return;
  try {
    const stack = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack || ''}` : String(err ?? '');
    const body = {
      ErrorMessage: `${appConfig.appName}: ${message}`.replace(SENSITIVE, '[redacted]').slice(0, 1000),
      ErrorStack: stack.replace(SENSITIVE, '[redacted]').slice(0, 4000),
      Configuration: JSON.stringify({ app: appConfig.appName, version: appConfig.version, where: context.where || '', templateId: context.templateId || '', ua: navigator.userAgent }),
    };
    await fetch(`${appConfig.errorlog.base}/api/errorlog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
  } catch {
    /* 錯誤回報本身失敗不影響使用者 */
  }
};
