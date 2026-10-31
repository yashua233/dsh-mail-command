/**
 * 收件侧的调度：轮询 IMAP、过滤、验证口令、把「继续」请求交给上层。
 *
 * 三条过滤同时成立才算数：
 *   1. 发件人地址必须是配置里的收件人/to/user 之一（防陌生人）；
 *   2. 主题或正文里必须带这一段会话专属的口令（防伪造——SMTP 的 From 可以随便写）；
 *   3. UID 大于上次处理位置（防重复触发）。
 *
 * 口令是一次性的：命中后立刻作废，同一封邮件不会被处理第二次。
 */
import { randomInt } from 'node:crypto';
import { ImapClient, parseMail, pollInbox } from './imap.js';

const TOKEN_PATTERN = /\[CONT:([A-Z0-9]{8})\]/u;

/**
 * 密码学安全的 [0,1) 随机数。
 *
 * V8 的 Math.random 是 xorshift128+，内部状态可以从少量输出反推——用来生成
 * 唯一性标识没问题，用来生成「能指挥 agent 的凭据」就不合适。
 */
function secureRandom() {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

/** 生成 8 位大写口令，避开容易看错的 0/O/1/I。 */
export function makeContinueToken(random = secureRandom) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return out;
}

/** 从主题或正文里抓口令。 */
export function findToken(mail) {
  const subject = String(mail?.subject ?? '');
  const direct = TOKEN_PATTERN.exec(subject);
  if (direct) return direct[1];
  const body = String(mail?.text ?? '');
  const inline = TOKEN_PATTERN.exec(body);
  return inline ? inline[1] : undefined;
}

/** 日志里只留口令前三位：日志会被贴进 issue、导进会话，明文等于把凭据散出去。 */
export function maskToken(token) {
  const text = String(token ?? '');
  return text ? `${text.slice(0, 3)}***` : '(空)';
}

/** 从发件人字段里取纯地址。 */
export function addressOf(from) {
  const m = /<([^>]+)>/u.exec(String(from ?? ''));
  return (m ? m[1] : String(from ?? '')).trim().toLowerCase();
}

/**
 * 口令记录是否已过期。`ttl <= 0` 表示不设上限。
 *
 * 单独导出是为了能脱离 watcher 单测：过期判定错一次，就等于后门一直开着。
 */
export function isTokenExpired(entry, ttl, now = Date.now()) {
  if (!entry) return true;
  const limit = Number(ttl) || 0;
  if (limit <= 0) return false;
  return now - Number(entry.at) > limit;
}

/**
 * 在口令表里找某个会话已有的口令。同一会话共用一个口令，靠的就是这一步。
 * @param tokens token → { sessionId, at } 的表
 * @param sessionId 会话 id
 * @returns 命中的 token；没有就 undefined
 */
export function findTokenForSession(tokens, sessionId) {
  const key = String(sessionId);
  for (const [token, entry] of tokens ?? []) {
    if (entry && String(entry.sessionId) === key) return token;
  }
  return undefined;
}

/** 去掉回复里的引用行，只留用户自己写的那部分。 */
export function stripQuoted(text) {
  const lines = String(text ?? '').split(/\r?\n/u);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-{2,}\s*(原始邮件|Original Message|Forwarded message)/iu.test(trimmed)) break;
    if (/^(在|On)\s.+写道[:：]?$/u.test(trimmed)) break;
    if (/^-----Original Message-----$/iu.test(trimmed)) break;
    if (/^>/.test(trimmed)) continue;
    if (/^(发件人|From)[:：]\s/u.test(trimmed)) break;
    if (/^(发送时间|Sent)[:：]\s/u.test(trimmed)) break;
    kept.push(line);
  }
  const result = kept.join('\n').trim();
  return result === '' ? String(text ?? '').trim() : result;
}

/**
 * 把回复正文解释成一条指令。
 *
 * 约定很简单：整封只有「停止」这类词就是停，其余都算继续，而且原文就是要
 * 追加给 agent 的具体要求；什么都不写等于一句「继续」。
 */
export function parseCommand(text) {
  const cleaned = stripQuoted(text).trim();
  if (cleaned === '') return { action: 'continue', instruction: '继续' };
  // 只写了一个停止词
  if (/^(停止|停下|停手|停|取消|中止|stop|halt|abort|cancel)[\s!！。.,，]*$/iu.test(cleaned)) {
    return { action: 'stop' };
  }
  // 以停止词开头（如「停止，剩下的别改了」）也算停
  if (/^(停止|停下|停手|取消|中止|stop|halt|abort|cancel)([\s，,。.!！]|$)/iu.test(cleaned)) {
    return { action: 'stop', note: cleaned };
  }
  return { action: 'continue', instruction: cleaned };
}

