/**
 * 最小可用的 IMAP 客户端，只为「收回复邮件」这一件事服务。
 *
 * 只实现用得上的子集：
 *   CAPABILITY → LOGIN → SELECT INBOX → UID SEARCH UNSEEN → UID FETCH (BODY.PEEK[])
 *
 * 几个刻意的选择：
 *   · 全程 BODY.PEEK[]，绝不 BODY[]——后者会把邮件标成已读，用户回头在客户端里就看不到了。
 *   · 只按 UID 增量取，记 watermark，避免每次把整箱未读重下一遍。
 *   · 遇到不认识的响应一律收集到 untagged 缓冲，不抛错——IMAP 服务器爱加私有扩展。
 *   · 支持 QQ 邮箱必需的 ID 命令（不先发 ID 会直接 * BYE）。
 */
import net from 'node:net';
import tls from 'node:tls';

const MAX_LINE = 64 * 1024;
const MAX_BODY = 2 * 1024 * 1024;

export class ImapError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ImapError';
    this.detail = detail;
  }
}

/** 把一行拆成 [tag, status, rest]，够用即可。 */
function parseStatusLine(line) {
  const m = /^(\S+)\s+(OK|NO|BAD)\s*(.*)$/iu.exec(line);
  if (!m) return null;
  return { tag: m[1], status: m[2].toUpperCase(), rest: m[3] };
}

/** 抓取 "(UID 123 BODY[] {456}" 这类响应里的数值。 */
function readUid(line) {
  const m = /\bUID\s+(\d+)/iu.exec(line);
  return m ? Number(m[1]) : undefined;
}

function readLiteralLength(line) {
  const m = /\{(\d+)\}\s*$/u.exec(line);
  return m ? Number(m[1]) : undefined;
}

/**
 * 构造「有没有比水位更新的未读」这条 SEARCH。
 *
 * 单独抽出来是为了能单测——拼错一个字符，收信就会静默失效，而那种故障
 * 不会报错，只会表现为「回复了邮件但 agent 没反应」。
 *
 * @param sinceUid 已处理到的 UID 水位；不传则列出全部未读
 */
export function unseenQuery(sinceUid) {
  const from = Number(sinceUid);
  return Number.isFinite(from) && from > 0 ? `UID SEARCH UNSEEN UID ${from + 1}:*` : 'UID SEARCH UNSEEN';
}

export class ImapClient {
  constructor(options) {
    this.host = options.host || 'imap.qq.com';
    this.port = Number(options.port || 993);
    this.secure = options.secure !== false;
    this.user = options.user;
    this.pass = options.pass;
    this.timeoutMs = Number(options.timeoutMs || 25_000);
    this.trace = options.trace;

    this.socket = null;
    this.buffer = '';
    this.tagSeq = 0;
    this.pending = new Map();
    this.literals = [];
    this.inbox = [];
    /** 等待特定响应行的挂起器（IDLE 用）：{ re, resolve, reject, timer } */
    this.waiters = [];
  }

  log(message) {
    if (typeof this.trace === 'function') this.trace(message);
  }

