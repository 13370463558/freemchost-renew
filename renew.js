const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// —— 可配置常量 ——
// 服务器列表页地址（仅用于续期成功后回读剩余时间与截图）
const LIST_PAGE_URL = 'https://freemchost.com/app/servers';
// 列表页卡片底部"剩余时间"标签。依赖英文界面，站点若改文案只需改这一处。
const LIST_PAGE_LABEL_EXPIRES = 'EXPIRES IN';
// 续期弹窗中的时长选项（现有物理点击方案的目标）
const RENEW_OPTION_TEXT = '60 hours';

// Telegram 消息与截图推送
async function sendTG(botToken, chatId, text, photoPath) {
  if (!botToken || !chatId) return;
  try {
    if (photoPath && fs.existsSync(photoPath)) {
      try {
        const fileBuffer = fs.readFileSync(photoPath);
        const blob = new Blob([fileBuffer], { type: 'image/png' });
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', text.substring(0, 1024));
        formData.append('parse_mode', 'HTML');
        formData.append('photo', blob, path.basename(photoPath));

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          body: formData
        });

        if (res.ok) {
          console.log('📨 Telegram 截图与图文报告推送成功！');
          return;
        }
      } catch (err) {
        console.log(`⚠️ 发送图片异常 (${err.message})，回退到纯文本...`);
      }
    }

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    console.log('📨 Telegram 纯文本推送成功');
  } catch (e) {
    console.log('⚠️ Telegram 推送失败:', e.message);
  }
}

// 清理阻挡点击的 Modal 弹窗
async function cleanPopup(page) {
  try {
    const popups = [
      'button:has-text("Maybe later")',
      'div[role="dialog"] button:has-text("Maybe later")',
      'text="Maybe later"',
      'button:has-text("Accept")',
      'button:has-text("I understand")',
      'button:has-text("Dismiss")',
      'button:has-text("Close")',
      '[aria-label="Close"]'
    ];
    for (const sel of popups) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 150 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        console.log(`🧹 顺手关闭遮挡弹窗: ${sel}`);
        await page.waitForTimeout(200);
      }
    }
  } catch (e) {}
}

