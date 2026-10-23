export interface LoginPayload {
  account: string;
  deptno: string;
  hospital: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  message: string;
  userInfo?: UserInfo;
}

export interface UserInfo {
  userID: string;
  deptNo: string;
  name: string;
  idno: string;
  loc: string;
}

export interface FormTemplate {
  tempalteid: string;
  tempaltename: string;
}

export interface FormConfig {
  user: string;
  formlist: FormTemplate[];
  msg?: string;
}

export interface FormPayload {
  templateid: string;
  chtno: string;
  user: string;
}

export interface DeviceInfo {
  isMobile: boolean;
  isTablet: boolean;
} 