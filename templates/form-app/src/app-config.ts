/**
 * app 設定（由 strucmed plugin 的 scaffold-form-app.mjs 產生 app.config.json）。
 * 這個檔案只讀設定、補預設值；不放任何 token、密碼或病人資料。
 */
import raw from '../app.config.json';

export interface FixedTemplate { id: string; name: string }
export interface AppConfig {
  appName: string;
  shortName: string;
  version: string;
  hosting: 'H0' | 'H2';
  siteBase: string;
  templates: FixedTemplate[];
  allowUserList: boolean;
  errorlog: { enabled: boolean; base: string };
  idleTimeoutMs: number;
}

const cfg = raw as Partial<AppConfig>;

const appConfig: AppConfig = {
  appName: cfg.appName || '表單 APP',
  shortName: cfg.shortName || cfg.appName || '表單',
  version: cfg.version || '0.0.0',
  hosting: cfg.hosting === 'H2' ? 'H2' : 'H0',
  siteBase: typeof cfg.siteBase === 'string' ? cfg.siteBase.replace(/\/+$/, '') : '/strucmed',
  templates: Array.isArray(cfg.templates) ? cfg.templates.filter(t => t && typeof t.id === 'string' && t.id).map(t => ({ id: t.id, name: String(t.name || t.id) })) : [],
  allowUserList: cfg.allowUserList !== false,
  errorlog: { enabled: !!(cfg.errorlog && cfg.errorlog.enabled), base: (cfg.errorlog && typeof cfg.errorlog.base === 'string' ? cfg.errorlog.base : '/FM').replace(/\/+$/, '') },
  idleTimeoutMs: Number.isFinite(cfg.idleTimeoutMs) && (cfg.idleTimeoutMs as number) > 0 ? (cfg.idleTimeoutMs as number) : 1_800_000,
};

export default appConfig;