// 登录模块
async function doLogin(page, email, password) {
  console.log('🔑 正在登录 FreeMCHost...');

  // —— 诊断收集：控制台错误 / 页面异常 / Supabase 鉴权响应 ——
  // 这个站的登录走 Supabase Auth（signInWithPassword），失败时只弹 sonner toast 且自动消失，
  // 原来的代码等 20 秒才截图，早已拍不到任何错误提示。这里把真正的失败原因抓下来打日志。
  const diag = { console: [], pageErrors: [], auth: [] };
  const onConsole = (m) => {
    if (m.type() === 'error' || m.type() === 'warning') diag.console.push(`[${m.type()}] ${m.text()}`);
  };
  const onPageError = (e) => diag.pageErrors.push(String((e && e.message) || e));
  const onRequestFailed = (r) =>
    diag.pageErrors.push(`REQUEST_FAILED ${r.method()} ${r.url()} :: ${(r.failure() || {}).errorText || ''}`);
  const onResponse = async (res) => {
    const u = res.url();
    if (/\/auth\/v1\//.test(u) || /supabase/i.test(u)) {
      let body = '';
      try { body = (await res.text()).slice(0, 400); } catch (e) {}
      diag.auth.push(`${res.status()} ${res.request().method()} ${u} :: ${body.replace(/\s+/g, ' ')}`);
    }
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  const dumpDiag = (tag) => {
    console.log(
      `📋 诊断(${tag}): 鉴权响应 ${diag.auth.length} 条 / 页面异常 ${diag.pageErrors.length} 条 / 控制台 ${diag.console.length} 条`
    );
    diag.auth.slice(-4).forEach((l) => console.log(`   🔐 ${l}`));
    diag.pageErrors.slice(-4).forEach((l) => console.log(`   ❗ ${l}`));
    diag.console.slice(-6).forEach((l) => console.log(`   🖥️ ${l}`));
  };

  // 读取 sonner toast 的文案（失败提示就藏在这里，几秒后自动消失）
  const readToast = () =>
    page
      .evaluate(() => {
        const el = document.querySelector('[data-sonner-toast]');
        if (!el) return '';
        const t = el.querySelector('[data-title]');
        const d = el.querySelector('[data-description]');
        return [t && t.textContent, d && d.textContent].filter(Boolean).join(' | ').trim();
      })
      .catch(() => '');

  // 逐字键入（真实键盘事件），比 fill 更能保证 React 受控组件的 state 被更新
  const typeInto = async (loc, text) => {
    if (typeof loc.pressSequentially === 'function') {
      await loc.pressSequentially(text, { delay: 25 });
    } else {
      await loc.type(text, { delay: 25 }); // 兼容旧版 Playwright
    }
  };

  try {
    await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // 这是 ~1MB 的 SPA，必须等水合完成；否则值只写进 DOM，React 的受控 state 读不到 → 提交空账号密码
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await cleanPopup(page);

    if (!page.url().includes('/login')) {
      console.log('✅ 已处于登录状态');
      return;
    }

    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });
    const passInput = page.locator('input[type="password"]').first();
    const signInBtn = page.locator('button[type="submit"]:has-text("Sign in")').first();

    const fillCreds = async () => {
      await emailInput.click();
      await emailInput.fill('');
      await typeInto(emailInput, email);
      if ((await emailInput.inputValue()) !== email) await emailInput.fill(email);

      await passInput.click();
      await passInput.fill('');
      await typeInto(passInput, password);
      if ((await passInput.inputValue()) !== password) await passInput.fill(password);
      await page.waitForTimeout(250);
    };

    await fillCreds();

    let loggedIn = false;
    let toastText = '';
    let attempt = 0;

    // 站点已知问题：首次登录会偶发 “Database error granting user”，重新登录一次即可
    const DB_ERROR_RE = /database error|granting user/i;
    const MAX_ATTEMPTS = 4;

    while (attempt < MAX_ATTEMPTS && !loggedIn) {
      attempt += 1;

      // 第一次已在上面加载过；后续每次尝试都回到登录页重新来过
      if (attempt > 1) {
        console.log('🔄 重新加载登录页后重试...');
        await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1200);
        await cleanPopup(page);
      }

      await fillCreds();
      const btnText = (await signInBtn.innerText().catch(() => '')).trim();
      console.log(`👆 [第 ${attempt}/${MAX_ATTEMPTS} 次] 点击 Sign in（按钮文案: ${btnText || '未知'}）`);
      await signInBtn.click();

      let attemptToast = '';
      for (let s = 0; s < 12; s++) {
        await page.waitForTimeout(1000);

        if (!attemptToast) {
          const t = await readToast();
          if (t) {
            attemptToast = t;
            console.log(`🍞 捕获到提示(toast): ${t}`);
          }
        }
        if (!page.url().includes('/login')) {
          loggedIn = true;
          break;
        }
        await cleanPopup(page);
        // 已经拿到错误提示就提前收尾，让后续截图还能拍到 toast
        if (attemptToast) {
          await page.waitForTimeout(800);
          break;
        }
      }

      if (loggedIn) break;

      if (attemptToast && DB_ERROR_RE.test(attemptToast)) {
        console.log(`⚠️ 首次授权异常（${attemptToast}）——站点已知问题，自动重新登录一次...`);
        continue;
      }

      toastText = attemptToast;
      if (!toastText) {
        console.log(`⚠️ 第 ${attempt} 次点击后既未跳转也无提示（可能是水合未完成），重填后再试...`);
        continue;
      }
      break;
    }

    if (!loggedIn) {
      dumpDiag('登录失败');
      if (toastText) console.log(`❌ 服务器返回的登录错误: ${toastText}`);
      throw new Error(
        toastText
          ? `登录被拒绝：${toastText}`
          : '登录未成功跳转（未捕获到服务器提示，请查看上方诊断：鉴权响应 / 页面异常 / 控制台）'
      );
    }
    console.log('🎉 登录成功！');
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);
  }
}

