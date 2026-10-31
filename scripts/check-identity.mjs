// 发布前一致性检查：插件改名后最容易漏的几处必须彼此一致。
//
// 真实事故：把包里 name 改成 dsh-restart-yashua，但 client.js 里
// `window.__ModuleLoader__.load({ id: 'dsh-restart' })` 没跟着改。DSH 的客户端模块
// 系统按这个 id 缓存已执行的 bundle，id 与包名不一致时同一份代码会被执行两次，
// 直接触发 `duplicate factory registration`，整个 Web 端卡在启动阶段。
//
// 用法：node scripts/check-identity.mjs
// 退出码 0 = 一致；1 = 有不一致（会指出是哪一处）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function read(rel) {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
}

const problems = [];

const pkgText = read('package.json');
if (pkgText === undefined) {
  console.log('[fail] 找不到 package.json');
  process.exit(1);
}
const pkg = JSON.parse(pkgText);
const name = pkg.name;
console.log(`包名: ${name}`);

// ① cordis.patch.yml 里 insert 的 name 必须是包名
const patch = read('cordis.patch.yml');
if (patch !== undefined) {
  const m = /name:\s*['"]([^'"]+)['"]/u.exec(patch);
  const patched = m ? m[1] : undefined;
  if (patched === name) {
    console.log(`[ok]   cordis.patch.yml name = ${patched}`);
  } else {
    problems.push(`cordis.patch.yml 的 name 是 "${patched}"，与包名 "${name}" 不一致`);
    console.log(`[fail] cordis.patch.yml name = ${patched}（应为 ${name}）`);
  }
}

// ② client.js 的模块 id 必须是包名
const client = read('client.js');
if (client !== undefined) {
  const m = /__ModuleLoader__\.load\(\s*\{[\s\S]{0,200}?id:\s*['"]([^'"]+)['"]/u.exec(client);
  const id = m ? m[1] : undefined;
  if (id === name) {
    console.log(`[ok]   client.js 模块 id = ${id}`);
  } else {
    problems.push(`client.js 的模块 id 是 "${id}"，与包名 "${name}" 不一致（会导致 duplicate factory registration）`);
    console.log(`[fail] client.js 模块 id = ${id}（应为 ${name}）`);
  }
}

// ③ locale 文件名必须是合法语言 id，且 meta.title 非空
const localeDir = path.join(root, 'locale');
if (fs.existsSync(localeDir)) {
  for (const file of fs.readdirSync(localeDir)) {
    if (!file.endsWith('.json')) continue;
    const lang = file.slice(0, -5);
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(lang)) {
      problems.push(`locale/${file} 的文件名不是合法语言 id`);
      console.log(`[fail] locale/${file} 文件名非法`);
      continue;
    }
    try {
      const j = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'));
      if (!j?.meta?.title) problems.push(`locale/${file} 缺少 meta.title`);
      else console.log(`[ok]   locale/${file} title = ${j.meta.title}`);
    } catch (error) {
      problems.push(`locale/${file} 不是合法 JSON: ${error.message}`);
      console.log(`[fail] locale/${file} 解析失败`);
    }
  }
}

// ④ 入口文件若显式导出 name，必须等于包名（Cordis 用它标识插件）
const mainField = typeof pkg.main === 'string'
  ? pkg.main
  : (pkg.exports?.['.']?.default ?? pkg.exports?.['.']);
const entryText = typeof mainField === 'string' ? read(mainField) : undefined;
if (entryText === undefined) {
  console.log(`[warn] 读不到入口文件 ${mainField ?? '(未声明 main)'}`);
} else {
  const m = /export\s+const\s+name\s*=\s*['"]([^'"]+)['"]/u.exec(entryText);
  if (!m) {
    console.log('[ok]   入口未声明 export const name（可选，缺省按包名）');
  } else if (m[1] === name) {
    console.log(`[ok]   入口 export const name = ${m[1]}`);
  } else {
    problems.push(`入口 ${mainField} 的 export const name 是 "${m[1]}"，与包名 "${name}" 不一致`);
    console.log(`[fail] 入口 export const name = ${m[1]}（应为 ${name}）`);
  }
}

// ⑤ 若 profile 里已装了这个插件，bundles 也必须是包名
const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const profilesDir = path.join(home, 'profiles');
if (fs.existsSync(profilesDir)) {
  for (const dir of fs.readdirSync(profilesDir)) {
    const manifest = path.join(profilesDir, dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    let j;
    try {
      j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    const deps = Object.keys(j?.dependencies ?? {});
    const bundles = j?.dsh?.profile?.bundles ?? [];
    const inDeps = deps.includes(name);
    if (inDeps && !bundles.includes(name)) {
      problems.push(`profile "${dir}" 的 bundles 里缺少 "${name}"（装了但没登记会加载不到）`);
      console.log(`[fail] profile ${dir}: bundles 缺少 ${name}`);
    } else if (inDeps) {
      console.log(`[ok]   profile ${dir}: dependencies 与 bundles 都含 ${name}`);
    }
  }
}

console.log('');
if (problems.length === 0) {
  console.log('全部一致 ✓');
  process.exit(0);
}
console.log(`发现 ${problems.length} 处不一致：`);
for (const p of problems) console.log(`  · ${p}`);
process.exit(1);
