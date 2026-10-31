// 离线自检：不联网、不发信，只验证口令、指令解析与服务商推断这些纯逻辑。
//
//   node scripts/selfcheck.mjs
import assert from 'node:assert/strict';
import {
  addressOf, findToken, findTokenForSession, isTokenExpired, makeContinueToken, parseApprovalAnswer, parseCommand, stripQuoted,
} from '../lib/mailbox.js';
import { htmlToText, unseenQuery } from '../lib/imap.js';
import { PRESETS, providerIdFor, providerPreset } from '../lib/presets.js';

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check('口令：8 位，字符集避开易混的 0/O/1/I', () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(makeContinueToken(), /^[A-HJ-NP-Z2-9]{8}$/u);
  }
});

check('口令：200 次生成 200 个不同值', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(makeContinueToken());
  assert.equal(seen.size, 200);
});

check('口令：从主题或正文提取，格式不对不认', () => {
  assert.equal(findToken({ subject: '[DSH] 完成 [CONT:ABCD2345]' }), 'ABCD2345');
  assert.equal(findToken({ subject: '普通主题', text: '正文里带 [CONT:XYZ23456]' }), 'XYZ23456');
  assert.equal(findToken({ subject: '没有口令' }), undefined);
  assert.equal(findToken({ subject: '[CONT:ABC2345]' }), undefined, '7 位不该认');
  assert.equal(findToken({ subject: '[CONT:abcd2345]' }), undefined, '小写不该认');
});

check('口令：存活期从发出时刻起算，30 分钟为界', () => {
  const started = 1_000_000;
  const entry = { sessionId: 's1', at: started };
  const ttl = 30 * 60 * 1000;
  assert.equal(isTokenExpired(entry, ttl, started), false);
  assert.equal(isTokenExpired(entry, ttl, started + ttl - 1), false);
  assert.equal(isTokenExpired(entry, ttl, started + ttl + 1), true, '超 1 毫秒即过期');
  assert.equal(isTokenExpired(undefined, ttl, started), true);
  assert.equal(isTokenExpired(entry, 0, started + 100 * ttl), false, 'ttl=0 表示不设上限');
});

check('口令：同一会话共用一个，不同会话互不串', () => {
  const tokens = new Map([
    ['AAAAAAAA', { sessionId: 's1', at: 1 }],
    ['BBBBBBBB', { sessionId: 's2', at: 1 }],
  ]);
  assert.equal(findTokenForSession(tokens, 's1'), 'AAAAAAAA');
  assert.equal(findTokenForSession(tokens, 's2'), 'BBBBBBBB');
  assert.equal(findTokenForSession(tokens, 's3'), undefined);
  // 数字 id 与字符串 id 视为同一个会话
  const numeric = new Map([['CCCCCCCC', { sessionId: '42', at: 1 }]]);
  assert.equal(findTokenForSession(numeric, 42), 'CCCCCCCC');
});

check('地址：从 From 头里取出纯地址并转小写', () => {
  assert.equal(addressOf('张三 <User@QQ.com>'), 'user@qq.com');
  assert.equal(addressOf('user@qq.com'), 'user@qq.com');
});

check('指令：7 种输入都解释对', () => {
  assert.deepEqual(parseCommand(''), { action: 'continue', instruction: '继续' });
  assert.deepEqual(parseCommand('继续'), { action: 'continue', instruction: '继续' });
  assert.deepEqual(parseCommand('停止'), { action: 'stop' });
  assert.deepEqual(parseCommand('stop'), { action: 'stop' });
  assert.deepEqual(parseCommand('停止，剩下的别改了'), { action: 'stop', note: '停止，剩下的别改了' });
  assert.deepEqual(parseCommand('继续，把测试补上'), { action: 'continue', instruction: '继续，把测试补上' });
  assert.deepEqual(parseCommand('把 README 更新一下'), { action: 'continue', instruction: '把 README 更新一下' });
});

check('引用行：原始邮件分隔之后的内容全部丢弃', () => {
  assert.equal(stripQuoted('继续\n\n--- 原始邮件 ---\n发件人: someone\n> 老内容'), '继续');
  assert.equal(stripQuoted('继续\n> 引用的一行'), '继续');
  // 整封都是引用时保留原文，避免把指令吃成空的
  assert.equal(stripQuoted('> 只有引用'), '> 只有引用');
});