// 执行开机指令（主三角键 + Standard start）
async function triggerStartServer(page) {
  console.log('⚡ 开始执行开机指令...');
  
  try {
    const consoleTab = page.locator('[role="tab"]:has-text("Console"), button:has-text("Console"), a:has-text("Console")').first();
    if (await consoleTab.isVisible({ timeout: 2500 }).catch(() => false)) {
      await consoleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  } catch (e) {}

  await cleanPopup(page);

  const playButtonSelectors = [
    'button:has(svg.lucide-play)',
    'button:has(svg[data-icon="play"])',
    'button:has(svg.fa-play)',
    'button[aria-label*="start" i]'
  ];

  let startClicked = false;
  for (const sel of playButtonSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ force: true });
      startClicked = true;
      console.log(`👆 已点击控制台主开机三角按钮: ${sel}`);
      break;
    }
  }

  if (!startClicked) {
    startClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const svg = b.querySelector('svg');
        if (svg) {
          const html = svg.innerHTML.toLowerCase();
          if (html.includes('polygon') || svg.classList.contains('lucide-play') || b.getAttribute('aria-label') === 'Start') {
            b.click();
            return true;
          }
        }
      }
      return false;
    });
  }

  await page.waitForTimeout(1500);

  const standardStartSelectors = [
    'button:has-text("Standard start")',
    'div:has-text("Standard start")',
    '[role="button"]:has-text("Standard start")'
  ];

  let standardClicked = false;
  for (const sel of standardStartSelectors) {
    const standardBtn = page.locator(sel).last();
    if (await standardBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await standardBtn.click({ force: true });
      standardClicked = true;
      console.log(`👆 已成功点击【Standard start】按钮启动服务器！`);
      break;
    }
  }

  if (!standardClicked) {
    console.log('ℹ️ 未检测到 Standard start 确认弹窗，可能已处于运行状态');
  }

  await page.waitForTimeout(2000);
  await cleanPopup(page);
}

// —— 纯函数：解析列表页剩余时间文本 ——
// 兼容站点实际格式：
//   "17 : 41 : 13"        → 约 17.687h
//   "1d 2 : 41 : 13"      → 约 26.687h（"1d" 与 "2 :" 之间有无空格都要吃）
//   "0d 05 : 00 : 00"     → 5.0h
//   "2d"                  → 48.0h
//   "Expired" / 乱码 / 空 → null（log 原文，绝不静默当 0）
function parseExpiryText(text) {
  const raw = (text == null ? '' : String(text)).replace(/\s+/g, ' ').trim();
  if (!raw) {
    console.log('⚠️ parseExpiryText: 收到空文本，无法解析剩余时间');
    return null;
  }
  if (/expired/i.test(raw)) {
    console.log(`⚠️ parseExpiryText: 站点显示已过期，原始文本="${raw}"`);
    return null;
  }

  // 天部分：形如 "1d" / "2d"，d 后不能紧跟字母（避免误吃普通单词）
  const dayMatch = raw.match(/(\d+)\s*d(?![a-z])/i);
  const days = dayMatch ? parseInt(dayMatch[1], 10) : 0;

  // 时间部分：HH : MM (: SS)，冒号两侧允许空格
  const timeMatch = raw.match(/(\d{1,3})\s*:\s*(\d{1,2})\s*(?::\s*(\d{1,2}))?/);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (timeMatch) {
    hours = parseInt(timeMatch[1], 10);
    minutes = parseInt(timeMatch[2], 10);
    seconds = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
  }

  if (!dayMatch && !timeMatch) {
    console.log(`⚠️ parseExpiryText: 无法识别的剩余时间文本，原始值="${raw}"`);
    return null;
  }

  return { totalHours: days * 24 + hours + minutes / 60 + seconds / 3600, raw };
}

