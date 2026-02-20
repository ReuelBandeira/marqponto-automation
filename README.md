# MarqPonto - Automação de Batida de Ponto

Automatiza o registro de ponto na plataforma **MarqPonto** com login simples, notificações por **Telegram** e controle de datas via bot.

## Funcionalidades

- Login automático no MarqPonto
- Registro automático do ponto
- **Bot Telegram** — receba notificações e controle o ponto pelo celular
- **Deploy em VPS** — execução via cron nativo, sem delay
- **GitHub Actions** — execução manual na nuvem (dispatch)
- Agendamento local via Windows Task Scheduler (opcional)
- **Modo Dry Run** — testa login sem clicar no botão de ponto
- **Retry automático** — até 3 tentativas com intervalo de 30s em caso de falha
- Logs em arquivo e console (rotativo, 5MB × 5 arquivos)
- **Limpeza mensal de logs** — remove arquivos em `logs/` com mais de 30 dias (rodada automaticamente na primeira execução de cada mês)
- Modo debug com screenshots

## Bot Telegram — Comandos

| Comando | Ação |
|---|---|
| `/desativar DD/MM/YYYY` | Pula o ponto nessa data |
| `/reativar DD/MM/YYYY` | Cancela um desativar |
| `/status` | Verifica se hoje está ativo |
| `/listar` | Mostra datas desativadas |

**Notificações automáticas:**
- ✅ Ponto registrado com sucesso
- ❌ Erro ao bater ponto (após 3 tentativas)
- ⚠️ Tentativa falhou, retentando em 30s
- ⏸️ Ponto desativado para hoje

> **Nota:** As datas desativadas são persistidas em um GitHub Gist, sem limite de tempo. Datas passadas são removidas automaticamente.

## Setup

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar credenciais

Copie o template e preencha com seus dados:

```bash
cp .env.example .env
```

Edite o `.env`:

```env
# Credenciais
MARQPONTO_USER=seu.email@empresa.com.br
MARQPONTO_PASS=sua_senha

# URLs do MarqPonto
LOGIN_URL=https://web.marqponto.com.br/
PONTO_URL=https://web.marqponto.com.br/clock-ins

# Telegram
TELEGRAM_BOT_TOKEN=token_do_botfather
TELEGRAM_CHAT_ID=seu_chat_id

# GitHub Gist
GH_GIST_TOKEN=token_com_scope_gist
GIST_ID=id_do_gist_secreto

# Geolocalização do escritório
GEO_LAT=-3.054679
GEO_LNG=-60.032772

# Apenas para VPS (deixe em branco localmente)
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

> **PUPPETEER_EXECUTABLE_PATH**: Necessário apenas em servidores Linux (DigitalOcean, Oracle Cloud, etc). Localmente e no GitHub Actions, deixe em branco — o Puppeteer usa o Chromium bundled.

> **Telegram**: Crie um bot com @BotFather e obtenha seu Chat ID com @userinfobot.

> **Gist**: Crie um token em github.com/settings/tokens/new (scope: gist) e um Gist secreto com arquivo `app-marqponto-disabled-dates.json` contendo `[]`.

> **Geolocalização**: Pegue as coordenadas no Google Maps (botão direito → copie as coordenadas do seu escritório).

### 3. Executar

```bash
# Modo normal (headless)
npm start

# Ver o browser aberto
npm run start:visible

# Debug (browser aberto + screenshots em logs/)
npm run debug