/**
 * 解析一封「审批回信」里的表态：允许 / 拒绝 / 看不懂。
 *
 * 只认同向词和 1/2，不做模糊匹配——审批放行的是有副作用的工具，猜错代价太大。
 * 认不出来就返回 undefined，调用方应当保持等待（超时后把决定权交回界面），
 * 而不是默认放行或默认拒绝。先判拒绝再判允许，否则「不同意」会被允许词命中。
 *
 * @param text 邮件正文
 * @returns 'allow' | 'deny' | undefined
 */
export function parseApprovalAnswer(text) {
  const first = stripQuoted(String(text ?? ''))
    .trim()
    .split(/\r?\n/u)[0]
    .trim();
  if (first === '') return undefined;
  // 问句不算表态：「可以吗？」是在问，不是在批准。宁可让它继续等到超时。
  if (/[?？]\s*$/u.test(first)) return undefined;
  const head = first.slice(0, 40);

  if (/^(?:拒绝|不同意|不批准|不允许|不可以|不行|不许|不要|别|停止|停下|取消|驳回|否|no|nope|deny|denied|reject|rejected|cancel|abort|stop|block)/iu.test(head)) {
    return 'deny';
  }
  if (/^(?:允许|同意|批准|可以|放行|继续|确认|是|行|好|yes|yep|ok|okay|allow|approve|approved|accept|proceed|go)/iu.test(head)) {
    return 'allow';
  }
  const digit = /^([12])(?:\D|$)/u.exec(head);
  if (digit) return digit[1] === '1' ? 'allow' : 'deny';
  return undefined;
}

/**
 * 创建收件轮询器。
 * @param options.settings 当前生效配置
 * @param options.state    共享状态（sessions 表、watermark）
 * @param options.onContinue 命中口令后调用，参数为 { sessionId, text, mail }
 * @param options.persist 持久化回调（写回 sessions 文件）
 */