// —— 浏览器上下文函数：定位列表页每张服务器卡片及其 EXPIRES IN 数值 ——
// 只会被 page.evaluate 序列化后丢进浏览器执行，禁止引用任何 Node 侧变量。
//
// "从 EXPIRES IN 向上定位所属服务器卡片"的判定依据（对应截图特征）：
//   a. 该祖先文本含状态徽章 "Active" / "Expiring" —— 截图每张卡片顶部的状态徽章
//   b. 或含规格标签 "RAM" / "CPU" / "DISK"        —— 截图卡片中部的三格
//   c. 或尺寸明显大于一行（height>120 且 width>200）—— 越过单行文本后落到整张卡片
// 逐层向上，命中任一特征即停；不写死 3~4 层 parentElement。
// 同时给卡片打上唯一属性 attr，供 Node 侧用 Playwright locator 精确截图。
function browserFindExpiryCards({ label, attr }) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const labelUpper = label.toUpperCase();
  const all = Array.from(document.querySelectorAll('*'));

  // 优先最内层精确匹配"EXPIRES IN"的元素；找不到再放宽为包含匹配
  let labels = all.filter((el) => el.children.length === 0 && norm(el.textContent).toUpperCase() === labelUpper);
  if (!labels.length) {
    labels = all.filter((el) => el.children.length === 0 && norm(el.textContent).toUpperCase().includes(labelUpper));
  }

  const seen = new Set();
  const cards = [];
  for (const labelEl of labels) {
    let node = labelEl;
    let card = null;
    for (let up = 0; up < 10 && node; up++) {
      const t = norm(node.innerText);
      const hasBadge = /\b(active|expiring)\b/i.test(t);
      const hasSpecs = /\b(RAM|CPU|DISK)\b/.test(t);
      const r = node.getBoundingClientRect();
      const largeEnough = r.height > 120 && r.width > 200;
      if (t.toUpperCase().includes(labelUpper) && (hasBadge || hasSpecs || largeEnough)) {
        card = node;
        break;
      }
      node = node.parentElement;
    }
    if (!card || seen.has(card)) continue;
    seen.add(card);

    // 取 "EXPIRES IN" 所在的那一行，去掉标签后剩下的就是倒计时数值
    let row = labelEl;
    for (let up = 0; up < 4 && row; up++) {
      const rt = norm(row.innerText).toUpperCase();
      if (rt.includes(labelUpper) && rt.replace(labelUpper, '').trim().length > 0) break;
      row = row.parentElement;
    }
    const rowText = norm(row ? row.innerText : '');

    const idx = cards.length;
    card.setAttribute(attr, String(idx));
    cards.push({
      text: norm(card.innerText),
      expiresText: rowText.replace(new RegExp(labelUpper, 'i'), '').trim()
    });
  }
  return cards;
}

const EXPIRY_CARD_ATTR = 'data-fx-expiry-card';

// 收集列表页所有服务器卡片（含 EXPIRES IN 数值文本 + Node 侧索引）
async function gatherExpiryCards(page) {
  try {
    const cards = await page.evaluate(browserFindExpiryCards, { label: LIST_PAGE_LABEL_EXPIRES, attr: EXPIRY_CARD_ATTR });
    return (cards || []).map((c, i) => ({ ...c, idx: i }));
  } catch (e) {
    console.log(`⚠️ 读取列表页卡片结构异常（不影响主任务）: ${e.message}`);
    return [];
  }
}

// 从多张卡片中按服务器名挑一张（名字对不上就兜底）
function pickExpiryCard(cards, serverName) {
  if (!cards.length) return null;
  if (serverName) {
    const hit = cards.find((c) => c.text.includes(serverName));
    if (hit) return hit;
    console.log(`⚠️ 列表页未找到名称含 "${serverName}" 的卡片（共 ${cards.length} 张）`);
  }
  if (cards.length === 1) return cards[0];
  console.log(`⚠️ 列表页存在 ${cards.length} 张服务器卡片且无法按名匹配，兜底取第 1 张（存在取错风险）`);
  return cards[0];
}

