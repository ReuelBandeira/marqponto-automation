const https = require('https');
const config = require('./config');
const logger = require('./logger');
const { sendTelegram } = require('./notify');
const gist = require('./gist-storage');

/**
 * Busca mensagens pendentes do Telegram e confirma o offset,
 * pois agora a persistência é feita via Gist (sem depender de mensagens ficarem pendentes).
 */
async function getUpdates() {
  const url = `https://api.telegram.org/bot${config.telegramToken}/getUpdates?timeout=0`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) resolve(json.result || []);
          else resolve([]);
        } catch {
          resolve([]);
        }
      });
    }).on('error', () => resolve([]));
  });
}

/**
 * Confirma mensagens processadas avançando o offset.
 */
async function confirmUpdates(updateId) {
  const url = `https://api.telegram.org/bot${config.telegramToken}/getUpdates?offset=${updateId + 1}&timeout=0`;
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', () => { });
      res.on('end', () => resolve());
    }).on('error', () => resolve());
  });
}

/**
 * Extrai data DD/MM/YYYY de um texto
 */
function parseDate(text) {
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return null;
  const [, day, month, year] = match;
  const d = parseInt(day), m = parseInt(month), y = parseInt(year);
  if (d < 1 || d > 31 || m < 1 || m > 12 || y < 2024) return null;
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

/**
 * Retorna a data de hoje no formato DD/MM/YYYY (fuso Brasília)
 */
function getToday() {
  return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Manaus' });
}

/**
 * Prefixo dos comandos a partir de SISTEMA_PONTO (ex.: "Irede" → "irede", comandos /irede_desativar)
 */
function getComandoPrefix() {
  if (!config.sistemaPonto || !config.sistemaPonto.trim()) return '';
  return config.sistemaPonto.trim().toLowerCase().replace(/\s+/g, '_');
}

/**
 * Processa mensagens do Telegram e persiste no Gist.
 * 
 * Lógica:
 * - Lê mensagens pendentes do Telegram
 * - Processa comandos /desativar e /reativar gravando no Gist
 * - Confirma (avança) o offset após processar
 * - Verifica se hoje está desativado consultando o Gist
 * 
 * @returns {boolean} true se hoje está desativado
 */
async function checkTelegramAndProcess() {
  if (!config.telegramToken || !config.telegramChatId) {
    logger.info('Telegram não configurado — comandos ignorados');
    return false;
  }

  // Limpa datas passadas do Gist
  await gist.cleanupPastDates();

  logger.info('Verificando mensagens do Telegram...');
  const updates = await getUpdates();


  let maxUpdateId = 0;
  let processedCount = 0;
  let shouldConfirmOffset = false;

  // Estado local das datas desativadas (evita reler o Gist logo após gravar)
  let localDisabledDates = await gist.getDisabledDates();

  if (updates.length > 0) {
    for (const update of updates) {
      const msg = update.message;
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;

      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(config.telegramChatId)) continue;

      const rawCmd = msg.text.trim().toLowerCase().replace(/^\//, '');
      const cmdPrefix = getComandoPrefix();

      // Se SISTEMA_PONTO está definido, só processa comandos com prefixo (ex.: irede_desativar)
      let cmd = rawCmd;
      if (cmdPrefix) {
        const prefixWithUnderscore = cmdPrefix + '_';
        if (!rawCmd.startsWith(prefixWithUnderscore) && rawCmd !== cmdPrefix) continue; // ignora mensagens de outros sistemas
        cmd = rawCmd === cmdPrefix ? '' : rawCmd.slice(prefixWithUnderscore.length);
      }

      let reply = null;
      const prefix = config.sistemaPonto ? `${config.sistemaPonto} - ` : '';
      const cmdExemplo = cmdPrefix ? `/${cmdPrefix}_` : '/';

      if (cmd.startsWith('desativar')) {
        const dateStr = parseDate(msg.text);
        if (!dateStr) {
          reply = `${prefix}⚠️ Formato inválido.\nUse: <code>${cmdExemplo}desativar DD/MM/YYYY</code>`;
        } else if (localDisabledDates.includes(dateStr)) {
          continue;
        } else {
          await gist.disableDate(dateStr);
          localDisabledDates.push(dateStr);
          reply = `${prefix}⏸️ Ponto <b>desativado</b> para ${dateStr}`;
          shouldConfirmOffset = true;
        }
      } else if (cmd.startsWith('reativar')) {
        const dateStr = parseDate(msg.text);
        if (!dateStr) {
          reply = `${prefix}⚠️ Formato inválido.\nUse: <code>${cmdExemplo}reativar DD/MM/YYYY</code>`;
        } else {
          const removed = await gist.enableDate(dateStr);
          if (removed) {
            localDisabledDates = localDisabledDates.filter((d) => d !== dateStr);
          }
          reply = removed
            ? `${prefix}▶️ Ponto <b>reativado</b> para ${dateStr}`
            : `${prefix}ℹ️ ${dateStr} já estava ativo`;
          shouldConfirmOffset = true;
        }
      } else if (cmd.startsWith('status')) {
        const today = getToday();
        reply = localDisabledDates.includes(today)
          ? `${prefix}⏸️ Hoje (${today}) está <b>desativado</b>`
          : `${prefix}▶️ Hoje (${today}) está <b>ativo</b>`;
        shouldConfirmOffset = true;
      } else if (cmd.startsWith('listar')) {
        if (localDisabledDates.length === 0) {
          reply = `${prefix}📋 Nenhuma data desativada`;
        } else {
          const list = localDisabledDates.map((d) => `  • ${d}`).join('\n');
          reply = `${prefix}📋 <b>Datas desativadas:</b>\n${list}`;
        }
        shouldConfirmOffset = true;
      } else {
        reply = `${prefix}🤖 <b>Comandos disponíveis:</b>\n\n` +
          `<code>${cmdExemplo}desativar DD/MM/YYYY</code> — Pula o ponto nessa data\n` +
          `<code>${cmdExemplo}reativar DD/MM/YYYY</code> — Cancela um desativar\n` +
          `<code>${cmdExemplo}status</code> — Verifica se hoje está ativo\n` +
          `<code>${cmdExemplo}listar</code> — Mostra datas desativadas`;
        shouldConfirmOffset = true;
      }

      if (reply) {
        await sendTelegram(reply);
        processedCount++;
      }
    }

    // Só confirma o offset se processou algum comando novo
    if (shouldConfirmOffset && maxUpdateId > 0) {
      await confirmUpdates(maxUpdateId);
      logger.info(`Offset avançado para ${maxUpdateId + 1}`);
    }
  }

  // Usa o estado local (em memória) para verificar se hoje está desativado
  const today = getToday();
  const todayDisabled = localDisabledDates.includes(today);

  logger.info(`Mensagens recebidas: ${updates.length}, processadas: ${processedCount}`);
  logger.info(`Hoje (${today}) desativado: ${todayDisabled}`);
  return todayDisabled;
}

module.exports = { checkTelegramAndProcess };
