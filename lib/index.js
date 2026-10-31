/**
 * dsh-mail-command —— 用邮件指挥 DeepSeek Harness。
 *
 * 它只做接收这一半：轮询邮箱、校验一次性口令、把用户回复的内容注入会话
 * （继续 / 停止，正文可以写具体要求）。发送那一半在 dsh-qq-mail-notify 里。
 *
 * 两个插件通过 cordis 服务协作，谁都不硬依赖对方：
 *   · 本插件 provide 'mailCommand'，暴露 issueToken(sessionId) / isEnabled / status；
 *   · 通知插件发信时若能取到这个服务，就顺手要一个口令附在邮件里；
 *   · 取不到服务时照常发通知，只是邮件里没有口令，回复也就不会触发任何动作。
 *
 * 这样单装任何一个插件都能正常工作：只装通知 → 纯提醒；两个都装 → 能回信指挥。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMailboxWatcher, findTokenForSession, makeContinueToken, maskToken, parseCommand } from './mailbox.js'
import { providerPreset } from './presets.js';

export const name = 'dsh-mail-command'

/** tools 是硬依赖；webServer / userQuestions 之类都按可选服务取用。 */
export const inject = []

const DEFAULTS = Object.freeze({
  enabled: true,
  /** 收件轮询间隔（毫秒），最小 30 秒。 */
  intervalMs: 5_000,
  host: 'imap.qq.com',
  port: 993,
  /** 口令存活上限：同一会话共用一个口令，每次随邮件发出即重置计时，30 分钟后作废。 */
  tokenTtlMs: 30 * 60 * 1000,
  /** 自适应收件节奏：发信后 10 分钟内快查、10~30 分钟慢查、30 分钟后暂停。 */
  fastWindowMs: 10 * 60 * 1000,
  fastIntervalMs: 5_000,
  slowIntervalMs: 10 * 60 * 1000,
  stopAfterMs: 30 * 60 * 1000,
  /** 复用的发件配置（与通知插件同一份文件）。 */
  credentialsFile: 'qq-mail-notify.json',
  /** 本插件自己的配置文件名。 */
  configFile: 'mail-command.json',
});

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return path.join(os.homedir(), '.dsh');
}

/**
 * 读 JSON 配置文件，按 mtime + size 缓存。
 *
 * 收件循环每 5 秒就要取一次配置；每次都 readFileSync + JSON.parse，一天下来
 * 是上万次同步 IO（而且用的是同一份内容）。文件没变就直接复用上次的解析结果；
 * mtime 一变立刻重读，所以改配置依然即时生效，不用重启。
 */
const jsonCache = new Map();

