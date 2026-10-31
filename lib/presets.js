/**
 * 服务商预设。
 *
 * QQ 邮箱是主路径，也是唯一的默认值：不填任何主机配置时连的就是
 * smtp.qq.com:465（收信侧是 imap.qq.com:993），与加进预设表之前完全一致。
 *
 * 预设表只做一件事：当邮箱地址明确属于另一家提供商、而用户又没有显式
 * 指定主机时，把端点换成那家的默认值。认不出来的域名一律不猜，保持 QQ 默认。
 *
 * 只收录端点能交叉确认的几家；拿不准的服务商宁可不写，让人自己填。
 */

/** 一家提供商的端点与凭据说明。 */
export const PRESETS = Object.freeze({
  qq: {
    id: 'qq',
    label: 'QQ 邮箱',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    credential: '网页版「设置 → 账户」开启 IMAP/SMTP 服务，按提示短信验证后得到 16 位授权码（不是 QQ 密码）。',
  },
  exmail: {
    id: 'exmail',
    label: '腾讯企业邮',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    credential: '企业邮管理后台开启 IMAP/SMTP，密码处填登录密码或客户端专用密码。',
  },
  163: {
    id: '163',
    label: '网易 163',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    credential: '网页版「设置 → POP3/SMTP/IMAP」开启服务后得到授权码。',
  },
  126: {
    id: '126',
    label: '网易 126',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    credential: '网页版「设置 → POP3/SMTP/IMAP」开启服务后得到授权码。',
  },
  yeah: {
    id: 'yeah',
    label: '网易 yeah.net',
    imap: { host: 'imap.yeah.net', port: 993, secure: true },
    smtp: { host: 'smtp.yeah.net', port: 465, secure: true },
    credential: '网页版「设置 → POP3/SMTP/IMAP」开启服务后得到授权码。',
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    credential: '需先开两步验证，再创建 16 位「应用专用密码」；大陆网络通常需要代理才能连通。',
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    credential: 'SMTP 走 587 + STARTTLS；开了两步验证的账号要创建应用密码。',
  },
});

/** 地址 → 预设 id。认不出来就不返回，由调用方保持 QQ 默认。 */
const DOMAINS = Object.freeze([
  [/@(?:qq|foxmail|vip\.qq)\.com$/i, 'qq'],
  [/@exmail\.qq\.com$/i, 'exmail'],
  [/@163\.com$/i, '163'],
  [/@126\.com$/i, '126'],
  [/@yeah\.net$/i, 'yeah'],
  [/@gmail\.com$/i, 'gmail'],
  [/@(?:outlook|hotmail|live)\.(?:com|cn)$/i, 'outlook'],
]);

/**
 * 从地址推断服务商。
 * @param {string} address 邮箱地址
 * @returns {string|undefined} 预设 id；空地址按 QQ（主路径），认不出来返回 undefined
 */
export function providerIdFor(address) {
  const text = String(address ?? '').trim();
  if (!text) return 'qq';
  for (const [pattern, id] of DOMAINS) {
    if (pattern.test(text)) return id;
  }
  return undefined;
}

/**
 * 地址对应的预设；认不出来返回 undefined（不猜）。
 * @param {string} address 邮箱地址
 */
export function providerPreset(address) {
  const id = providerIdFor(address);
  return id === undefined ? undefined : PRESETS[id];
}