check('收件：只问服务器要水位之后的新未读', () => {
  assert.equal(unseenQuery(0), 'UID SEARCH UNSEEN', '没有水位时列出全部未读');
  assert.equal(unseenQuery(undefined), 'UID SEARCH UNSEEN');
  assert.equal(unseenQuery(20), 'UID SEARCH UNSEEN UID 21:*');
  assert.equal(unseenQuery('42'), 'UID SEARCH UNSEEN UID 43:*');
  assert.equal(unseenQuery(-1), 'UID SEARCH UNSEEN');
});

check('HTML 正文：标签剥离，script/style/注释整段丢弃', () => {
  assert.equal(htmlToText('<p>继续</p>'), '继续');
  assert.equal(htmlToText('<div>a<br>b</div>'), 'a\nb');
  assert.equal(htmlToText('甲&nbsp;乙 &amp; 丙'), '甲 乙 & 丙');

  assert.ok(!htmlToText('<script>alert(1)</script>继续').includes('alert'), 'script 内容不该留下');
  assert.ok(!htmlToText('<style>body{color:red}</style>继续').includes('body'), 'style 内容不该留下');
  assert.equal(htmlToText('<!-- 隐藏说明 -->继续'), '继续');

  // 嵌套变形：单次正则删掉内层后会拼出新的 <script>，状态机应该整段丢掉
  const nasty = '<scr<script>ipt>alert(1)</scr</script>ipt>继续';
  const cleaned = htmlToText(nasty);
  assert.ok(!cleaned.includes('<'), `不该残留尖括号：${cleaned}`);
  assert.ok(cleaned.includes('继续'), '正常文字要留下');

  // 未闭合的 script：丢到结尾，别把后面的内容当正文
  assert.ok(!htmlToText('<script>alert(1)').includes('alert'));

  // 正文里的数学比较不该被当成标签吃掉
  assert.ok(htmlToText('1 < 2 且 3 > 2').startsWith('1'));
});

check('审批回信：只认明确表态，认不出返回 undefined', () => {
  assert.equal(parseApprovalAnswer('允许'), 'allow');
  assert.equal(parseApprovalAnswer('同意，继续'), 'allow');
  assert.equal(parseApprovalAnswer('ok'), 'allow');
  assert.equal(parseApprovalAnswer('1'), 'allow');
  assert.equal(parseApprovalAnswer('拒绝'), 'deny');
  assert.equal(parseApprovalAnswer('no'), 'deny');
  assert.equal(parseApprovalAnswer('2'), 'deny');
  // 「不同意」不能被允许词「同意」命中——先判拒绝就是为了这个
  assert.equal(parseApprovalAnswer('不同意'), 'deny');
  assert.equal(parseApprovalAnswer('不批准这个操作'), 'deny');
  // 看不懂就不能猜：调用方会继续等，超时后交回界面
  assert.equal(parseApprovalAnswer(''), undefined);
  assert.equal(parseApprovalAnswer('这是什么意思'), undefined);
  // 问句不是表态：「可以吗？」是在问，不是在批准
  assert.equal(parseApprovalAnswer('可以吗？'), undefined);
  assert.equal(parseApprovalAnswer('OK?'), undefined);
  // 引用部分剥掉，只看用户自己写的那行
  assert.equal(parseApprovalAnswer('拒绝\n\n--- 原始邮件 ---\n允许'), 'deny');
});

check('性能：畸形输入不会触发正则回溯爆炸', () => {
  // 邮件正文完全由发件人控制，正则写得松一点就能被一把超长构造串拖死
  const started = Date.now();
  htmlToText(`${'<'.repeat(20000)}${'a'.repeat(20000)}`);
  htmlToText('<!--'.repeat(5000));
  htmlToText(`<script>${'x'.repeat(50000)}`);
  parseApprovalAnswer(`${'允许'.repeat(5000)}`);
  stripQuoted(`${'>'.repeat(20000)}`);
  const spent = Date.now() - started;
  assert.ok(spent < 1500, `耗时 ${spent}ms，疑似回溯爆炸`);
});

check('服务商：QQ 仍是默认，其他按域名推断，认不出不猜', () => {
  assert.equal(providerIdFor('a@qq.com'), 'qq');
  assert.equal(providerIdFor('a@foxmail.com'), 'qq');
  assert.equal(providerIdFor(''), 'qq', '空地址按 QQ 处理');
  assert.equal(providerIdFor('a@corp.example'), undefined);
  assert.equal(providerPreset('a@163.com').imap.host, 'imap.163.com');
  assert.equal(PRESETS.qq.imap.host, 'imap.qq.com');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}
console.log('');
if (failed === 0) {
  console.log(`全部通过（${checks.length} 项）`);
  process.exit(0);
}
console.log(`${failed} 项失败`);
process.exit(1);