  /** 建立连接 + 读 greeting。 */
  async connect() {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(new ImapError(`IMAP 连接失败: ${error.message}`));
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host }, () => resolve())
        : net.connect({ host: this.host, port: this.port }, () => resolve());
      socket.setNoDelay(true);
      socket.setTimeout(this.timeoutMs, () => {
        socket.destroy();
        reject(new ImapError('IMAP 连接超时'));
      });
      socket.once('error', onError);
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('close', () => {
        for (const [, entry] of this.pending) entry.reject(new ImapError('IMAP 连接关闭'));
        this.pending.clear();
      });
      this.socket = socket;
    });
    await this.waitGreeting();
  }

  /** 服务端先发 `* OK ...` 才算握手完成。注意这行已被 drain() 推进 inbox，不在 buffer 里。 */
  waitGreeting() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const okAt = this.inbox.findIndex((line) => /^\*\s+(OK|PREAUTH)/iu.test(line));
        if (okAt !== -1) {
          const line = this.inbox[okAt];
          this.inbox.splice(0, okAt + 1);
          this.log(`< ${line}  (greeting)`);
          return resolve();
        }
        const byeAt = this.inbox.findIndex((line) => /^\*\s+BYE/iu.test(line));
        if (byeAt !== -1) return reject(new ImapError(`IMAP 服务端拒绝连接: ${this.inbox[byeAt]}`));
        if (Date.now() - started > this.timeoutMs) return reject(new ImapError('IMAP 握手超时'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString('binary');
    this.drain();
  }

  /** 按行切缓冲；带 `{n}` 字面量的行后面紧跟 n 字节原文。 */
  drain() {
    for (;;) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) return;
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const line = Buffer.from(raw, 'binary').toString('utf8');

      const literalLength = readLiteralLength(line);
      if (literalLength !== undefined) {
        // 字面量正文紧跟在这一行之后；后面通常还有 `)` 和 CRLF，所以只切正文长度，
        // 多切一个字节就会把结构行吃掉，导致后续 tagged 响应解析失败。
        if (this.buffer.length < literalLength) {
          // 数据还没到齐：整行放回缓冲头部，等下一批数据继续
          this.buffer = Buffer.from(raw, 'binary').toString('binary') + '\r\n' + this.buffer;
          return;
        }
        const body = Buffer.from(this.buffer.slice(0, literalLength), 'binary').toString('utf8');
        this.buffer = this.buffer.slice(literalLength);
        this.literals.push(body);
        this.log(`< [literal ${literalLength} bytes]`);
        continue;
      }

      this.log(`< ${line}`);
      const status = parseStatusLine(line);
      if (status) {
        const entry = this.pending.get(status.tag);
        if (entry) {
          this.pending.delete(status.tag);
          if (status.status === 'OK') entry.resolve({ rest: status.rest, literals: this.literals.splice(0) });
          else entry.reject(new ImapError(`IMAP ${status.tag} ${status.status}: ${status.rest}`, line));
          continue;
        }
      }
      // 先给挂起的等待器一个机会（IDLE 的 EXISTS 推送就走这里）
      if (this.waiters.length > 0) {
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          const waiter = this.waiters[i];
          if (!waiter.re.test(line)) continue;
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(line);
        }
      }
      this.inbox.push(line);
    }
  }

  /** 等一行匹配 re 的响应；超时返回 undefined。 */
  waitForPattern(re, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (at !== -1) this.waiters.splice(at, 1);
        resolve(undefined);
      }, timeoutMs);
      const wrapped = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push({ re, resolve: wrapped, timer });
    });
  }

  /** 发一条命令并等它的 tagged 响应。 */
  async command(text, options = {}) {
    if (!this.socket || this.socket.destroyed) throw new ImapError('IMAP 连接已关闭');
    this.tagSeq += 1;
    const tag = `A${String(this.tagSeq).padStart(4, '0')}`;
    const line = `${tag} ${text}\r\n`;
    this.log(`> ${text}`);
    this.inbox.length = 0;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(tag, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(tag)) reject(new ImapError(`IMAP 命令超时: ${text}`));
      }, options.timeoutMs || this.timeoutMs);
      const wrap = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(tag, { resolve: wrap(resolve), reject: wrap(reject) });
    });
    this.socket.write(line, 'binary');
    return promise;
  }

  async login() {
    await this.command('CAPABILITY').catch(() => undefined);
    // QQ 邮箱必须先自报家门
    await this.command(`ID ("name" "dsh-qq-mail-notify" "version" "1.0.0")`).catch(() => undefined);
    await this.command(`LOGIN ${quoteAtom(this.user)} ${quoteAtom(this.pass)}`);
  }

  async selectInbox() {
    const result = await this.command('SELECT INBOX');
    return result;
  }

  /**
   * 列出未读邮件的 UID（升序）。
   *
   * 传入 sinceUid 时只问服务器要它之后的那部分：收件箱里常年躺着几百封未读推广信，
   * 每 5 秒把整张清单拉下来再本地过滤，等于反复传同一批没用的东西。
   * 注意 IMAP 的 `n:*` 在 n 超过最大 UID 时会返回最后一封，所以调用方仍要再过滤一次。
   */
  async searchUnseen(sinceUid) {
    const result = await this.command(unseenQuery(sinceUid));
    const line = this.inbox.find((l) => /^\*\s+SEARCH/iu.test(l));
    if (!line) return [];
    const nums = line.replace(/^\*\s+SEARCH\s*/iu, '').trim();
    if (!nums) return [];
    return nums.split(/\s+/u).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  }

  /** 取一封邮件的原始内容（不标已读）。 */
  async fetchRaw(uid) {
    const result = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`, { timeoutMs: this.timeoutMs * 2 });
    const body = result.literals.find((l) => l.length > 0);
    if (body === undefined) return undefined;
    if (body.length > MAX_BODY) return body.slice(0, MAX_BODY);
    return body;
  }

  /**
   * 进入 IDLE 态等服务器推送新邮件。
   * 返回 true 表示有新邮件到达（收到 EXISTS），false 表示只是超时。
   * 无论哪种都会正常发 DONE 退出 IDLE，连接可以继续复用。
   */
  async idle(waitMs = 25_000) {
    if (!this.socket || this.socket.destroyed) throw new ImapError('IMAP 连接已关闭');
    this.tagSeq += 1;
    const tag = `A${String(this.tagSeq).padStart(4, '0')}`;
    this.log(`> IDLE (等待最多 ${Math.round(waitMs / 1000)}s)`);
    const continuation = this.waitForPattern(/^\+ /u, 5000);
    this.socket.write(`${tag} IDLE\r\n`, 'binary');
    const started = await continuation;
    if (started === undefined) throw new ImapError('IMAP 未进入 IDLE 态');
    const push = await this.waitForPattern(/^\*\s+\d+\s+EXISTS/iu, waitMs);
    // 退出 IDLE
    const done = new Promise((resolve, reject) => {
      this.pending.set(tag, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pending.delete(tag)) reject(new ImapError('IMAP IDLE 退出超时'));
      }, 10_000);
      const wrap = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(tag, { resolve: wrap(resolve), reject: wrap(reject) });
    });
    this.socket.write('DONE\r\n', 'binary');
    await done.catch(() => undefined);
    this.log(push === undefined ? '< IDLE 超时（无新邮件）' : `< IDLE 收到推送: ${push}`);
    return push !== undefined;
  }

  close() {
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

/** IMAP 的 atom 参数：含特殊字符时用双引号包起来。 */
function quoteAtom(value) {
  const text = String(value ?? '');
  if (/^[^\s"\\]+$/u.test(text)) return text;
  return `"${text.replace(/(["\\])/gu, '\\$1')}"`;
}