// 导航到列表页并读取指定服务器的剩余时间；任何失败都返回 null，不抛异常
async function fetchExpiryFromListPage(page, serverName) {
  try {
    console.log('📃 前往服务器列表页读取剩余时间...');
    await page.goto(LIST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await cleanPopup(page);

    const cards = await gatherExpiryCards(page);
    if (!cards.length) {
      console.log(`⚠️ 列表页未定位到任何含 "${LIST_PAGE_LABEL_EXPIRES}" 的服务器卡片，返回 null`);
      return null;
    }
    const card = pickExpiryCard(cards, serverName);
    if (!card) return null;

    let parsed = parseExpiryText(card.expiresText);
    if (!parsed) {
      // 兜底：从整卡文本里截取 EXPIRES IN 之后的片段再解析
      const at = card.text.toUpperCase().indexOf(LIST_PAGE_LABEL_EXPIRES);
      const tail = at >= 0 ? card.text.slice(at + LIST_PAGE_LABEL_EXPIRES.length).trim() : '';
      parsed = parseExpiryText(tail);
    }
    if (!parsed) {
      console.log(`⚠️ 列表页卡片 EXPIRES IN 数值解析失败，原始行文本="${card.expiresText}"`);
      return null;
    }
    console.log(`⏱️ 列表页读取到剩余时间: ${parsed.raw} (约 ${parsed.totalHours.toFixed(2)}h)`);
    return parsed;
  } catch (e) {
    console.log(`⚠️ 读取列表页剩余时间异常（不影响主任务）: ${e.message}`);
    return null;
  }
}

// 从详情页读取服务器名（best-effort，用于列表页按名匹配卡片；读不到返回 null）
async function readServerNameFromDetail(page) {
  try {
    const name = await page.evaluate(() => {
      const m = (document.body ? document.body.innerText : '').match(/\bFree-[A-Za-z0-9]{2,}\b/);
      return m ? m[0] : '';
    });
    if (name) console.log(`🏷️ 详情页读取到服务器名: ${name}`);
    return name || null;
  } catch (e) {
    return null;
  }
}

// 截取列表页包含 EXPIRES IN 的那张服务器卡片（续期成功后作为推送图片）
// 截不到卡片 → 退回全页截图；仍然失败 → 返回 null（调用方只发文字）
async function captureExpiryCard(page, serverName) {
  fs.mkdirSync('screenshots', { recursive: true });
  const savedScreenshot = path.join('screenshots', `expiry-${Date.now()}.png`);

  try {
    // 若当前还在详情页，先切到列表页
    if (page.url().includes('/app/servers/')) {
      await page.goto(LIST_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1200);
      await cleanPopup(page);
    }
    const cards = await gatherExpiryCards(page);
    const card = pickExpiryCard(cards, serverName);
    if (card) {
      const loc = page.locator(`[${EXPIRY_CARD_ATTR}="${card.idx}"]`).first();
      if (await loc.count().catch(() => 0)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.screenshot({ path: savedScreenshot });
        console.log(`📸 已截取列表页续期卡片: ${savedScreenshot}`);
        return savedScreenshot;
      }
    }
    console.log('⚠️ 未定位到续期卡片，退回全页截图');
  } catch (e) {
    console.log(`⚠️ 续期卡片截图异常，退回全页截图: ${e.message}`);
  }

  try {
    await page.screenshot({ path: savedScreenshot, fullPage: false });
    return savedScreenshot;
  } catch (e) {
    console.log(`⚠️ 全页截图也失败，本次仅发文字: ${e.message}`);
    return null;
  }
}

// 查找详情页是否出现续期按钮（站点自身阈值判定：出现=需要续期）
async function findRenewButton(page) {
  const selectors = [
    'button:has-text("Renew now")',
    '[role="button"]:has-text("Renew now")',
    'a:has-text("Renew now")'
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2500 }).catch(() => false)) return { el, sel };
  }
  return null;
}

