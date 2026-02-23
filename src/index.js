const puppeteer = require('puppeteer');
const config = require('./config');
const logger = require('./logger');
const { notifySuccess, notifyError, sendTelegram } = require('./notify');
const { checkTelegramAndProcess } = require('./bot');
const { runMonthlyLogCleanup } = require('./log-cleanup');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitAndGet(page, selector, label = selector) {
  logger.info(`Aguardando "${label}" (${selector})...`);
  await page.waitForSelector(selector, { visible: true, timeout: config.timeout });
  return page.$(selector);
}

async function debugScreenshot(page, name) {
  if (!config.debug) return;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `logs/debug-${name}-${ts}.png`;
    await page.screenshot({ path, fullPage: true });
    logger.info(`Screenshot salva: ${path}`);
  } catch (err) {
    logger.warn(`Screenshot falhou (${name}): ${err.message}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retorna o horário da batida atual (10:00, 13:00, 14:00 ou 19:00) em Brasília. */
function getBatidaAtual() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const totalMinutes = hour * 60 + minute;
  if (totalMinutes < 12 * 60) return '10:00';   // entrada
  if (totalMinutes < 14 * 60) return '13:00';  // saída almoço
  if (totalMinutes < 15 * 60) return '14:00'; // retorno almoço
  return '19:00';                               // saída
}

// ---------------------------------------------------------------------------
// Etapa 1 — Login MarqPonto
// ---------------------------------------------------------------------------

async function login(page) {
  logger.info('Navegando para a página de login MarqPonto...');
  await page.goto(config.loginUrl, { waitUntil: 'networkidle2' });
  await debugScreenshot(page, '01-login-page');

  // Aguarda a página carregar completamente
  await sleep(3000);

  // Tenta encontrar o campo de e-mail/login
  // Pode variar dependendo da estrutura da página do MarqPonto
  const emailSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="login"]',
    '#email',
    '#username',
    '#login',
  ];

  let emailField = null;
  for (const selector of emailSelectors) {
    try {
      emailField = await page.$(selector);
      if (emailField) {
        const visible = await page.evaluate((el) => el.offsetParent !== null, emailField);
        if (visible) {
          logger.info(`Campo de e-mail encontrado: ${selector}`);
          break;
        }
        emailField = null;
      }
    } catch {
      // continua tentando
    }
  }

  if (!emailField) {
    throw new Error('Campo de e-mail não encontrado na página de login');
  }

  await emailField.click({ clickCount: 3 });
  await emailField.type(config.user, { delay: 30 });
  logger.info(`E-mail preenchido: ${config.user}`);
  await debugScreenshot(page, '02-email-filled');

  // Tenta encontrar o campo de senha
  const passSelectors = [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="pass"]',
    '#password',
    '#pass',
  ];

  let passField = null;
  for (const selector of passSelectors) {
    try {
      passField = await page.$(selector);
      if (passField) {
        const visible = await page.evaluate((el) => el.offsetParent !== null, passField);
        if (visible) {
          logger.info(`Campo de senha encontrado: ${selector}`);
          break;
        }
        passField = null;
      }
    } catch {
      // continua tentando
    }
  }

  if (!passField) {
    throw new Error('Campo de senha não encontrado na página de login');
  }

  await passField.type(config.password, { delay: 30 });
  logger.info('Senha preenchida');
  await debugScreenshot(page, '03-password-filled');

  // Tenta encontrar o botão de login (textos: "Access Account", "Acessar Conta", "Entrar", etc.)
  const loginSelectors = [
    'button[type="submit"]',
    'button.MuiButton-root', // Botões Material-UI
    'button.MuiButton-contained', // Botões Material-UI contained
    'input[type="submit"]',
    '[type="submit"]',
  ];

  const loginButtonTexts = ['entrar', 'login', 'acessar', 'access account', 'acessar conta'];

  let loginBtn = null;
  for (const selector of loginSelectors) {
    try {
      const elements = await page.$$(selector);
      for (const el of elements) {
        const visible = await page.evaluate((e) => e.offsetParent !== null, el);
        if (visible) {
          // Verifica o texto do botão
          const text = await page.evaluate((e) => {
            // Remove spans e outros elementos filhos para pegar só o texto
            const clone = e.cloneNode(true);
            const spans = clone.querySelectorAll('span');
            spans.forEach(s => s.remove());
            return clone.textContent.trim().toLowerCase();
          }, el);
          const match = loginButtonTexts.some((t) => text.includes(t));
          if (match) {
            loginBtn = el;
            logger.info(`Botão de login encontrado: ${selector} (texto: "${text}")`);
            break;
          }
        }
      }
      if (loginBtn) break;
    } catch {
      // continua tentando
    }
  }

  if (!loginBtn) {
    // Tenta encontrar por texto em todos os botões e links
    const candidates = await page.$$('button, a[href], input[type="submit"]');
    for (const el of candidates) {
      const tag = await page.evaluate((e) => e.tagName.toLowerCase(), el);
      const text = tag === 'input'
        ? await page.evaluate((e) => (e.value || '').trim().toLowerCase(), el)
        : await page.evaluate((e) => {
            // Remove spans e outros elementos filhos para pegar só o texto
            const clone = e.cloneNode(true);
            const spans = clone.querySelectorAll('span');
            spans.forEach(s => s.remove());
            return clone.textContent.trim().toLowerCase();
          }, el);
      const match = loginButtonTexts.some((t) => text.includes(t));
      if (match) {
        const visible = await page.evaluate((e) => e.offsetParent !== null, el);
        if (visible) {
          loginBtn = el;
          logger.info(`Botão de login encontrado por texto: "${text}"`);
          break;
        }
      }
    }
  }

  if (!loginBtn) {
    throw new Error('Botão de login não encontrado');
  }

  await loginBtn.click();
  logger.info('Botão de login clicado — aguardando redirecionamento...');

  // Aguarda redirecionamento após login
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: config.timeout });
  await sleep(3000);
  await debugScreenshot(page, '04-login-complete');
  logger.info(`Login concluído. URL atual: ${page.url()}`);
}

// ---------------------------------------------------------------------------
// Etapa 2 — Registrar ponto
// ---------------------------------------------------------------------------

async function registrarPonto(page) {
  logger.info('Navegando para a página de ponto...');
  await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
  await sleep(5000); // SPA pode demorar
  await debugScreenshot(page, '05-ponto-page');

  // Log da URL atual e HTML parcial para diagnóstico
  logger.info(`URL atual: ${page.url()}`);
  const pageTitle = await page.title();
  logger.info(`Título da página: ${pageTitle}`);

  // Busca o botão pelo ID específico: register-point-button
  // IMPORTANTE: Não usar busca por texto, pois há dois botões com o mesmo texto "Marcar Ponto"
  const buttonId = 'register-point-button';
  logger.info(`Buscando botão com ID: ${buttonId}`);

  try {
    // Aguarda o botão aparecer
    await page.waitForSelector(`#${buttonId}`, { visible: true, timeout: config.timeout });
    const button = await page.$(`#${buttonId}`);
    
    if (!button) {
      throw new Error(`Botão com ID ${buttonId} não encontrado`);
    }

    const visible = await page.evaluate((el) => el.offsetParent !== null, button);
    if (!visible) {
      throw new Error(`Botão com ID ${buttonId} não está visível`);
    }

    // Clica no botão
    await button.click();
    logger.info(`Botão de ponto clicado (ID: ${buttonId})`);

    logger.info('Aguardando confirmação de sucesso: "Registro confirmado"...');
    await page.waitForFunction(
      () => {
        const root = document.body || document.documentElement;
        const text = (root?.innerText || root?.textContent || '').toLowerCase();
        // Observação: às vezes a UI inclui espaço no final ("Registro confirmado ")
        return text.includes('registro confirmado');
      },
      { timeout: config.timeout }
    );

    await sleep(500);
    await debugScreenshot(page, '06-ponto-registrado');
    logger.info('Confirmação encontrada: "Registro confirmado".');
    return true;
  } catch (err) {
    logger.error(`Erro ao encontrar/clicar no botão ${buttonId}: ${err.message}`);
    
    // Se não encontrou, faz log do HTML para diagnóstico
    try {
      const html = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
      logger.info(`HTML da página (primeiros 3000 chars):\n${html}`);
    } catch (e) {
      logger.warn(`Não foi possível capturar HTML: ${e.message}`);
    }

    await debugScreenshot(page, '06-ponto-NAO-encontrado');
    logger.error(
      `Não foi possível encontrar o botão de registrar ponto com ID ${buttonId}. ` +
        'Verifique os logs para diagnóstico.'
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Executa o fluxo completo (login → ponto)
// ---------------------------------------------------------------------------

async function executar() {
  const browser = await puppeteer.launch({
    headless: config.headless,
    slowMo: config.slowMo,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1366,768',
      ...(process.env.CI ? [] : ['--remote-debugging-port=9222']),
    ],
    defaultViewport: { width: 1366, height: 768 },
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Simula geolocalização para o MarqPonto aceitar a batida de ponto
  // Geolocalização varia por dia da semana conforme configurado no .env
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
  let geoLat, geoLng;
  
  if (dayOfWeek >= 1 && dayOfWeek <= 3) {
    // Segunda (1), Terça (2), Quarta (3)
    geoLat = config.geoLatSegTerQua;
    geoLng = config.geoLngSegTerQua;
    logger.info('Usando geolocalização para Segunda/Terça/Quarta');
  } else if (dayOfWeek >= 4 && dayOfWeek <= 5) {
    // Quinta (4), Sexta (5)
    geoLat = config.geoLatQuiSex;
    geoLng = config.geoLngQuiSex;
    logger.info('Usando geolocalização para Quinta/Sexta');
  } else {
    // Fim de semana - usa padrão (Quinta/Sexta)
    geoLat = config.geoLatQuiSex;
    geoLng = config.geoLngQuiSex;
    logger.info('Fim de semana - usando geolocalização padrão (Quinta/Sexta)');
  }

  const context = browser.defaultBrowserContext();
  await context.overridePermissions('https://web.marqponto.com.br', ['geolocation']);
  await page.setGeolocation({ latitude: geoLat, longitude: geoLng });
  logger.info(`Geolocalização definida: ${geoLat}, ${geoLng}`);

  try {
    await login(page);

    if (config.dryRun) {
      logger.info('🧪 DRY RUN — login OK, navegando para página de ponto sem clicar...');
      await page.goto(config.pontoUrl, { waitUntil: 'networkidle2', timeout: config.timeout });
      await sleep(5000);
      await debugScreenshot(page, '05-ponto-page-dryrun');
      logger.info(`URL do ponto: ${page.url()}`);
      const prefixDryRun = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
      await sendTelegram(`${prefixDryRun}🧪 <b>DRY RUN</b> — Login + navegação OK. Botão de ponto <b>não clicado</b>.`);
      logger.info('=== DRY RUN concluído com sucesso ===');
    } else {
      const pontoOk = await registrarPonto(page);
      if (pontoOk) {
        await notifySuccess();
        logger.info('=== Automação concluída com sucesso ===');
      } else {
        await notifyError('Botão de registrar ponto não encontrado');
        throw new Error('Botão de registrar ponto não encontrado');
      }
    }
  } finally {
    if (!config.debug) {
      await browser.close();
      logger.info('Browser fechado');
    } else {
      logger.info('Modo debug: browser permanece aberto para inspeção');
    }
  }
}

// ---------------------------------------------------------------------------
// Main — com retry automático (até 3 tentativas, intervalo de 30s)
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAY = 30_000; // 30 segundos

async function main() {
  logger.info('=== Iniciando automação de ponto MarqPonto ===');

  const now = new Date();
  const horaLocal = now.toLocaleString('pt-BR', { timeZoneName: 'short' });
  logger.info(`Hora local atual (browser/runner): ${horaLocal}`);

  await runMonthlyLogCleanup();

  if (!config.user || !config.password) {
    logger.error('MARQPONTO_USER e MARQPONTO_PASS devem estar definidos no arquivo .env');
    process.exit(1);
  }

  // Processa comandos do Telegram e verifica se hoje está desativado
  const todayDisabled = await checkTelegramAndProcess();

  if (todayDisabled) {
    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const batida = getBatidaAtual();
    logger.info(`Ponto desativado para hoje (${today}) — pulando batida ${batida}`);
    const prefixDisabled = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
    await sendTelegram(`${prefixDisabled}⏸️ Ponto <b>desativado</b> para hoje (${today}) — execução pulada ${batida}`);
    return;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Tentativa ${attempt}/${MAX_RETRIES}...`);
      await executar();
      return; // sucesso, encerra
    } catch (err) {
      logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
        await sendTelegram(
          `${prefix}⚠️ Tentativa ${attempt}/${MAX_RETRIES} falhou: <code>${err.message}</code>\n🔄 Retentando em 30s...`
        );
        await sleep(RETRY_DELAY);
      } else {
        await notifyError(`Falha após ${MAX_RETRIES} tentativas: ${err.message}`);
        throw err;
      }
    }
  }
}

main().catch((err) => {
  logger.error(`Falha fatal: ${err.message}`);
  process.exit(1);
});