/**
 * 极简 MIME 解析：只取主题、发件人、纯文本正文。
 * 够处理「用户回一句继续」这种场景；复杂邮件（多重附件、嵌套 multipart）只取第一段文本。
 */
export function parseMail(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { subject: '', from: '', text: '' };
  const split = raw.indexOf('\r\n\r\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  let body = split === -1 ? '' : raw.slice(split + 4);

  const headers = new Map();
  for (const line of head.split(/\r\n(?![ \t])/u)) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).replace(/\r\n[ \t]+/gu, ' ').trim();
    if (!headers.has(name)) headers.set(name, value);
  }

  const subject = decodeHeader(headers.get('subject') || '');
  const from = decodeHeader(headers.get('from') || '');
  const contentType = headers.get('content-type') || 'text/plain';
  const transfer = (headers.get('content-transfer-encoding') || '').toLowerCase();

  let isHtml = /text\/html/iu.test(contentType);
  if (/multipart\//iu.test(contentType)) {
    const boundaryMatch = /boundary="?([^";]+)"?/iu.exec(contentType);
    if (boundaryMatch) {
      const parts = body.split(`--${boundaryMatch[1]}`);
      let plain;
      let html;
      for (const part of parts) {
        const sep = part.indexOf('\r\n\r\n');
        if (sep === -1) continue;
        const partHead = part.slice(0, sep).toLowerCase();
        const partBody = part.slice(sep + 4);
        if (partHead.includes('text/plain') && plain === undefined) plain = { body: partBody, transfer: readTransfer(partHead) };
        else if (partHead.includes('text/html') && html === undefined) html = { body: partBody, transfer: readTransfer(partHead) };
      }
      const chosen = plain ?? html;
      if (chosen) {
        body = chosen.body;
        isHtml = plain === undefined;
        if (chosen.transfer) return finish(decodeBody(body, chosen.transfer, isHtml), subject, from, isHtml);
      }
    }
  }

  return finish(decodeBody(body, transfer, isHtml), subject, from, isHtml);
}

function readTransfer(partHead) {
  const m = /content-transfer-encoding:\s*([a-z0-9-]+)/iu.exec(partHead);
  return m ? m[1].toLowerCase() : '';
}

function finish(text, subject, from, isHtml) {
  const value = isHtml ? htmlToText(text) : text.trim();
  return { subject, from, text: value };
}