# Dry Run (faz tudo menos clicar no botão de ponto)
# Windows PowerShell:
$env:DRY_RUN="true"; node src/index.js
# Linux/Mac:
DRY_RUN=true node src/index.js
```

## Deploy em VPS (DigitalOcean, Oracle Cloud, etc.) — Recomendado

Método recomendado de execução — cron nativo, sem delay.

1. Crie uma VM com **Ubuntu 24.04 LTS** (mínimo 1GB RAM para Puppeteer)
2. Instale Node.js + Chromium:
   ```bash
   apt update && apt upgrade -y
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt install -y nodejs chromium-browser
   ```
3. Configure SSH key para o GitHub ([veja como](#configurar-ssh-key)):
   ```bash
   ssh-keygen -t ed25519 -C "seu@email.com" -f ~/.ssh/id_ed25519 -N ""
   cat ~/.ssh/id_ed25519.pub  # adicione em github.com → Settings → SSH keys
   ```
4. Clone e configure:
   ```bash
   cd /opt
   git clone git@github.com:<usuario>/<repo>.git app
   cd app
   npm ci
   cp .env.example .env
   nano .env  # preencha as variáveis + PUPPETEER_EXECUTABLE_PATH
   ```
5. Verifique o path do Chromium:
   ```bash
   which chromium-browser || which chromium
   # Use o resultado como valor de PUPPETEER_EXECUTABLE_PATH no .env
   ```
6. Teste antes de configurar o cron:
   ```bash
   DRY_RUN=true node src/index.js
   ```
7. Configure o cron (horários em UTC, Brasília = UTC-3):
   ```bash
   crontab -e
   # Adicione:
   0 13 * * 1-5 cd /opt/app && /usr/bin/node src/index.js >> /opt/app/logs/cron.log 2>&1
   0 16 * * 1-5 cd /opt/app && /usr/bin/node src/index.js >> /opt/app/logs/cron.log 2>&1
   0 17 * * 1-5 cd /opt/app && /usr/bin/node src/index.js >> /opt/app/logs/cron.log 2>&1
   0 22 * * 1-5 cd /opt/app && /usr/bin/node src/index.js >> /opt/app/logs/cron.log 2>&1
   ```

| Cron (UTC) | Brasília | Batida |
|---|---|---|
| 0 13 | 10:00 | Entrada |
| 0 16 | 13:00 | Saída almoço |
| 0 17 | 14:00 | Retorno almoço |
| 0 22 | 19:00 | Saída |

> **Dica:** Para alterar o fuso da VM para Brasília: `timedatectl set-timezone America/Sao_Paulo`


## GitHub Actions (execução automática e manual)

Permite rodar o ponto automaticamente na nuvem (GitHub) ou manualmente sob demanda.

### 1. Configuração dos secrets

No repositório, acesse **Settings → Secrets and variables → Actions** e adicione:

| Secret | Valor |
|---|---|
| `MARQPONTO_USER` | Seu e-mail MarqPonto |
| `MARQPONTO_PASS` | Sua senha |
| `LOGIN_URL` | URL de login do MarqPonto |
| `PONTO_URL` | URL da página de ponto |
| `TELEGRAM_BOT_TOKEN` | Token do bot |
| `TELEGRAM_CHAT_ID` | Seu Chat ID |
| `GH_GIST_TOKEN` | Token GitHub (scope: gist) |
| `GIST_ID` | ID do Gist secreto |
| `GEO_LAT` | Latitude do escritório (ex: `-3.054679`) |
| `GEO_LNG` | Longitude do escritório (ex: `-60.032772`) |
| `DRY_RUN` | (opcional) `true` para simular sem clicar |

### 2. Execução manual (dispatch)

Na aba **Actions** do GitHub, selecione o workflow "Batida de Ponto MarqPonto" e clique em **Run workflow** para executar sob demanda.

### 3. Execução automática (schedule)

Para ativar o agendamento automático, descomente o bloco `schedule` no arquivo `.github/workflows/ponto.yml` e ajuste os horários conforme desejado:

```yaml
on:
   schedule:
      - cron: '0 13 * * 1-5'  # 10:00 Brasília (Seg-Sex)
      - cron: '0 16 * * 1-5'  # 13:00 Brasília (Seg-Sex)
      - cron: '0 17 * * 1-5'  # 14:00 Brasília (Seg-Sex)
      - cron: '0 22 * * 1-5'  # 19:00 Brasília (Seg-Sex)
   workflow_dispatch:
```

> **Atenção:** O GitHub Actions pode atrasar execuções agendadas em até 60 minutos, especialmente em contas gratuitas. Para máxima confiabilidade, prefira rodar em VPS ou cron local.

## Agendamento local (Windows — opcional)

Execute como Administrador:

```powershell
powershell -ExecutionPolicy Bypass -File setup-schedule.ps1
```

Cria tarefas às 10:00, 13:00, 14:00 e 19:00 (Seg-Sex, horário de Brasília).

## Estrutura

```
├── .env.example              # Template de configuração
├── .github/
│   └── workflows/
│       └── ponto.yml         # GitHub Actions workflow (dispatch manual)
├── .gitignore
├── package.json
├── setup-schedule.ps1        # Agendamento Windows
├── README.md
└── src/
    ├── bot.js                # Comandos Telegram + verificação de datas
    ├── config.js             # Configurações centralizadas (.env)
    ├── gist-storage.js       # Persistência de datas desativadas via GitHub Gist
    ├── index.js              # Script principal (login → ponto + retry)
    ├── log-cleanup.js        # Limpeza mensal de arquivos em logs/ (retenção 30 dias)
    ├── logger.js             # Logger com Winston (console + arquivo rotativo)
    └── notify.js             # Notificações Telegram
```

## Troubleshooting

- **Seletores errados?** Execute com `npm run debug` e veja os screenshots em `logs/`
- **Timeout?** Aumente o valor de `timeout` em `src/config.js` (padrão: 60s)
- **Telegram "chat not found"?** Mande qualquer mensagem para o bot antes de usar
- **GitHub Actions falha?** Verifique os secrets e os logs na aba Actions
- **VPS: Chromium não encontrado?** Rode `which chromium-browser || which chromium` e ajuste `PUPPETEER_EXECUTABLE_PATH` no `.env`
- **VPS: Erro intermitente?** O retry automático tenta até 3 vezes. Verifique os logs em `/opt/app/logs/cron.log`
- **Botão de ponto não encontrado?** O script busca pelo ID `register-point-button`. Se a estrutura da página mudar, verifique os screenshots em modo debug.

## Aviso

Este script é para uso pessoal. Use com responsabilidade e de acordo com as políticas da sua empresa.