function readJson(file) {
  try {
    const stat = fs.statSync(file);
    const hit = jsonCache.get(file);
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      return hit.value;
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return value;
  } catch {
    // 文件不存在 / 解析失败：清掉这一项，下次重新尝试
    jsonCache.delete(file);
    return undefined;
  }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const state = {
    /** token → { sessionId, at } */
    tokens: new Map(),
    /** 审批专用口令：token → { sessionId, at, summary, settle }，与普通口令完全分开 */
    approvalTokens: new Map(),
    /** sessionId → agent */
    agents: new Map(),
    disposed: false,
    watcher: null,
    stats: { issued: 0, reused: 0, matched: 0, continued: 0, stopped: 0, skipped: 0, approvalAnswered: 0, approvalExpired: 0, lastError: null },
    /** 口令存活期：现取配置，改配置后立刻生效（收发循环验证过期时也要用）。 */
    get tokenTtlMs() {
      return settings().tokenTtlMs;
    },
  };

  const log = (message) => ctx.logger?.info?.(`[mail-command] ${message}`) ?? console.log(`[mail-command] ${message}`);
  const warn = (message) => ctx.logger?.warn?.(`[mail-command] ${message}`) ?? console.warn(`[mail-command] ${message}`);


  /** 口令落盘：$DSH_HOME/mail-command-tokens.json。
   *  之前只在内存里，DSH 一重启旧邮件里的口令就全废，用户手上那封成了废纸。 */
  const tokensFile = () => path.join(dshHome(), 'mail-command-tokens.json');
  const loadTokens = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(tokensFile(), 'utf8'));
      const now = Date.now();
      const ttl = Number(settings().tokenTtlMs) || DEFAULTS.tokenTtlMs;
      const out = new Map();
      if (raw && Number.isFinite(raw.__lastMailAt)) state.lastMailAt = raw.__lastMailAt;
      // 水位跟着账号走：换了邮箱却沿用旧水位的话，新账号的邮件 UID 更小，会被全部屏蔽掉
      if (raw && Number.isFinite(raw.__watermark) && raw.__watermarkUser === settings().user) {
        state.watermark = raw.__watermark;
      }
      for (const [token, entry] of Object.entries(raw || {})) {
        if (token === '__lastMailAt') continue;
        if (!entry || typeof entry !== 'object') continue;
        if (!Number.isFinite(entry.at) || now - entry.at > ttl) continue;
        if (typeof entry.sessionId !== 'string') continue;
        out.set(token, { sessionId: entry.sessionId, at: entry.at });
      }
      return out;
    } catch {
      return new Map();
    }
  };
  const saveTokens = () => {
    try {
      const file = tokensFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const plain = {
        __lastMailAt: Number(state.lastMailAt) || 0,
        // 水位落盘，免得每次重启都把整个未读箱重拉一遍；跟账号一起存，换号自动作废
        __watermark: Number(state.watermark) || 0,
        __watermarkUser: settings().user || '',
      };
      for (const [token, entry] of state.tokens) plain[token] = entry;
      fs.writeFileSync(file, JSON.stringify(plain, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      warn(`保存口令失败: ${error && error.message ? error.message : error}`);
    }
  };
  /** 合并设置：默认值 → 本插件配置文件 → 发件凭据（user / authCode） */
  function settings() {
    const home = dshHome();
    const own = readJson(path.join(home, cfg.configFile)) ?? {};
    const credentials = readJson(path.join(home, cfg.credentialsFile)) ?? {};
    const user = String(own.user || credentials.user || '');
    // 服务商推断：自己配过 host/port 就完全听自己的；没配过才按发件地址推断，
    // 认不出来的域名保持 QQ 默认（QQ 是主路径，零配置行为与加预设表之前一致）。
    const ownHost = own.host || (config && config.host);
    const ownPort = own.port ?? (config && config.port);
    const preset = ownHost === undefined || ownHost === '' ? providerPreset(user) : undefined;
    const usePreset = preset !== undefined && preset.imap.host !== DEFAULTS.host;
    return {
      enabled: own.enabled !== false && cfg.enabled !== false,
      intervalMs: Math.max(30_000, Number(own.intervalMs ?? cfg.intervalMs) || 60_000),
      host: ownHost || (usePreset ? preset.imap.host : DEFAULTS.host),
      port: Number(ownPort) || (usePreset ? preset.imap.port : DEFAULTS.port),
      tokenTtlMs: Number(own.tokenTtlMs ?? cfg.tokenTtlMs) || DEFAULTS.tokenTtlMs,
      fastWindowMs: Number(own.fastWindowMs ?? cfg.fastWindowMs) || DEFAULTS.fastWindowMs,
      fastIntervalMs: Number(own.fastIntervalMs ?? cfg.fastIntervalMs) || DEFAULTS.fastIntervalMs,
      slowIntervalMs: Number(own.slowIntervalMs ?? cfg.slowIntervalMs) || DEFAULTS.slowIntervalMs,
      stopAfterMs: Number(own.stopAfterMs ?? cfg.stopAfterMs) || DEFAULTS.stopAfterMs,
      user,
      authCode: String(own.authCode || credentials.authCode || ''),
      to: String(own.to || credentials.to || ''),
    };
  }

  // 启动时把落盘的口令读回来：这样重启前发出的邮件仍然可以回复
  try {
    for (const [token, entry] of loadTokens()) state.tokens.set(token, entry);
  } catch {
    /* ignore */
  }

  /** 清掉过期的口令（每次签发/匹配时顺手做）。 */
  function pruneTokens(ttl) {
    const now = Date.now();
    let changed = false;
    for (const [token, entry] of state.tokens) {
      if (now - entry.at > ttl) {
        state.tokens.delete(token);
        changed = true;
      }
    }
    if (changed) saveTokens();
  }

  /**
   * 发给通知插件的服务：给会话拿一个口令。
   *
   * 同一个会话共用一个口令——只要那串还没被用掉、也没过期，就继续用它，
   * 并把计时重置到这一次发出（所以是「每发一封续 30 分钟」，而不是每发一封
   * 多一个可用口令）。口令被回复消费掉之后，下一封通知会重新生成一个。
   */
  function issueToken(sessionId) {
    const current = settings();
    pruneTokens(current.tokenTtlMs);
    const key = String(sessionId);
    state.lastMailAt = Date.now();
    const reused = findTokenForSession(state.tokens, key);
    if (reused !== undefined) {
      const entry = state.tokens.get(reused);
      if (entry) entry.at = Date.now();
      state.stats.reused += 1;
      saveTokens();
      try {
        state.wakeWaiter?.();
      } catch {
        /* ignore */
      }
      return reused;
    }
    let token = makeContinueToken();
    // 两张表共用一个取值空间：撞上就会「回一封审批被当成继续」。
    // 概率约 32^-8，但不是零，撞一次就是难查的串味，索性当场避开。
    for (let attempt = 0; attempt < 5 && (state.tokens.has(token) || state.approvalTokens.has(token)); attempt += 1) {
      token = makeContinueToken();
    }
    state.tokens.set(token, { sessionId: key, at: Date.now() });
    state.stats.issued += 1;
    saveTokens();
    try {
      state.wakeWaiter?.();
    } catch {
      /* ignore */
    }
    return token;
  }

  /**
   * 开一次「等邮件决定是否放行」的等待。
   *
   * 返回 `{ token, decision }`：token 要拼进审批邮件，decision 会在三种情况下结算——
   * 收到明确表态（'allow' / 'deny'）、等待超时、或整个请求被中止。后两种都 resolve
   * 成 undefined，含义是「邮件通道没意见」，由调用方把决定权交回界面。
   *
   * 这里刻意不做 fail-closed 的最终裁决：邮件系统抖动不该让一次本该被批准的操作失败。
   * 真正的拒绝发生在调用方那一侧——它拿到 undefined 就不替你作答。
   */
  function beginMailDecision({ sessionId, summary, timeoutMs, signal } = {}) {
    const current = settings();
    if (!current.enabled) return undefined;
    const ttl = Number(current.tokenTtlMs) || 1_800_000;
    // 等太久没有意义：超过口令本身的存活期也一样会作废
    const wait = Math.min(Math.max(60_000, Number(timeoutMs) || 600_000), ttl);
    let token = makeContinueToken();
    // 与普通表错开（见 issueToken 里的说明）
    for (let attempt = 0; attempt < 5 && (state.tokens.has(token) || state.approvalTokens.has(token)); attempt += 1) {
      token = makeContinueToken();
    }
    const key = String(sessionId ?? '');
    let timer;
    let onAbort;
    let done = false;
    let settleRef;

    const decision = new Promise((resolve) => {
      const finish = (outcome) => {
        if (done) return;
        done = true;
        state.approvalTokens.delete(token);
        if (timer) clearTimeout(timer);
        if (onAbort) {
          try {
            signal?.removeEventListener?.('abort', onAbort);
          } catch {
            /* ignore */
          }
        }
        if (outcome === undefined) state.stats.approvalExpired += 1;
        else state.stats.approvalAnswered += 1;
        resolve(outcome);
      };
      settleRef = finish;
      timer = setTimeout(() => {
        log(`审批口令 ${maskToken(token)} 等待超时（${Math.round(wait / 60000)} 分钟），交回界面处理`);
        finish(undefined);
      }, wait);
      timer?.unref?.();
      onAbort = () => finish(undefined);
      try {
        signal?.addEventListener?.('abort', onAbort, { once: true });
      } catch {
        /* ignore */
      }
      state.approvalTokens.set(token, {
        sessionId: key,
        at: Date.now(),
        // 审批口令按它自己的等待时长算存活期，不跟普通口令的 30 分钟混在一起
        ttl: wait,
        summary: String(summary ?? ''),
        settle: finish,
      });
    });

    log(`签发审批口令 ${maskToken(token)}（会话 ${key || '?'}，等待 ${Math.round(wait / 60000)} 分钟）`);
    return {
      token,
      decision,
      /** 放弃这次等待（比如审批邮件根本没发出去），立刻结算成「没意见」。 */
      cancel: () => settleRef?.(undefined),
    };
  }

  /** 收件命中：按指令继续或停止。 */
  async function dispatch({ sessionId, command }) {
    const agent = state.agents.get(String(sessionId));
    if (!agent) {
      state.stats.skipped += 1;
      warn(`会话 ${sessionId} 的 agent 不在内存里，指令被丢弃`);
      return;
    }
    if (command?.action === 'stop') {
      try {
        agent.cancel({ kind: 'user' }, { keepInbox: false });
        state.stats.stopped += 1;
        log(`邮件停止: ${sessionId}${command.note ? ` — ${String(command.note).slice(0, 40)}` : ''}`);
      } catch (error) {
        state.stats.lastError = String(error?.message ?? error);
        warn(`停止失败: ${error?.message ?? error}`);
      }
      return;
    }
    const text = String(command?.instruction || '继续').trim() || '继续';
    // message 必须带 source.kind：agent-instructions 之类的 pre-step 钩子会读
    // message.source.kind 来判断消息来源，缺了它就是 "Cannot read properties of
    // undefined (reading 'kind')"，整轮直接崩。
    const injected = {
      id: `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };
    try {
      // followup() 是 agent 的正规入口：入 next-turn 队列并唤醒驱动，
      // 等价于用户在界面里发了一条消息。没有它才退回直接操作 inbox。
      if (typeof agent.followup === 'function') {
        agent.followup(injected);
      } else {
        agent.inbox.append('next-turn', injected);
        agent.wakeDriver?.();
      }
      state.stats.continued += 1;
      log(`邮件继续: ${sessionId} — ${text.slice(0, 60)}`);
    } catch (error) {
      state.stats.lastError = String(error?.message ?? error);
      warn(`注入失败: ${error?.message ?? error}`);
    }
  }

  // ---- 记录存活 agent -------------------------------------------------------
  const onAgentCreated = (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    state.agents.set(String(agent.id), agent);
  };
  const onAgentDisposed = (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    state.agents.delete(String(agent.id));
  };

  const listen = (event, handler) => {
    try {
      const off = ctx.on?.(event, handler);
      if (typeof off === 'function') return off;
    } catch (error) {
      warn(`订阅 ${event} 失败: ${error?.message ?? error}`);
    }
    return undefined;
  };

  listen('agent/created', onAgentCreated);
  listen('agent/disposed', onAgentDisposed);

  // ---- 收件轮询 -------------------------------------------------------------
  state.watcher = createMailboxWatcher({
    getSettings: () => {
      const current = settings();
      return {
        enabled: current.enabled,
        receiveEnabled: current.enabled,
        receiveIntervalMs: current.intervalMs,
        imapHost: current.host,
        imapPort: current.port,
        user: current.user,
        authCode: current.authCode,
        to: current.to,
      };
    },
    state: {
      get continueTokens() {
        return state.tokens;
      },
      /**
       * 审批专用口令表。必须显式透出去——少这一行，收件侧读到的是 undefined，
       * 审批回信会全部落到「普通口令」那条路上然后匹配失败，表现为"回了邮件没反应"。
       */
      get approvalTokens() {
        return state.approvalTokens;
      },
      /** 口令存活期。少这一行，验证侧的过期检查会拿到 undefined → 0 → 永不失效。 */
      get tokenTtlMs() {
        return state.tokenTtlMs;
      },
      get imapWatermark() {
        return state.watermark ?? 0;
      },
      set imapWatermark(value) {
        state.watermark = value;
      },
      get lastMailAt() {
        return state.lastMailAt ?? 0;
      },
      set lastMailAt(value) {
        state.lastMailAt = value;
      },
      set wakeWaiter(fn) {
        state.wakeWaiter = fn;
      },
      get wakeWaiter() {
        return state.wakeWaiter;
      },
    },
    onContinue: async ({ sessionId, command }) => {
      state.stats.matched += 1;
      await dispatch({ sessionId, command });
    },
    log,
    warn,
  });

  if (settings().enabled) {
    try {
      state.watcher.start();
    } catch (error) {
      warn(`启动收件轮询失败: ${error?.message ?? error}`);
    }
  }

  // ---- 对外提供 mailCommand 服务 --------------------------------------------
  try {
    ctx.provide?.('mailCommand', {
      isEnabled: () => settings().enabled,
      /** 通知插件发信时调用：拿一个绑到该会话的一次性口令。 */
      issueToken,
      /** 需要「回信批准」时调用：开一次等待，返回 { token, decision }。 */
      beginMailDecision,
      status: () => ({
        enabled: settings().enabled,
        intervalMs: settings().intervalMs,
        host: settings().host,
        port: settings().port,
        pendingTokens: state.tokens.size,
        agents: state.agents.size,
        stats: { ...state.stats },
      }),
    });
  } catch (error) {
    warn(`提供 mailCommand 服务失败: ${error?.message ?? error}`);
  }

  log(`已激活；收件=${settings().enabled ? '开' : '关'} 账号=${settings().user || '(未配置)'}`);

  // ---- 前置条件自检 ---------------------------------------------------------
  // 本插件不发送任何邮件：口令随通知插件的邮件一起发出。没有发件侧就没有可回复
  // 的邮件，功能等于不存在——所以启动时就把这种情况说清楚，而不是静默无效。
  try {
    const home = dshHome();
    const profilesDir = path.join(home, 'profiles');
    let senderInstalled = false;
    if (fs.existsSync(profilesDir)) {
      for (const dir of fs.readdirSync(profilesDir)) {
        if (fs.existsSync(path.join(profilesDir, dir, 'node_modules', 'dsh-qq-mail-notify'))) {
          senderInstalled = true;
          break;
        }
      }
    }
    const current = settings();
    if (!senderInstalled) {
      warn(
        '未检测到发送侧插件 dsh-qq-mail-notify。本插件靠它发出的通知邮件附带一次性口令，' +
          '缺了它收不到可回复的邮件，功能不会生效。请一并安装：' +
          'dsh plugin --profile <你的 profile> add github:yashua233/dsh-qq-mail-notify',
      );
    } else if (!current.user || !current.authCode) {
      warn('发送侧已安装，但还没配置发件邮箱 / SMTP 授权码（在 dsh-qq-mail-notify 里填）。没有凭据无法登录 IMAP。');
    } else {
      log(`前置条件就绪：发送侧已装，IMAP 账号 ${current.user}`);
    }
  } catch (error) {
    warn(`前置条件自检失败（不影响其它功能）: ${error?.message ?? error}`);
  }


  // ---- 工具：看状态 / 手动触发一次收件 ------------------------------------
  // 收件是后台轮询，出问题时（口令没命中、轮询没跑）只能靠日志猜；
  // 给它一个能主动问的入口，排查会快很多。
  const registerTool = (registry) => {
    if (!registry || typeof registry.register !== 'function') return;
    const tool = {
      name: 'mail_command',
      description:
        '查看或手动触发「邮件指令」插件的收件状态。' +
        'action=status 返回是否开启、轮询间隔、待用口令数、存活 agent 数与本轮统计；' +
        'action=check 立刻轮询一次收件箱，并返回这次处理了哪些邮件、口令是否命中。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['status', 'check'], description: 'status 看状态，check 立刻拉一次收件箱。' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
          required: ['ok', 'text'],
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(input) {
        try {
          const current = settings();
          if (input?.action === 'check') {
            const before = { continued: state.stats.continued, stopped: state.stats.stopped, matched: state.stats.matched };
            await state.watcher?.tick();
            const delta = {
              matched: state.stats.matched - before.matched,
              continued: state.stats.continued - before.continued,
              stopped: state.stats.stopped - before.stopped,
            };
            return {
              ok: true,
              text: [
                '已手动轮询一次收件箱。',
                // 口令打码：status 的结果会进 agent 上下文，完整口令出现在对话里，
              // 对话一旦被导出或分享，30 分钟内的可用凭据就跟着走了。要看全文去邮件里找。
              '待用口令: ' + state.tokens.size + ' 个（每会话一个）['
                + [...state.tokens.keys()].map((t) => `${String(t).slice(0, 3)}***`).join(', ') + ']',
                '本次命中: ' + delta.matched + '，继续: ' + delta.continued + '，停止: ' + delta.stopped,
                '累计统计: ' + JSON.stringify(state.stats),
              ].join('\n'),
            };
          }
          const ageMs = Date.now() - (Number(state.lastMailAt) || 0);
          const phase =
            !state.lastMailAt || ageMs >= current.stopAfterMs
              ? '暂停（' + (state.lastMailAt ? '距上封邮件 ' + Math.round(ageMs / 60000) + ' 分钟' : '还没有发过带口令的邮件') + '）'
              : ageMs < current.fastWindowMs
                ? '快速（每 ' + Math.round(current.fastIntervalMs / 1000) + ' 秒，已过 ' + Math.round(ageMs / 1000) + ' 秒）'
                : '慢速（每 ' + Math.round(current.slowIntervalMs / 60000) + ' 分钟，已过 ' + Math.round(ageMs / 60000) + ' 分钟）';
          return {
            ok: true,
            text: [
              '收件开关: ' + (current.enabled ? '开' : '关'),
              '当前节奏: ' + phase,
              '节奏规则: 发信后 ' + Math.round(current.fastWindowMs / 60000) + ' 分钟内每 ' + Math.round(current.fastIntervalMs / 1000) + ' 秒；'
                + Math.round(current.fastWindowMs / 60000) + '~' + Math.round(current.stopAfterMs / 60000) + ' 分钟每 '
                + Math.round(current.slowIntervalMs / 60000) + ' 分钟；超过 ' + Math.round(current.stopAfterMs / 60000) + ' 分钟暂停',
              'IMAP: ' + current.host + ':' + current.port + '  账号: ' + (current.user || '(未配置)'),
              '凭据来源: ' + (current.user ? '可用' : '缺失（需要 dsh-qq-mail-notify 里配置发件邮箱）'),
              // 口令打码：status 的结果会进 agent 上下文，完整口令出现在对话里，
              // 对话一旦被导出或分享，30 分钟内的可用凭据就跟着走了。要看全文去邮件里找。
              '待用口令: ' + state.tokens.size + ' 个（每会话一个）['
                + [...state.tokens.keys()].map((t) => `${String(t).slice(0, 3)}***`).join(', ') + ']',
              '存活 agent: ' + state.agents.size + ' 个',
              '已处理 UID 水位: ' + (state.watermark ?? 0),
              '统计: ' + JSON.stringify(state.stats),
            ].join('\n'),
          };
        } catch (error) {
          return { ok: false, text: '查询失败: ' + String(error && error.message ? error.message : error) };
        }
      },
    };
    try {
      registry.register(tool);
    } catch (error) {
      warn(`注册 mail_command 工具失败: ${error && error.message ? error.message : error}`);
    }
  };

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scope) => registerTool(scope?.tools ?? ctx.get?.('tools')));
    } catch (error) {
      warn(`注入 tools 失败: ${error && error.message ? error.message : error}`);
    }
  } else {
    registerTool(ctx.get?.('tools'));
  }

  const cleanup = () => {
    if (state.disposed) return;
    state.disposed = true;
    try {
      state.watcher?.stop();
    } catch {
      /* ignore */
    }
    // 把还在等的审批全部结算成「没意见」。不这么做的话，发信侧那句
    // await decision 会永远悬挂——插件看起来卸载干净了，但那一轮 turn 卡死在这里，
    // 而且没有任何日志。这是卸载路径上最容易漏的一处。
    for (const entry of state.approvalTokens.values()) {
      try {
        entry?.settle?.(undefined);
      } catch {
        /* 单个失败不影响其余 */
      }
    }
    state.tokens.clear();
    state.approvalTokens.clear();
    state.agents.clear();
  };
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
    else ctx.on?.('dispose', cleanup);
  } catch {
    /* ignore */
  }
}

export default { name, inject, apply };