function decodeBody(body, transfer, isHtml) {
  if (transfer === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (transfer === 'quoted-printable') return decodeQuotedPrintable(body);
  return isHtml ? body : body.trim();
}

/** HTML 转纯文本：只保留可读内容，够判断"用户回了什么"。 */
export function htmlToText(html) {
  return decodeEntities(stripTags(String(html ?? '')))
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * 剥掉 HTML 标签。用一次线性扫描，而不是一串 replace。
 *
 * 为什么不用正则：`replace(/<script[\s\S]*?<\/script>/gi, '')` 这种单次替换对付不了
 * 嵌套和变形——删掉内层之后可能正好拼出新的 `<script>`，而 replace 不会回头再扫一遍
 * （CodeQL 的 js/incomplete-multi-character-sanitization 说的就是这个）。这里的输入
 * 来自邮件正文，完全由发件人控制，所以按标签名扫：script/style/注释整段消费（未闭合
 * 就丢到结尾），其余标签一律丢弃、只留文本；找不到闭合 `>` 的 `<` 当普通字符，避免把
 * 「1 < 2」这种正文吃掉。
 */
function stripTags(src) {
  const out = [];
  const lower = src.toLowerCase();
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      out.push(src.slice(i));
      break;
    }
    out.push(src.slice(i, lt));

    // 注释：整段丢到 -->
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }

    const m = /^<\s*(\/?)\s*([a-z][a-z0-9]*)/u.exec(lower.slice(lt, lt + 48));

    // script / style：连同结束标签一起丢，中间内容不看
    if (m && m[1] === '' && (m[2] === 'script' || m[2] === 'style')) {
      const close = lower.indexOf(`</${m[2]}`, lt);
      if (close < 0) {
        i = src.length;
        break;
      }
      const afterTag = src.indexOf('>', close);
      i = afterTag < 0 ? src.length : afterTag + 1;
      continue;
    }

    const gt = src.indexOf('>', lt);
    if (gt < 0) {
      // 没有闭合的 '>'：当普通文本保留（正文里的「1 < 2」不该被吃掉）
      out.push(src.slice(lt));
      break;
    }
    if (m && /^(?:br|p|div|tr|li|h[1-6])$/u.test(m[2])) out.push('\n');
    i = gt + 1;
  }
  return out.join('');
}

/** 解码常见 HTML 实体；&amp; 放最后，避免 &amp;lt; 被二次解开。 */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/giu, '&');
}

function decodeQuotedPrintable(value) {
  return value
    .replace(/=\r\n/gu, '')
    .replace(/=([0-9A-F]{2})/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 解 MIME 编码字（=?UTF-8?B?...?=）与非 ASCII 原文。 */
function decodeHeader(value) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/gu, (_, charset, enc, payload) => {
    try {
      const buffer =
        enc.toUpperCase() === 'B'
          ? Buffer.from(payload, 'base64')
          : Buffer.from(payload.replace(/_/gu, ' ').replace(/=([0-9A-F]{2})/giu, (__, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      return buffer.toString(/utf-?8/iu.test(charset) ? 'utf8' : 'latin1');
    } catch {
      return payload;
    }
  });
}

/**
 * 轮询收件箱，把新未读交给 onMail。
 * watermark 记录已处理的最大 UID，避免重复触发。
 */
export async function pollInbox(options) {
  const { settings, watermark = 0, onMail, trace } = options;
  if (!settings.user || !settings.authCode) return { watermark, handled: 0, skipped: 'missing-credentials' };

  const client = new ImapClient({
    host: settings.imapHost || 'imap.qq.com',
    port: settings.imapPort || 993,
    user: settings.user,
    pass: settings.authCode,
    trace,
  });

  let handled = 0;
  let nextWatermark = watermark;
  try {
    await client.connect();
    await client.login();
    await client.selectInbox();
    const uids = await client.searchUnseen();
    for (const uid of uids) {
      if (uid <= watermark) continue;
      const raw = await client.fetchRaw(uid);
      nextWatermark = Math.max(nextWatermark, uid);
      if (raw === undefined) continue;
      const mail = parseMail(raw);
      if (mail.text === '' && mail.subject === '') continue;
      handled += 1;
      await onMail({ uid, ...mail });
    }
  } finally {
    client.close();
  }
  return { watermark: nextWatermark, handled };
}