// 安全截图（失败返回 null）
async function safeScreenshot(page, tag) {
  try {
    fs.mkdirSync('screenshots', { recursive: true });
    const p = path.join('screenshots', `${tag}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch (e) {
    return null;
  }
}

// 核心：以"续期按钮是否出现"作为站点阈值判定 —— 出现才续期
// 返回结构化结果 { renewNeeded, success, message, error }，由主流程决定是否推送：
//   error=true                          → 流程异常，必须推送错误
//   renewNeeded=false                   → 按钮未出现（租期充足），静默跳过、不推送
//   renewNeeded=true, success=true      → 续期成功（列表页剩余时间明显高于续期前基线）
//   renewNeeded=true, success=false/null→ 失败 / 已发指令但未确认，需推送
async function handleBillingRenew(page, listPage, serverName) {
  const result = { renewNeeded: false, success: null, message: '无需续期（续期按钮未出现）', error: false };
  try {
    console.log('👉 打开 PLAN/Billing 标签，检查是否出现续期按钮（以站点自身阈值为准）...');
    const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
    if (await billingTab.isVisible({ timeout: 4000 }).catch(() => false)) {
      await billingTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(2000);
      await cleanPopup(page);
    }

    const renewBtn = await findRenewButton(page);
    if (!renewBtn) {
      // 站点自己的阈值判定：按钮不出现 = 不需要续期。打印诊断便于人工确认选择器。
      const diag = await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('button,a,[role="button"]'))
            .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim())
            .filter((t) => /renew/i.test(t))
            .slice(0, 8)
        )
        .catch(() => []);
      console.log(`✅ 详情页未出现续期按钮 —— 站点判定租期充足，静默跳过（不推送）。含 "renew" 的元素: ${diag.length ? diag.join(' | ') : '无'}`);
      return result;
    }

    result.renewNeeded = true;
    console.log(`🎯 检测到续期按钮出现 (${renewBtn.sel}) —— 站点判定需要续期，开始执行...`);

    // 续期前基线：去列表页读一次剩余时间，供续期后做严谨的"前后对比"
    const baseline = await fetchExpiryFromListPage(listPage, serverName);
    const baseHours = baseline ? baseline.totalHours : null;
    console.log(
      baseline
        ? `📏 续期前基线剩余时间: ${baseline.raw} (约 ${baseHours.toFixed(2)}h)`
        : '⚠️ 未能读取续期前基线剩余时间（续期后只能依赖 RPC 判断，无法数值对比）'
    );

    // 打开续期弹窗
    await renewBtn.el.click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
    await cleanPopup(page);

    // 积累人机交互防刷时间 (8 秒)
    console.log('⏳ 弹窗停留缓冲 8 秒 (累积真人交互与防刷签名)...');
    for (let sec = 0; sec < 8; sec++) {
      await cleanPopup(page);
      await page.mouse.move(960 + sec * 5, 540 + sec * 3);
      await page.waitForTimeout(1000);
    }

    // 确保弹窗仍在显示
    const isModalVisible = await page.locator('text="Keep your server online"').isVisible().catch(() => false);
    if (!isModalVisible) {
      console.log('⚠️ 弹窗曾被异常关闭，重新拉起续期弹窗...');
      await renewBtn.el.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // 开启底层网络监听：确认真实的加时发包响应
    let actionRpcTriggered = false;
    const rpcCheck = async (res) => {
      const u = res.url();
      if (u.includes('_serverFn') && res.status() === 200) {
        try {
          const body = await res.text();
          if (!body.includes('feedback') && !body.includes('bonuses')) {
            actionRpcTriggered = true;
            console.log(`📡 抓取到实际加时 RPC 响应: ${u.substring(0, 50)}...`);
          }
        } catch (e) {}
      }
    };
    page.on('response', rpcCheck);

    console.log(`👉 启动多模态实体物理击发 [${RENEW_OPTION_TEXT}]...`);
    const targetOption = page.locator('div, button').filter({ hasText: new RegExp(`^${RENEW_OPTION_TEXT}`, 'i') }).last();
    await targetOption.waitFor({ state: 'visible', timeout: 8000 });
    await targetOption.scrollIntoViewIfNeeded().catch(() => {});

    // 方案 1: 真实鼠标物理点按
    const box = await targetOption.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
    }
    // 方案 2: 原生 click + 键盘 Enter / Space
    await targetOption.click({ delay: 80 }).catch(() => {});
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    // 方案 3: 触发父级表单直接提交
    await page.evaluate((opt) => {
      const cardEl = Array.from(document.querySelectorAll('*')).find((el) => (el.textContent || '').includes(opt));
      if (cardEl) {
        const form = cardEl.closest('form');
        if (form) form.requestSubmit();
        cardEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }, RENEW_OPTION_TEXT);

    // 等待发包确认
    for (let waitSec = 0; waitSec < 6; waitSec++) {
      if (actionRpcTriggered) break;
      await page.waitForTimeout(1000);
    }
    page.off('response', rpcCheck);

    console.log('⏳ 等待后端入库事务处理 (10 秒)...');
    await page.waitForTimeout(10000);
    await cleanPopup(page);

    // 续期后：回列表页抓一次最新剩余时间（用于报告与最终校验）
    const after = await fetchExpiryFromListPage(listPage, serverName);
    const afterHours = after ? after.totalHours : null;

    if (after) {
      if (baseHours != null) {
        if (afterHours > baseHours + 20) {
          result.success = true;
          result.message = `续期成功，列表页最新剩余时间: ${after.raw}（续期前基线 ${baseline.raw}）`;
        } else {
          result.success = false;
          result.message = `已发送续期指令但未确认入账：续期前 ${baseline.raw} → 续期后 ${after.raw}`;
        }
      } else if (actionRpcTriggered) {
        result.success = null;
        result.message = `已发送续期指令，列表页最新剩余时间: ${after.raw}（无续期前基线，未能数值比对，未确认入账）`;
      } else {
        result.success = false;
        result.message = `续期疑似未生效：列表页剩余时间 ${after.raw}，且未抓到加时 RPC`;
      }
    } else if (actionRpcTriggered) {
      result.success = null;
      result.message = '已发送续期指令，但未能读取续期后的剩余时间，无法确认是否入账';
    } else {
      result.success = false;
      result.message = '续期失败：未能读取续期后的剩余时间，且未抓到加时 RPC';
    }

    console.log(`🧾 续期判定: success=${result.success} :: ${result.message}`);
    return result;
  } catch (e) {
    console.log(`⚠️ 续期流程异常: ${e.message}`);
    result.error = true;
    result.success = false;
    result.message = `续期流程异常: ${e.message}`;
    return result;
  }
}

// 主任务入口
async function runOnce() {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = (process.env.FREE_PASSWORD || '').trim();
  const rawUrls = (process.env.SERVER_PAGE_URL || 'https://freemchost.com/app/servers/c63915c5-59b1-446a-8b77-9b2ea7bff9f2').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls.split(/[\r\n,]+/).map((u) => u.trim()).filter((u) => u.startsWith('http'));
  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失必要的账号或服务器地址配置');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();      // 详情页 / 主操作页
  const listPage = await context.newPage();  // 专用于列表页读取与截图
  const reports = [];
  let finalScreenshot = null;

  try {
    await doLogin(page, email, password);

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 处理第 [${sIndex}/${serverUrls.length}] 台服务器 =================`);

      // 1. 直接进详情页（不再去列表页做时间判定）
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 读取服务器名（best-effort，用于列表页按名匹配卡片）
      const serverName = await readServerNameFromDetail(page);

      // 2. 开机维护（保留原职责，与是否需要续期无关）
      await triggerStartServer(page);

      // 3. 续期：以站点是否出现续期按钮为准
      const res = await handleBillingRenew(page, listPage, serverName);

      if (res.error) {
        // 流程异常 → 推送错误
        console.error(`❌ 服务器 ${sIndex} 处理异常: ${res.message}`);
        const shot = await safeScreenshot(page, 'renew-error');
        if (!finalScreenshot && shot) finalScreenshot = shot;
        reports.push(`❌ <b>服务器 ${sIndex} 处理异常</b>\n${res.message}`);
        continue;
      }

      if (!res.renewNeeded) {
        // 续期按钮未出现 → 站点判定租期充足 → 静默，不推送任何消息
        console.log(`🔕 服务器 ${sIndex}: 未出现续期按钮，租期充足，静默跳过（不推送）`);
        continue;
      }

      if (res.success === true) {
        // 续期成功 → 推送成功消息 + 列表页续期卡片截图
        const shot = await captureExpiryCard(listPage, serverName);
        if (shot) finalScreenshot = shot;
        console.log(`✅ 服务器 ${sIndex}: ${res.message}`);
        reports.push(`✅ <b>服务器 ${sIndex} 续期成功</b>\n${res.message}`);
      } else {
        // 失败 / 已发指令但未确认 → 推送告警
        console.warn(`❌ 服务器 ${sIndex}: ${res.message}`);
        const shot = await safeScreenshot(page, 'renew-fail');
        if (!finalScreenshot && shot) finalScreenshot = shot;
        reports.push(`❌ <b>服务器 ${sIndex} 续期未成功/未确认</b>\n${res.message}`);
      }
    }

    // 4. 汇总推送：只有需要续期的服务器才进 reports
    if (reports.length > 0) {
      const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const summary =
        `🤖 <b>FreeMCHost 续期结果</b>\n\n` +
        reports.join('\n\n') + '\n\n' +
        `<b>策略:</b> 详情页出现续期按钮才续期（站点自身阈值），仅推送成功/失败\n` +
        `<b>完成时间:</b> ` + nowStr;
      await sendTG(tgToken, tgChatId, summary, finalScreenshot);
    } else {
      console.log('🔕 本次全部服务器均未出现续期按钮（租期充足），不推送任何消息。');
    }

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
    try {
      fs.mkdirSync('screenshots', { recursive: true });
      const errShot = path.join('screenshots', `error-${Date.now()}.png`);
      await page.screenshot({ path: errShot });
      await sendTG(tgToken, tgChatId, `⚠️ <b>FreeMCHost 巡检异常</b>:\n${err.message}`, errShot);
    } catch (_) {}
  } finally {
    await browser.close();
    console.log('🏁 任务顺利完成\n');
  }
}

if (require.main === module) {
  runOnce();
}

module.exports = { parseExpiryText, fetchExpiryFromListPage, handleBillingRenew, gatherExpiryCards };