export function createMailboxWatcher(options) {
  const { getSettings, state, onContinue, persist, log, warn } = options;

  /**
   * 取出并消费一个口令，返回它的记录；不存在或已过期返回 undefined。
   *
   * 过期检查放在验证这一侧：签发时那次清理只管新口令，而一封放了两小时的
   * 邮件照样能寄到，不在这里拦，存活期就形同虚设。
   */
  async function takeToken(token) {
    const entry = state.continueTokens?.get(token);
    if (!entry) {
      log(`口令 ${maskToken(token)} 不存在或已被使用，忽略`);
      return undefined;
    }
    // 审批口令自带存活期（等于它这次的等待时长）；普通口令用全局 TTL
    const ttl = Number(entry?.ttl) || Number(state.tokenTtlMs) || 0;
    if (isTokenExpired(entry, ttl)) {
      state.continueTokens.delete(token);
      await persist?.();
      log(`口令 ${maskToken(token)} 已过期（存活期 ${Math.round(ttl / 60000)} 分钟），忽略`);
      return undefined;
    }
    state.continueTokens.delete(token);
    await persist?.();
    return entry;
  }
  let timer = null;
  let stopped = false;
  let running = false;
  let loopPromise = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const allowed = (settings) => {
    const set = new Set();
    for (const field of [settings.user, settings.to]) {
      for (const piece of String(field ?? '').split(',')) {
        const addr = piece.trim().toLowerCase();
        if (addr) set.add(addr);
      }
    }
    return set;
  };

  /** 处理当前未读：逐封解析、校验口令、交给 onContinue。 */
  async function drainOnce(client, settings) {
    const senders = allowed(settings);
    const uids = await client.searchUnseen(state.imapWatermark ?? 0);
    if (uids.length === 0) return 0;
    let handled = 0;
    for (const uid of uids) {
      if (uid <= (state.imapWatermark ?? 0)) continue;
      const raw = await client.fetchRaw(uid);
      if (raw === undefined) continue;
      state.imapWatermark = Math.max(state.imapWatermark ?? 0, uid);
      await persist?.();
      const mail = parseMail(raw);
      const from = addressOf(mail.from);
      if (senders.size > 0 && !senders.has(from)) {
        log(`收到邮件但发件人不被允许: ${from}`);
        continue;
      }
      const token = findToken(mail);
      if (!token) {
        log(`收到 ${from} 的邮件但没有口令，忽略`);
        continue;
      }
      // 审批回信走独立口令表：语义是「允许 / 拒绝」，不是「继续 / 停止」，
      // 两张表分开就不会出现"回一封同意信被当成继续干活"的串味。
      const approval = state.approvalTokens?.get(token);
      if (approval) {
        const answer = parseApprovalAnswer(mail.text);
        if (answer === undefined) {
          log(`审批回信看不懂（${maskToken(token)}），继续等待，超时后交回界面`);
          continue;
        }
        handled += 1;
        state.approvalTokens.delete(token);
        log(`审批回信（${maskToken(token)}）：${answer === 'allow' ? '允许' : '拒绝'}`);
        approval.settle?.(answer);
        await persist?.();
        continue;
      }
      const entry = await takeToken(token);
      if (!entry) continue;
      const command = parseCommand(mail.text);
      handled += 1;
      log(`口令 ${maskToken(token)} 命中 → ${command.action === 'stop' ? '停止' : '继续'}（会话 ${entry.sessionId}）`);
      await onContinue?.({ sessionId: entry.sessionId, command, mail });
    }
    return handled;
  }

  /**
   * 自适应轮询：登录一次保持长连接，每 N 秒发一条 UID SEARCH 看有没有新未读。
   *
   * 本来想用 IMAP IDLE 做实时推送，但实测 QQ 邮箱不推送——邮件确实进了收件箱
   * （EXISTS 从 17 变 18），IDLE 态下 25 秒内服务器一个 EXISTS 都没发过来。
   * 所以走轮询；每条 SEARCH 本身就是一次往返，连接活跃性由它维持，不需要额外 NOOP。
   *
   * 节奏跟着「最近一封通知邮件发出多久」走——刚发出去时人就在手机旁边，回复概率
   * 最高，用 5 秒一次；过了 10 分钟还没回，多半是去忙别的了，降到 10 分钟一次；
   * 超过 30 分钟基本不会回了，干脆停下，等下一封邮件发出时再被唤醒。
   */
  async function pollLoop() {
    let backoff = 1000;
    let client;
    while (!stopped) {
      try {
        const settings = getSettings();
        if (!settings.enabled || !settings.user || !settings.authCode) {
          await sleep(5000);
          continue;
        }
        const ageMs = Date.now() - (Number(state.lastMailAt) || 0);
        const fast = Number(settings.fastWindowMs) || 600000;
        const stopAfter = Number(settings.stopAfterMs) || 1800000;
        const fastEvery = Number(settings.fastIntervalMs) || 5000;
        const slowEvery = Number(settings.slowIntervalMs) || 600000;

        // 30 分钟没有新邮件：暂停，等新邮件唤醒（或被 stop 打断）
        if (!state.lastMailAt || ageMs >= stopAfter) {
          if (client) {
            try {
              client.close();
            } catch {
              /* ignore */
            }
            client = undefined;
            log('超过 30 分钟没有新通知，暂停收件检测，等下一封邮件');
          }
          await waitForWake(60000);
          continue;
        }

        const every = ageMs < fast ? fastEvery : slowEvery;

        if (!client) {
          client = new ImapClient({
            host: settings.imapHost || 'imap.qq.com',
            port: settings.imapPort || 993,
            user: settings.user,
            pass: settings.authCode,
            trace: settings.traceImap ? (m) => log(`[imap] ${m}`) : undefined,
          });
          await client.connect();
          await client.login();
          await client.selectInbox();
          log(`收件已连接（${ageMs < fast ? '快速' : '慢速'}节奏：每 ${Math.round(every / 1000)} 秒）`);
          backoff = 1000;
        }
        await drainOnce(client, settings);
        await waitForWake(every);
      } catch (error) {
        if (stopped) break;
        warn(`收件连接中断（${Math.round(backoff / 1000)} 秒后重连）: ${error?.message ?? error}`);
        try {
          client?.close();
        } catch {
          /* ignore */
        }
        client = undefined;
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    try {
      client?.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * 等待 ms 毫秒，或被 publishMail() 提前唤醒。
   * 新邮件发出时唤醒它，就能立刻从「暂停」切回「快速」节奏。
   */
  function waitForWake(ms) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        state.wakeWaiter = undefined;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(500, ms));
      timer.unref?.();
      state.wakeWaiter = finish;
    });
  }

  /** 手动轮询一次（工具 action=check 用）。 */
  async function tick() {
    if (running) return;
    const settings = getSettings();
    if (!settings.enabled || !settings.user) return;
    running = true;
    try {
      await pollInbox({
        settings,
        watermark: state.imapWatermark ?? 0,
        trace: settings.traceImap ? (m) => log(`[imap] ${m}`) : undefined,
        onMail: async (mail) => {
          const senders = allowed(settings);
          const from = addressOf(mail.from);
          if (senders.size > 0 && !senders.has(from)) return;
          const token = findToken(mail);
          if (!token) return;
          const entry = await takeToken(token);
          if (!entry) return;
          await onContinue?.({ sessionId: entry.sessionId, command: parseCommand(mail.text), mail });
        },
      });
    } catch (error) {
      warn(`手动轮询失败: ${error?.message ?? error}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      stopped = false;
      if (!loopPromise) loopPromise = pollLoop();
      log('收件已启动（长连接轮询）');
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      loopPromise = null;
    },
    tick,
  };
}
