const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

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

// 提取当前实时的倒计时数据
async function extractExpiryTime(page, maxTries = 5) {
  for (let retry = 0; retry < maxTries; retry++) {
    const result = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      const header = allEls.find(el => el && el.textContent && el.textContent.trim().toUpperCase().includes('TIME UNTIL EXPIRY'));
      if (header) {
        let container = header.parentElement;
        for (let k = 0; k < 4; k++) {
          if (container) {
            const txt = container.innerText || '';
            const m = txt.match(/(\d{1,3})\s*\n?\s*D[\s\S]*?(\d{1,2})\s*\n?\s*H[\s\S]*?(\d{1,2})\s*\n?\s*M/i);
            if (m) {
              const d = parseInt(m[1], 10);
              const h = parseInt(m[2], 10);
              const min = parseInt(m[3], 10);
              return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
            }
            container = container.parentElement;
          }
        }
      }

      const bodyText = document.body ? (document.body.innerText || '') : '';
      const m = bodyText.match(/(\d{1,3})\s*D\s*(\d{1,2})\s*H\s*(\d{1,2})\s*M/i);
      if (m) {
        const d = parseInt(m[1], 10);
        const h = parseInt(m[2], 10);
        const min = parseInt(m[3], 10);
        return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
      }
      return null;
    });

    if (result) return result;
    await page.waitForTimeout(1000);
  }
  return null;
}

// 精准截取倒计时小卡片
async function captureExpiryCard(page) {
  fs.mkdirSync('screenshots', { recursive: true });
  const savedScreenshot = path.join('screenshots', `billing-${Date.now()}.png`);

  try {
    const cardBox = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('*'));
      const target = els.find(el => (el.textContent || '').trim().toUpperCase().includes('TIME UNTIL EXPIRY') && el.children.length === 0);
      if (!target) return null;

      let p = target.parentElement;
      for (let i = 0; i < 4 && p; i++) {
        const txt = p.innerText || '';
        if (txt.includes('TIME UNTIL EXPIRY') && (txt.includes('Renews on demand') || txt.includes('D'))) {
          const r = p.getBoundingClientRect();
          if (r.width > 100 && r.height > 40) {
            return { x: r.x, y: r.y, width: Math.min(r.width, 275), height: r.height };
          }
        }
        p = p.parentElement;
      }
      const rect = target.getBoundingClientRect();
      return { x: rect.x - 5, y: rect.y - 5, width: 260, height: 110 };
    });

    if (cardBox && cardBox.width > 0 && cardBox.height > 0) {
      await page.screenshot({
        path: savedScreenshot,
        clip: {
          x: Math.max(0, cardBox.x),
          y: Math.max(0, cardBox.y),
          width: cardBox.width + 12,
          height: cardBox.height + 8
        }
      });
      console.log(`📸 已成功截取精准倒计时小卡片: ${savedScreenshot}`);
      return savedScreenshot;
    }
  } catch (e) {
    console.log('⚠️ 精确小图截取异常，使用全页备选截屏:', e.message);
  }

  await page.screenshot({ path: savedScreenshot, fullPage: false });
  return savedScreenshot;
}

// 核心租期核对、多模态续期击发及数据回验
async function handleBillingRenew(page) {
  let savedScreenshot = null;
  try {
    console.log('👉 切换至 PLAN Billing 页面核对租期...');
    const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
    if (await billingTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await billingTab.click({ force: true });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 1. 获取当前实时剩余时间
      let timeData = await extractExpiryTime(page);
      let remainHours = timeData ? timeData.totalHours : 99;
      let rawStr = timeData ? timeData.raw : '未获取到';
      console.log(`⏱️ 当前租期剩余时长: ${rawStr} (约 ${remainHours.toFixed(1)}h)`);

      let renewStatus = '';

      if (remainHours < 46) {
        console.log(`🎯 租期低于 46 小时 (${remainHours.toFixed(1)}h)，打开续期弹窗...`);
        const renewNowBtn = page.locator('button:has-text("Renew now")').first();
        await renewNowBtn.click({ force: true });
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
          console.log('⚠️ 弹窗曾被异常关闭，重新拉起 Renew now...');
          await renewNowBtn.click({ force: true });
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

        console.log('👉 启动多模态实体物理击发 [60 hours]...');
        const targetOption = page.locator('div, button').filter({ hasText: /^60 hours/i }).last();
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
        await page.evaluate(() => {
          const cardEl = Array.from(document.querySelectorAll('*')).find(el => (el.textContent || '').includes('60 hours'));
          if (cardEl) {
            const form = cardEl.closest('form');
            if (form) form.requestSubmit();
            cardEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        });

        // 等待发包确认
        for (let waitSec = 0; waitSec < 6; waitSec++) {
          if (actionRpcTriggered) break;
          await page.waitForTimeout(1000);
        }
        page.off('response', rpcCheck);

        console.log('⏳ 等待后端入库事务处理 (10 秒)...');
        await page.waitForTimeout(10000);
        await cleanPopup(page);

        // 修正：严禁清除 localStorage/sessionStorage（避免掉登录态）
        // 原地重新加载页面获取最新落库数据
        console.log('🔄 原地刷新页面获取加时后的最新落库数据...');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await cleanPopup(page);

        // 切回 Billing 标签
        const tabRecheck = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
        await tabRecheck.scrollIntoViewIfNeeded().catch(() => {});
        await tabRecheck.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
        await cleanPopup(page);

        const finalTimeData = await extractExpiryTime(page, 5);
        const finalTime = finalTimeData ? finalTimeData.raw : '未获取到';
        const finalHours = finalTimeData ? finalTimeData.totalHours : remainHours;

        console.log(`⏱️ 终审核验结果: 前序 ${rawStr} ➔ 数据库实际存留: ${finalTime}`);

        if (finalHours > remainHours + 20) {
          console.log('🎉 终审通过：数据库已确实入账！');
          renewStatus = `成功续期 (+60h)，最新剩余: ${finalTime}`;
        } else {
          // 如果时间因为 UI 渲染延迟未变，但 RPC 已经确认发包
          if (actionRpcTriggered) {
            renewStatus = `已发送续期指令 (+60h)，当前显示: ${finalTime}`;
          } else {
            renewStatus = `⚠️ 未检测到有效加时 (当前剩余: ${finalTime})`;
          }
        }
      } else {
        renewStatus = `剩余 ${rawStr} (租期充足无需加时)`;
      }

      // 无论是否续期，最后均对页面当前的最新倒计时卡片截取精准小图
      savedScreenshot = await captureExpiryCard(page);
      return { status: renewStatus, screenshot: savedScreenshot };
    }
  } catch (e) {
    console.log(`⚠️ 租期核对异常: ${e.message}`);
  }
  return { status: '核对未完成', screenshot: savedScreenshot };
}

// 主任务入口
async function runOnce() {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = (process.env.FREE_PASSWORD || '').trim();
  const rawUrls = (process.env.SERVER_PAGE_URL || 'https://freemchost.com/app/servers/c63915c5-59b1-446a-8b77-9b2ea7bff9f2').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls.split(/[\r\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
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

  const page = await context.newPage();
  let reports = [];
  let finalScreenshot = null;

  try {
    await doLogin(page, email, password);

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 处理第 [${sIndex}/${serverUrls.length}] 台服务器 =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 1. 开机维护 (主三角键 + Standard start)
      await triggerStartServer(page);

      // 2. 检查租期、执行 60h 实体物理点击续期，并截取最新的倒计时卡片
      const billRes = await handleBillingRenew(page);
      if (billRes.screenshot) {
        finalScreenshot = billRes.screenshot;
      }

      reports.push(
        `🖥️ <b>服务器 ${sIndex}</b>:\n` +
        `   ⚡ <b>开机维护</b>: 已触发开机指令 (Standard Start)\n` +
        `   📅 <b>长效租期</b>: ${billRes.status}`
      );
    }

    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const summary =
      `🤖 <b>FreeMCHost 巡检完成</b>\n\n` +
      reports.join('\n\n') + '\n\n' +
      `<b>策略:</b> 开机指令维持 + 46h门槛自动续期\n` +
      `<b>完成时间:</b> ` + nowStr;

    await sendTG(tgToken, tgChatId, summary, finalScreenshot);

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

(async () => {
  await runOnce();
})();
