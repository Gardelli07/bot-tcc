require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const net = require('net');
const fs = require('fs');
const child = require('child_process');
const path = require('path');
const os = require('os');
const https = require('https');
const connections = require('./connections');
// CATALOGO (catalog_items.json) — carga e utilidades
function tryLoadCatalog() {
  const candidates = [
    path.join(__dirname, 'catalog_items.json'),
    path.join(process.cwd(), 'catalog_items.json'),
    path.join(__dirname, 'catalog', 'catalog_items.json'),
    path.join(process.cwd(), 'catalog', 'catalog_items.json')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const obj = JSON.parse(raw);
        smallLog('catalog_items.json carregado de', p, 'itens:', Object.keys(obj).length);
        return obj;
      }
    } catch (e) {
      smallLog('Erro lendo catalog_items.json em', p, e && e.message ? e.message : e);
    }
  }
  smallLog('catalog_items.json não encontrado — comportamentos de busca de item ficarão limitados.');
  return {};
}
const CATALOG = tryLoadCatalog();

function normalizeString(s) {
  if (!s) return '';
  // remover acentos, transformar em maiúsculas e normalizar espaços
  const noAcc = s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
  return noAcc.toString().trim().toUpperCase().replace(/\s+/g, ' ');
}

function findCatalogMatch(userText) {
  // devolve { key, price } se encontrou, ou null
  if (!userText) return null;
  const norm = normalizeString(userText);

  // exact match first
  for (const k of Object.keys(CATALOG)) {
    if (normalizeString(k) === norm) return { key: k, price: CATALOG[k] };
  }
  // contains match (catalog key contains userText) or vice-versa
  for (const k of Object.keys(CATALOG)) {
    const nk = normalizeString(k);
    if (nk.includes(norm) || norm.includes(nk)) return { key: k, price: CATALOG[k] };
  }
  // token match: try each token of userText and match catalog
  const tokens = norm.split(' ').filter(Boolean);
  for (const k of Object.keys(CATALOG)) {
    const nk = normalizeString(k);
    let matches = 0;
    for (const t of tokens) if (nk.includes(t)) matches++;
    if (matches >= Math.max(1, Math.floor(tokens.length/2))) return { key: k, price: CATALOG[k] };
  }
  return null;
}

function parseQuantityAndItem(text) {
  // retorna { qty: Number, itemText: String }
  if (!text) return { qty: 1, itemText: '' };
  const s = text.trim();
  // Padrão A: "2x ITEM" ou "2 x ITEM" ou "2× ITEM"
  let m = s.match(/^\s*(\d+)\s*[xX×]\s*(.+)$/);
  if (m) return { qty: parseInt(m[1], 10), itemText: m[2].trim() };
  // Padrão B: "ITEM x2" ou "ITEM x 2"
  m = s.match(/^(.+?)\s*[xX×]\s*(\d+)\s*$/);
  if (m) return { qty: parseInt(m[2], 10), itemText: m[1].trim() };
  // Padrão C: "2 ITEM" (numero seguido de espaço)
  m = s.match(/^\s*(\d+)\s+(.+)$/);
  if (m) return { qty: parseInt(m[1], 10), itemText: m[2].trim() };
  // Padrão D (novo): "x2 ITEM" ou "×2 ITEM" ou "X2ITEM" (x antes do número)
  m = s.match(/^\s*[xX×]\s*(\d+)\s*(.+)$/);
  if (m) return { qty: parseInt(m[1], 10), itemText: m[2].trim() };
  // Padrão E: "qty:2" ou "q=2"
  m = s.match(/(?:qty|q|quantidade)\s*[:=]\s*(\d+)/i);
  if (m) {
    const itemOnly = s.replace(m[0], '').trim();
    return { qty: parseInt(m[1], 10), itemText: itemOnly || '' };
  }
  // fallback: qty 1, item = texto bruto
  return { qty: 1, itemText: s };
}

// Defina o chat do atendente (ex: '5511999999999@c.us' ou '5511999999999@g.us')
const STAFF_CHAT_ID = process.env.STAFF_CHAT_ID || null;

// ID do grupo para pedidos confirmados (pode vir de env). Se não definido, usa STAFF_CHAT_ID como fallback.
const CONFIRMED_GROUP_ID = process.env.CONFIRMED_GROUP_ID || process.env.PEDIDOS_CONFIRMADOS_ID || null;

// NOVO: ID do grupo onde as dúvidas dos usuários serão enviadas
const DUVIDAS_GROUP_ID = process.env.DUVIDAS_GROUP_ID || null;

// logger
function smallLog(...args) { console.log(...args); }

// UTIL: ViaCEP lookup
function lookupCepRaw(cep) {
  return new Promise((resolve) => {
    const clean = (cep || '').replace(/\D/g, '').slice(0, 8);
    if (clean.length !== 8) return resolve(null);
    const url = `https://viacep.com.br/ws/${clean}/json/`;

    const req = https.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.erro) return resolve(null);
          resolve({
            cep: json.cep,
            logradouro: json.logradouro,
            complemento: json.complemento,
            bairro: json.bairro,
            localidade: json.localidade,
            uf: json.uf
          });
        } catch (e) { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function formatAddressFromCep(obj) {
  if (!obj) return '';
  const parts = [];
  if (obj.logradouro) parts.push(obj.logradouro);
  if (obj.bairro) parts.push(obj.bairro);
  const cityState = [obj.localidade, obj.uf].filter(Boolean).join(' - ');
  if (cityState) parts.push(cityState);
  if (obj.cep) parts.push(`CEP: ${obj.cep}`);
  return parts.join(', ');
}
// CATALOGO: localizar imagens
function resolveCatalogFiles() {
  const filenames = [
    'variedades.jpg',
    'variedades (2).jpg',
    'ração.jpg',
    'ração (2).jpg',
    'cereal.jpg',
    'cereal (2).jpg'
  ];

  const found = [];
  const candidateDirs = [
    path.join(__dirname, 'catalog'),
    path.join(process.cwd(), 'catalog'),
    __dirname,
    process.cwd(),
    '/mnt/data'
  ];

  for (const dir of candidateDirs) {
    for (const fn of filenames) {
      const p = path.join(dir, fn);
      try { if (fs.existsSync(p)) found.push(p); } catch(_) {}
    }
  }
  return Array.from(new Set(found));
}

// CRIA CLIENTE E HANDLERS
function createClient(puppeteerOptions) {
  const client = new Client({ authStrategy: new LocalAuth(), puppeteer: puppeteerOptions });
  
 // --- TRACKER FINAL: distinguir mensagens programáticas de mensagens digitadas manualmente ---
const programmaticSent = new Set();
const _origSendMessage = client.sendMessage.bind(client);

client.sendMessage = async function(...args) {
  const to      = args[0];
  const content = args[1];
  const options = args[2];

  // tentativa normal: envia e tenta extrair id do retorno
  let res;
  try {
    res = await _origSendMessage(...args);
  } catch (err) {
    // se o envio falhar, rethrow para o chamador tratar
    throw err;
  }

  // 1) se a lib retornou o objeto Message com id, registra e sai
  try {
    const id = res && res.id && res.id._serialized ? res.id._serialized : null;
    if (id) {
      programmaticSent.add(id);
      // cleanup automático
      setTimeout(() => programmaticSent.delete(id), 120 * 1000);
      return res;
    }
  } catch (e) { /* ignore e continue para fallback */ }

  // 2) fallback: tentaremos capturar a mensagem criada pelo cliente via evento message_create
  // deduzir um "bodyGuess" para casar por texto (se aplicável)
  let bodyGuess = '';
  if (typeof content === 'string') bodyGuess = content;
  else if (content && content.body) bodyGuess = content.body;
  else if (options && options.caption) bodyGuess = options.caption || '';

  // gerar um uid temporário para este envio (apenas p/ debug)
  const debugUid = Math.random().toString(36).slice(2,9);

  // listener temporário
  const capture = (m) => {
    try {
      const mid = m && m.id && m.id._serialized ? m.id._serialized : null;
      const mFrom = (m.from || '').toString();
      const mTo   = (m.to   || '').toString();
      const outgoing = !!m.fromMe; // true para mensagens originadas por esta sessão

      // comparar destin/origem com o "to" usado no sendMessage
      const toId = String(to || '').trim();

      // normalizar pequenas variações (telefone sem sufixo @c.us)
      const norm = s => (s || '').replace(/@c\.us$/i, '');

      const sameChat =
        (toId && (norm(mTo) === norm(toId) || norm(mFrom) === norm(toId))) ||
        // também aceitar caso mensagem esteja marcada como enviada para a própria sessão
        (toId && (norm(mTo) === norm(toId.replace(/@c\.us$/i, '')) || norm(mFrom) === norm(toId.replace(/@c\.us$/i, ''))));

      const textMatches = bodyGuess ? ((m.body || '') === bodyGuess) : true;

      // DEBUG: mostrar tentativa de captura (comente/remova depois)
      smallLog(`[capture ${debugUid}] mid:${mid} fromMe:${outgoing} mFrom:${mFrom} mTo:${mTo} sameChat:${sameChat} textMatches:${textMatches}`);

      // condição para marcar como programática:
      // - a mensagem foi criada por esta sessão (outgoing === true)
      // - e é para o mesmo chat (sameChat) e (se houver bodyGuess) o texto bate (textMatches)
      if (mid && outgoing && sameChat && textMatches) {
        programmaticSent.add(mid);
        setTimeout(() => programmaticSent.delete(mid), 120 * 1000);
        client.removeListener('message_create', capture);
      }
    } catch (e) {
      /* ignore */
    }
  };

  // instala listener temporário e o remove após timeout
  client.on('message_create', capture);
 setTimeout(() => {
  try { client.removeListener('message_create', capture); } catch(_) {}
}, 8000); // 8s é generoso; ajuste se quiser

  // devolve o resultado original já que o envio foi feito
  return res;
};
// --- fim TRACKER FINAL ---

  client.on('qr', qr => qrcode.generate(qr, { small: true }));
    let SELF_ID = null;

  client.on('ready', () => {
    smallLog('=== BOT PRONTO ===');
    try {
      // armazenar o id serializado do próprio número para reconhecer mensagens enviadas "por nós"
      if (client && client.info && client.info.wid && client.info.wid._serialized) {
        SELF_ID = client.info.wid._serialized;
        smallLog('SELF_ID definido como', SELF_ID);
      }
    } catch (e) {
      smallLog('Não conseguiu obter SELF_ID:', e && e.message ? e.message : e);
    }
  });

  // memória simples de estado por usuário
  let userState = {}; // { '5515...@c.us': { etapa: 'menu_principal'|'handoff'|..., dados:{...} } }

    // ------------------ LOG DE MENSAGENS (msgcli / msgbot / msgadm) ------------------
  // Mantém logs na memória (pode persistir em arquivo/DB se quiser)
  const messageLogs = {}; // { chatId: [ { type:'msgcli'|'msgbot'|'msgadm', body, from, id, ts } ] }

  function saveMsgLog(chatId, type, payload) {
    try {
      if (!chatId) return;
      if (!messageLogs[chatId]) messageLogs[chatId] = [];
      messageLogs[chatId].push({
        type: type,
        body: (payload && payload.body) ? payload.body : (typeof payload === 'string' ? payload : ''),
        from: (payload && payload.from) ? payload.from : (payload && payload.author) ? payload.author : null,
        id: (payload && payload.id) ? payload.id : null,
        ts: new Date().toISOString()
      });
      // opcional: truncar tamanho (ex: manter últimas 200 mensagens)
      const MAX = 500;
      if (messageLogs[chatId].length > MAX) messageLogs[chatId].splice(0, messageLogs[chatId].length - MAX);
    } catch (e) {
      smallLog('saveMsgLog erro:', e && e.message ? e.message : e);
    }
  }
  // ------------------ fim saveMsgLog ------------------


function dentroHorario() {
  try {
    const s = new Date().toLocaleString('pt-BR', { 
      timeZone: 'America/Sao_Paulo', 
      hour12: false, 
      hour: '2-digit' 
    });
    const hour = parseInt(s, 10);
    return hour >= 0 && hour <= 23; // inclui até 23h59
  } catch (e) { 
    return true; 
  }
}

  // catálogo
  const catalogFiles = resolveCatalogFiles();
  if (catalogFiles.length) smallLog('Imagens de catálogo encontradas:', catalogFiles);
  else smallLog('Nenhuma imagem de catálogo encontrada — fallback para texto.');

  // envia menu primário (forçado)
  async function sendPrimaryMenu(to) {
    if (!userState[to]) userState[to] = { etapa: "inicio", dados: {} };
    userState[to].etapa = "menu_principal";
    await client.sendMessage(to,
      "👋 Bem-vindo!\nEscolha uma opção:\n\n" +
      "1️⃣ Ver Catálogo\n" +
      "2️⃣ Fazer Orçamento\n" +
      "3️⃣ Tirar Dúvidas\n" +
      "4️⃣ Acessar Site\n\n" +
      "Responda apenas com o número da opção."
    );
  }

// envia imagens do catálogo (na conversa do usuário) — sem legenda, uma por uma
async function sendCatalogImages(to) {
  if (!catalogFiles.length) {
    await client.sendMessage(to, "\nSe quiser voltar ao menu inicial, só digitar \"menu\".");
    return;
  }

  const failed = []; // índices 1-based que falharam
  const sent = [];   // índices 1-based enviados com sucesso

  for (let i = 0; i < catalogFiles.length; i++) {
    const filePathRaw = catalogFiles[i];
    const filePath = path.resolve(filePathRaw); // usa caminho absoluto
    try {
      if (!fs.existsSync(filePath)) {
        smallLog('Arquivo não encontrado (catalog):', filePath);
        failed.push(i + 1);
        continue;
      }

      let media;
      try {
        media = MessageMedia.fromFilePath(filePath);
      } catch (e) {
        smallLog('Erro MessageMedia.fromFilePath:', filePath, e && e.message ? e.message : e);
        failed.push(i + 1);
        continue;
      }

      // tenta enviar e observa o resultado
      try {
        await client.sendMessage(to, media, { caption: '' });
        // sucesso: registra apenas na lista 'sent' (sem imprimir no console)
        sent.push(i + 1);
      } catch (errSend) {
        smallLog('Erro ao enviar (client.sendMessage):', filePath, errSend && errSend.message ? errSend.message : errSend);
        if (!sent.includes(i + 1)) failed.push(i + 1);
      }

      // delay inline para evitar sobrecarga
      await new Promise(resolve => setTimeout(resolve, 400));
    } catch (err) {
      smallLog('Erro inesperado ao processar arquivo do catálogo:', filePath, err && err.message ? err.message : err);
      if (!sent.includes(i + 1)) failed.push(i + 1);
    }
  }

  // resumo final: relatório coerente com o que realmente aconteceu
  if (failed.length === 0) {
    await client.sendMessage(to, "✅ Enviamos o catálogo completo. Deseja fazer um orçamento? \nResponda com *2* para iniciar o orçamento.\n\nSe quiser voltar ao menu inicial, só digitar \"menu\".");
  } else if (sent.length === 0) {
    await client.sendMessage(to, `⚠️ Não foi possível enviar nenhuma das páginas: ${failed.join(', ')}.\nVerifique os arquivos do catálogo no servidor e as permissões.`).catch(()=>{});
  } else {
    await client.sendMessage(to, `⚠️ Não foi possível enviar as páginas: ${failed.join(', ')}.\nEnviamos as páginas: ${sent.join(', ')}.`).catch(()=>{});
  }
}

function formatAddressForSummary(dados) {
  const info = dados._lastCepInfo_edit || dados._lastCepInfo || null;

  if (info) {
    const cepDigits = (info.cep || '').replace(/\D/g, '');
    const numero = dados.numero || '';
    const complemento = (dados.complemento && String(dados.complemento).trim()) || (info.complemento && String(info.complemento).trim()) || '';

    // linha 1: logradouro + número (ex: "Rua X 158")
    const line1 = [info.logradouro || '', numero].filter(Boolean).join(' ').trim();

    // linha 2: bairro + complemento (se houver). separador por " - " para ficar legível
    const line2Parts = [];
    if (info.bairro) line2Parts.push(info.bairro);
    if (complemento) line2Parts.push(`Compl.: ${complemento}`);
    const line2 = line2Parts.join(' - ');

    // linha 3: cidade, UF e CEP
    const cityUf = [info.localidade || '', info.uf || ''].filter(Boolean).join(', ');
    const line3 = cityUf + (cepDigits ? ' ' + cepDigits : '');

    return [line1, line2, line3].filter(Boolean).join('\n');
  }

  // se o endereço já foi preenchido manualmente (string), manteir o comportamento anterior
  if (dados.endereco && typeof dados.endereco === 'string' && dados.endereco.trim()) {
    if (dados.endereco.includes('\n')) return dados.endereco.trim();
    return dados.endereco.split(',').map(s => s.trim()).filter(Boolean).join('\n');
  }

  return '(não informado)';
}
async function sendOrderSummary(to, estado) {
  const d = estado.dados || {};
  const qty = Number(d.quantidade) || 1;
  const addrText = formatAddressForSummary(d);
  const lines = [
    '🧾 *Resumo do Orçamento*',
    `Nome: ${d.nome || '(não informado)'}`,
    `Item: ${d.item || '(não informado)'}`,
    `Quantidade: ${qty}`,
    `Endereço:\n${addrText}`,
    `Entrega: ${d.entrega || '(não informado)'}`,
    `Pagamento: ${d.pagamento || '(não informado)'}`
  ];
  const options = [
    '',
    'Confirme as informações:',
    '1️⃣ Registrar Orçamento',
    '2️⃣ Editar Nome',
    '3️⃣ Editar Item/Quantidade',
    '4️⃣ Editar Endereço',
    '5️⃣ Editar Pagamento',
    '0️⃣ Cancelar / Voltar',
    '',
    'Responda com o número da opção desejada.'
  ];
  const text = lines.join('\n\n') + '\n\n' + options.join('\n') + '\n\nSe quiser voltar ao menu inicial, só digitar "menu".';
  await client.sendMessage(to, text);
  estado.etapa = 'pedido_confirm';
}


// Gera texto simplificado do pedido para envio ao grupo (sem opções de edição)
function buildOrderReportForGroup(dados, from) {
  const d = dados || {};
  const lines = [
    '🧾 *Novo Orçamento Confirmado*',
    `De: ${from}`,
    `Nome: ${d.nome || '(não informado)'}`,
    `Item: ${d.item || (d.itemKey ? `${d.quantidade || 1} x ${d.itemKey}` : '(não informado)')}`,
    `Quantidade: ${d.quantidade || 1}`,
    '---',
    `Endereço: ${d.endereco || '(não informado)'}`,
    `Entrega: ${d.entrega || '(não informado)'}`,
    `Pagamento: ${d.pagamento || '(não informado)'}`
  ];
  return lines.join('\n');
}

  client.on('message', async msg => {
    try {
      const from = msg.from; // chat id (user or staff)
      const textRaw = (msg.body || '').trim();
      const text = textRaw.toLowerCase();

     // ------------- substitua/insira esta versão do bloco de comandos -------------
let chat = null;
try { chat = await msg.getChat(); } catch (e) { /* ignore */ }


// chatAtual = id do chat onde o comando foi escrito (pode ser grupo ou conversa direta)
const chatAtual = (chat && chat.id && chat.id._serialized) ? chat.id._serialized : (msg.to || msg.from);

// --- GRAVAÇÃO AUTOMÁTICA: classifica a mensagem e salva no messageLogs ---
try {
  const chatId = (chat && chat.id && chat.id._serialized) ? chat.id._serialized : (msg.to || msg.from);
  const mid = (msg.id && msg.id._serialized) ? msg.id._serialized : null;
  const isProg = mid ? programmaticSent.has(mid) : false;
  if (msg.fromMe) {
    // mensagem originada por esta sessão (pode ser programática ou digitada manualmente)
    if (isProg) {
      saveMsgLog(chatId, 'msgbot', { body: msg.body || '', from: msg.from || null, id: mid });
    } else {
      saveMsgLog(chatId, 'msgadm', { body: msg.body || '', from: msg.from || null, id: mid });
    }
  } else {
    // mensagem do cliente
    saveMsgLog(chatId, 'msgcli', { body: msg.body || (msg.caption || '') || '<mídia sem texto>', from: msg.from || null, id: mid });
  }
} catch (e) {
  smallLog('Erro ao salvar log automático da mensagem:', e && e.message ? e.message : e);
}
// --- fim gravação automática ---


// cmd raw (preserva possíveis números)
const cmd = (textRaw || '').trim();

// se o comando inclui um número (ex: "!handoff 5515991386482"), use esse número como alvo
let targetChat = chatAtual;
const phoneMatch = cmd.match(/(\d{10,13})/); // captura 10..13 dígitos (ajuste se precisar)
if (phoneMatch) {
  const phone = phoneMatch[1].replace(/\D/g, '');
  // construir id padrão de chat individual
  targetChat = `${phone}@c.us`;
  smallLog('Comando contém telefone — targetChat forçado para', targetChat);
}

// Considera comando do atendente se: msg.fromMe OR mensagem veio do nosso número (SELF_ID)

// identificar mensagens programáticas vs digitadas manualmente
const msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : null;
const isProgrammatic = msgId ? programmaticSent.has(msgId) : false;

// fromMe = mensagem originada por esta sessão (pode ser programática OU digitada manualmente)
const fromMeFlag = !!msg.fromMe || (SELF_ID && (msg.from === SELF_ID || ((chat && chat.id && chat.id._serialized) === SELF_ID)));

// typedBySelf = true apenas se a mensagem for fromMe E NÃO for uma mensagem que nosso código enviou
const typedBySelf = fromMeFlag && !isProgrammatic;

smallLog('flags => msgId:', msgId, 'fromMeFlag:', fromMeFlag, 'isProgrammatic:', isProgrammatic, 'typedBySelf:', typedBySelf, 'SELF_ID:', SELF_ID);


// manter um sinal simples caso queiras distinguir depois:
// - mensagens vindas de outros números: !fromMeFlag
// - mensagens digitadas nesta sessão: typedBySelf
// - mensagens enviadas pelo código: isProgrammatic

if (typedBySelf && targetChat) {
  // agora processa comandos normalmente (p.ex. /^!handoff\b/i.test(cmd))
  if (/^!handoff\b/i.test(cmd)) {
    if (!userState[targetChat]) userState[targetChat] = { etapa: 'handoff', dados: {} };
    else userState[targetChat].etapa = 'handoff';
    userState[targetChat].dados._handoffBy = 'atendente_via_sessao';
    smallLog(`Handoff ativado para ${targetChat} (comando !handoff).`);
    if (STAFF_CHAT_ID && STAFF_CHAT_ID !== targetChat) {
      client.sendMessage(STAFF_CHAT_ID, `✋ Handoff ativado para ${targetChat} pelo atendente.`);
    }
    return;
  }

  if (/^!bot\b/i.test(cmd)) {
    userState[targetChat] = { etapa: 'inicio', dados: {} };
    smallLog(`Handoff desativado para ${targetChat} (comando !bot).`);
    try {
      await client.sendMessage(targetChat, '🤖 O atendimento automático foi retomado. Qualquer dúvida, pode perguntar!');
    } catch (e) {
      smallLog('Erro ao notificar usuário sobre retorno do bot:', e && e.message ? e.message : e);
    }
    return;
  }
}

// ----------------- BLOCO REPARADO: processamento de comandos com debug e regra simplificada -----------------
try {
  // normaliza allowed staff
  const ALLOWED_STAFF = (process.env.ALLOWED_STAFF || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => (/@(c|g)\.us$/.test(s) ? s : (s.replace(/\D/g,'' ) + '@c.us')));

  // quem realmente "assinou" a mensagem (quando aplicável)
  const senderId = msg.fromMe ? (SELF_ID || msg.from) : (msg.author || msg.from);

  // debug rápido (remova depois)
  smallLog('[CMD DEBUG] senderId:', senderId, 'msg.from:', msg.from, 'msg.author:', msg.author, 'chatAtual:', chatAtual);

  async function resolveTargetFromCmd(cmd, msg) {
    try {
      if (msg.hasQuotedMsg) {
        const quoted = await msg.getQuotedMessage().catch(()=>null);
        if (quoted && quoted.from) return quoted.from;
        if (quoted && quoted.author) return quoted.author;
      }
    } catch(e) {}
    const m = (cmd || '').match(/(\d{10,15})(?:@c\.us|@g\.us)?/);
    if (m && m[1]) return `${m[1]}@c.us`;

    // se for mensagem digitada na sessão, o chat atual é o alvo (chatAtual variável definida mais acima)
    if (chatAtual && chatAtual !== SELF_ID) return chatAtual;

    // fallback null
    return null;
  }

  // identificar staff (inclui operador local SELF_ID)
  const isStaffSender = (
    (STAFF_CHAT_ID && (msg.from === STAFF_CHAT_ID || msg.to === STAFF_CHAT_ID || senderId === STAFF_CHAT_ID)) ||
    ALLOWED_STAFF.includes(senderId) ||
    (senderId === SELF_ID)
  );

  const msgIdLocal = (msg.id && msg.id._serialized) ? msg.id._serialized : null;
  const isProgLocal = msgIdLocal ? programmaticSent.has(msgIdLocal) : false;
  const typedBySelfLocal = !!msg.fromMe && !isProgLocal;

  smallLog('[CMD DEBUG] typedBySelfLocal:', typedBySelfLocal, 'isProgLocal:', isProgLocal, 'isStaffSender:', isStaffSender);

  // se começar com ! ou / e for de staff ou digitado na sessão, tratar comandos
  if ((typedBySelfLocal || isStaffSender) && (textRaw.startsWith('!') || textRaw.startsWith('/'))) {
    const shortCmd = textRaw.split(/\s+/)[0].toLowerCase();

    // HANDOFF
    if (/^(!handoff|\/handoff)$/i.test(shortCmd)) {
      const target = await resolveTargetFromCmd(textRaw, msg);
      if (!target) {
        await client.sendMessage(msg.from, '⚠️ Indique o número alvo: !handoff 551599XXXXXXX ou responda/quote a mensagem do usuário e envie !handoff.');
        return;
      }

      userState[target] = userState[target] || { etapa: 'handoff', dados: {} };
      userState[target].etapa = 'handoff';
      userState[target].dados._handoffBy = senderId || msg.from || 'staff';
      smallLog(`Handoff ativado para ${target} por ${senderId || msg.from}`);

      await client.sendMessage(msg.from, `✔️ Handoff ativado para ${target}. O bot vai parar de automatizar esse chat.`);
      if (STAFF_CHAT_ID && STAFF_CHAT_ID !== msg.from) {
        client.sendMessage(STAFF_CHAT_ID, `✋ Handoff: ${senderId || msg.from} assumiu ${target}`).catch(()=>{});
      }
      return;
    }

    // BOT: reativar
    if (/^(!bot|\/bot)$/i.test(shortCmd)) {
      const target = await resolveTargetFromCmd(textRaw, msg) || (typedBySelfLocal ? chatAtual : null);
      if (!target) {
        await client.sendMessage(msg.from, '⚠️ Indique o número alvo: !bot 551599XXXXXXX ou responda/quote a mensagem do usuário e envie !bot.');
        return;
      }
      userState[target] = { etapa: 'inicio', dados: {} };
      smallLog(`Handoff desativado para ${target} por ${senderId || msg.from}`);
      await client.sendMessage(msg.from, `🤖 Automação reativada para ${target}.`);
      try { await client.sendMessage(target, '🤖 O atendimento automático foi retomado. Qualquer dúvida, pode perguntar!'); } catch(e){ /* ignore */ }
      return;
    }

    // list-handoffs
    if (/^(!list-handoffs|\/list-handoffs)$/i.test(shortCmd)) {
      const keys = Object.keys(userState).filter(k => userState[k] && userState[k].etapa === 'handoff');
      await client.sendMessage(msg.from, `Handoffs ativos: ${keys.length ? keys.join('\n') : '(nenhum)'}`);
      return;
    }
  }
} catch (e) {
  smallLog('Erro no bloco de comandos simplificado:', e && e.message ? e.message : e);
}
// ----------------- fim bloco commands -----------------



      // --- se for mensagem de cliente
      // garante estado
      if (!userState[from]) userState[from] = { etapa: 'inicio', dados: {} };
      const estado = userState[from];
      
      if (estado.etapa === 'done') {
      userState[from] = { etapa: 'inicio', dados: {} };
      await sendPrimaryMenu(from);
      return;
      }
      // se o usuário digitar "menu" em qualquer momento: reset e forçar menu primário
      if (text === 'menu') {
        userState[from] = { etapa: 'inicio', dados: {} };
        await client.sendMessage(from, 'Voltando ao menu inicial...');
        await sendPrimaryMenu(from);
        return;
      }

      // Handoff ativo: quando um atendente assumir (etapa = 'handoff'), o bot ignora automações
if (estado.etapa === 'handoff') {
  smallLog('Usuário', from, 'está em atendimento humano — ignorando automações do bot.');

  // 1) garantir que a mensagem do cliente já foi registrada (msgcli)
  try {
    const mid = (msg.id && msg.id._serialized) ? msg.id._serialized : null;
    saveMsgLog(from, 'msgcli', { body: msg.body || (msg.caption || '') || '<mídia sem texto>', from: msg.from || null, id: mid });
  } catch (e) { /* ignore */ }

  // 2) encaminhar/avisar equipe (se STAFF_CHAT_ID estiver configurado)
  if (STAFF_CHAT_ID) {
    try {
      if (msg.id && msg.id._serialized) {
        // tenta encaminhar fielmente (inclui mídia)
        await client.forwardMessages(STAFF_CHAT_ID, [msg.id._serialized], from);
      } else {
        // fallback textual
        await client.sendMessage(STAFF_CHAT_ID, `✋ Mensagem de ${from}:\n${msg.body || '<mídia/sem texto>'}`);
      }
    } catch (e) {
      // fallback / aviso de erro
      try { await client.sendMessage(STAFF_CHAT_ID, `✋ (falha no forward) Mensagem de ${from}:\n${msg.body || '<mídia/sem texto>'}`); } catch(_) {}
      smallLog('Erro ao encaminhar mensagem para staff:', e && e.message ? e.message : e);
    }
  }

  // não processar automação enquanto handoff estiver ativo
  return;
}


      // estado: inicio -> enviar menu primario
      if (estado.etapa === 'inicio') {
        if (!dentroHorario()) {
          await msg.reply('⏰ Estamos fora do horário de atendimento (08h–18h). Tente mais tarde.');
          return;
        }
        await sendPrimaryMenu(from);
        return;
      }

      // MENU PRINCIPAL
      if (estado.etapa === 'menu_principal') {
        if (text === '1' || text.includes('catalog')) {
          await msg.reply('📦 Enviando o catálogo...');
          await sendCatalogImages(from);
          // permanece no menu
          return;
        }
        if (text === '2') {
          await msg.reply('📝 Para começar o orçamento, informe o *nome do cliente/loja*:');
          estado.etapa = 'pedido_nome';
          estado.dados = {};
          return;
        }
        if (text === '3') {
          await msg.reply('❓ Dúvidas:\n1️⃣ Dúvidas recentes (FAQ)\n2️⃣ Escrever nova dúvida\n0️⃣ Voltar');
          estado.etapa = 'duvidas';
          return;
        }
        if (text === '4') {
          await msg.reply('🌐 Nosso site: https://seudominio.com\n\nSe quiser voltar ao menu inicial, só digitar "menu".');
          estado.etapa = 'fim';
          return;
        }
        if (/pedido|comprar|quero/.test(text)) {
          await msg.reply('📝 Para começar o orçamento, informe o *nome do cliente/loja*:');
          estado.etapa = 'pedido_nome';
          estado.dados = {};
          return;
        }
        await msg.reply('Não entendi. Responda com 1, 2, 3 ou 4.');
        return;
      }

      // PEDIDO flow with CEP -> confirmação -> número/complemento OR manual
      if (estado.etapa === 'pedido_nome') {
        estado.dados.nome = msg.body || '';
        await msg.reply('Informe o *quantidade e item*:\nexemplo: "2x MILHO MOÍDO 24 KG" ou "MILHO MOÍDO 24 KG"');
        estado.etapa = 'pedido_item';
        return;
      }

      if (estado.etapa === 'pedido_item') {
        const body = (msg.body || '').trim();
        estado.dados.itemRaw = body; // guarda o texto cru

        // parsear quantidade + item
        const parsed = parseQuantityAndItem(body);
        estado.dados.quantidade = parsed.qty || 1;
        const itemText = (parsed.itemText || parsed.itemText === '') ? parsed.itemText : body;

        // transformar em MAIÚSCULAS para consulta mais assertiva
        const itemTextUpper = String(itemText).toUpperCase();
        estado.dados.itemRawUpper = itemTextUpper;

        // procurar no catálogo usando a versão em maiúsculas (o find também normaliza)
        const match = findCatalogMatch(itemTextUpper);
        if (!match) {
          // item não encontrado
          await client.sendMessage(from,
            '❗ Não encontrei esse item no catálogo.\n' +
            'Digite o item exatamente como está no catálogo (ex: "MILHO MOÍDO 24 KG") e, se quiser, informe a quantidade antes (ex: "2x MILHO MOÍDO 24 KG").\n'
          );
          estado.etapa = 'pedido_item'; // mantém na mesma etapa
          return;
        }

  // item encontrado — salvar chave canônica (mantemos preço internamente se quiser usar depois)
estado.dados.itemKey = match.key;
estado.dados.item = `${estado.dados.quantidade} x ${match.key}`;

  // SE estiver vindo de uma edição (flag), volta ao resumo sem pedir CEP
if (estado._editingItem) {
  delete estado._editingItem;
  await client.sendMessage(from, `✔️ Item atualizado: ${estado.dados.item}`);
  await sendOrderSummary(from, estado);
  return;
}

  // fluxo normal (novo pedido): pede CEP como antes
  await client.sendMessage(from,
    `✔️ Item registrado: ${estado.dados.item}\n\n` +
    'Agora, Digite o *CEP* (8 dígitos, somente números):'
  );
  estado.etapa = 'pedido_cep';
  return;
}

// Recebe o CEP -> consulta ViaCEP
if (estado.etapa === 'pedido_cep') {
  const cepRaw = (msg.body || '').trim();
  const cepDigits = cepRaw.replace(/\D/g, '').slice(0, 8);
  if (cepDigits.length !== 8) {
    await msg.reply('CEP inválido. Digite o CEP com 8 dígitos (ex: 12345678).');
    return;
  }

  await msg.reply('🔎 Consultando endereço pelo CEP...');
  const cepInfo = await lookupCepRaw(cepDigits);
  estado.dados._lastCepAttempt = cepDigits;
  estado.dados._lastCepInfo = cepInfo || null;

  if (!cepInfo) {
    // NÃO oferecer opção de endereço manual — pedir para reenviar o CEP
    await msg.reply('CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos).');
    estado.etapa = 'pedido_cep'; // permanece na mesma etapa esperando novo CEP
    return;
  }

  const addrText = formatAddressFromCep(cepInfo);
  // envia o endereço encontrado e pede confirmação (apenas confirmar ou tentar outro CEP)
  await client.sendMessage(
    from,
    `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (informar número e complemento)\n2️⃣ Tentar outro CEP`
  );
  estado.etapa = 'pedido_cep_confirm';
  return;
}

// Confirmação após mostrar CEP (sem opção manual)
if (estado.etapa === 'pedido_cep_confirm') {
  const opt = (msg.body || '').trim();

  // confirmação direta
  if (opt === '1' || /^sim|confirm/i.test(opt.toLowerCase())) {
    const info = estado.dados._lastCepInfo;
    if (!info) {
      await client.sendMessage(from, 'Erro interno: informação de CEP ausente. Por favor digite o CEP novamente:');
      estado.etapa = 'pedido_cep';
      return;
    }
    // define parte do endereço (sem número/complemento)
    const base = formatAddressFromCep(info);
    estado.dados.endereco = base; // ainda sem número/complemento
    await client.sendMessage(from, '📍Ótimo, agora envie o *número* da residência/loja:');
    estado.etapa = 'pedido_numero';
    return;
  }

  // tentar outro CEP
  if (opt === '2') {
    await client.sendMessage(from, 'Ok. Digite o CEP novamente:');
    estado.etapa = 'pedido_cep';
    return;
  }

  // se pessoa enviou outro CEP diretamente
  const possibleCep = (msg.body || '').replace(/\D/g, '').slice(0, 8);
  if (possibleCep.length === 8) {
    const cepInfo = await lookupCepRaw(possibleCep);
    estado.dados._lastCepAttempt = possibleCep;
    estado.dados._lastCepInfo = cepInfo || null;

    if (!cepInfo) {
      await client.sendMessage(from, 'CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos).');
      estado.etapa = 'pedido_cep';
      return;
    }

    const addrText = formatAddressFromCep(cepInfo);
    await client.sendMessage(from, `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (informar número e complemento)\n2️⃣ Tentar outro CEP`);
    estado.etapa = 'pedido_cep_confirm';
    return;
  }

  await client.sendMessage(from, 'Opção inválida. Responda 1 (correto) ou envie um CEP válido com 8 dígitos.');
  return;
}

      // Recebe o número (após confirmar CEP)
      if (estado.etapa === 'pedido_numero') {
        const numero = (msg.body || '').trim();
        estado.dados.numero = numero;
        await client.sendMessage(from, 'Se tiver complemento, envie agora (ex: "Apto 101" ou "sem"):');
        estado.etapa = 'pedido_complemento';
        return;
      }

        if (estado.etapa === 'pedido_complemento') {
          const complemento = (msg.body || '').trim();
          estado.dados.complemento = complemento && complemento.toLowerCase() !== 'sem' ? complemento : '';
          // ajusta campo endereco final juntando base + número + complemento
          const base = estado.dados.endereco || (estado.dados._lastCepInfo ? formatAddressFromCep(estado.dados._lastCepInfo) : '');
          const parts = [base];
          if (estado.dados.numero) parts.push(`Nº ${estado.dados.numero}`);
          if (estado.dados.complemento) parts.push(`Compl.: ${estado.dados.complemento}`);
          estado.dados.endereco = parts.filter(Boolean).join(', ');

          // sem opção de retirada — definimos por padrão Delivery e seguimos para pagamento
          estado.dados.entrega = 'Fretado';
          await client.sendMessage(from, 'Método de pagamento (Pix/Dinheiro/Boleto/Depósito Bancário/Cheque):');
          estado.etapa = 'pedido_pagamento';
          return;
        }


      // ... restante do fluxo (pedido_entrega e pedido_pagamento continuam iguais)
      if (estado.etapa === 'pedido_pagamento') {
        estado.dados.pagamento = msg.body || '';
        // envia resumo e pede confirmação/edição
        await sendOrderSummary(from, estado);
        return;
      }

      // etapa: pedido_confirm -> interpreta escolha do usuário
      if (estado.etapa === 'pedido_confirm') {
      if (text === '1' || /^confirm/i.test(text) || /^sim/i.test(text)) {
  await client.sendMessage(from, `✅ Orçamento confirmado e registrado!\n\nObrigado! Em breve entraremos em contato.\n\nSe quiser voltar ao menu inicial, só digitar "menu".`);

  // enviar resumo do orçamento para o grupo (fazemos em background, sem enviar nada mais ao usuário)
  (async () => {
    try {
      const targetGroup = CONFIRMED_GROUP_ID || STAFF_CHAT_ID;
      if (targetGroup) {
        const report = buildOrderReportForGroup(estado.dados || {}, from);
        await client.sendMessage(targetGroup, report);
      } else {
        smallLog('Nenhum CONFIRMED_GROUP_ID configurado — orçamento não enviado a grupo.');
      }
    } catch (e) {
      smallLog('Erro ao enviar resumo para grupo de orçamentos:', e && e.message ? e.message : e);
    }
  })();
  userState[from] = { etapa: 'done', dados: {} };
  return;
}



        // editar campos: 2..5 (5 agora é editar pagamento)
        if (text === '2') { await client.sendMessage(from, '✏️ OK — envie o *novo nome* (nome do cliente/loja):'); estado.etapa = 'pedido_edit_nome'; return; }
        if (text === '3') {
          await client.sendMessage(from, '✏️ OK — envie o *novo item e quantidade* (ex: "2x MILHO MOÍDO 24 KG" ou "x2 MILHO MOIDO 24KG"):');
          estado.etapa = 'pedido_item';
          estado._editingItem = true; 
          return;
        }
        if (text === '4') {
          await client.sendMessage(from, '✏️ Para alterar o endereço, informe o *CEP* (somente números):');
          estado.etapa = 'pedido_cep_edit';
          estado.dados._lastCepAttempt_edit = null;
          estado.dados._lastCepInfo_edit = null;
          return;
        }
        if (text === '5') { await client.sendMessage(from, '✏️ OK — envie o *novo método de pagamento* (Pix/Dinheiro/Boleto/Depósito Bancário/Cheque):'); estado.etapa = 'pedido_edit_pagamento'; return; }

        // cancelar
        if (text === '0' || text === 'cancel' || text === 'cancelar') {
          userState[from] = { etapa: 'inicio', dados: {} };
          await client.sendMessage(from, 'Orçamento cancelado. Voltando ao menu inicial...');
          await sendPrimaryMenu(from);
          return;
}
        // nao entendeu
        await client.sendMessage(from, 'Não entendi sua opção. Responda com número: 1 confirmar, 2–6 editar, 0 cancelar.');
        return;
      }

      // edição de campos — cada estado trata a nova entrada e volta ao resumo
      if (estado.etapa === 'pedido_edit_nome') {
        estado.dados.nome = msg.body || '';
        await client.sendMessage(from, 'Nome atualizado.');
        await sendOrderSummary(from, estado);
        return;
      }

      if (estado.etapa === 'pedido_edit_item') {
        const body = (msg.body || '').trim();
        estado.dados.itemRaw = body;

        const parsed = parseQuantityAndItem(body);
        estado.dados.quantidade = parsed.qty || 1;
        const itemText = (parsed.itemText || parsed.itemText === '') ? parsed.itemText : body;

        // transformar em MAIÚSCULAS para consulta mais assertiva
        const itemTextUpper = String(itemText).toUpperCase();
        estado.dados.itemRawUpper = itemTextUpper;

        const match = findCatalogMatch(itemTextUpper);
        if (!match) {
          await client.sendMessage(from,
            '❗ Não encontrei esse item no catálogo. Digite o item exatamente como está no catálogo (ex: "MILHO MOÍDO 24 KG") e, se quiser, informe a quantidade antes (ex: "2x MILHO MOÍDO 24 KG").'
          );
          estado.etapa = 'pedido_edit_item';
          return;
        }

        estado.dados.itemKey = match.key;
        estado.dados.item = `${estado.dados.quantidade} x ${match.key}`;

        await client.sendMessage(from, 'Item/Quantidade atualizado.');
        await sendOrderSummary(from, estado);
        return;
      }
if (estado.etapa === 'pedido_edit_endereco') {
  await client.sendMessage(from, '✏️ Para alterar o endereço, informe o *CEP* (somente números):');
  estado.etapa = 'pedido_cep_edit';
  estado.dados._lastCepAttempt_edit = null;
  estado.dados._lastCepInfo_edit = null;
  return;
}
if (estado.etapa === 'pedido_cep_edit') {
  const body = (msg.body || '').trim();

  const cepDigits = body.replace(/\D/g, '').slice(0, 8);
  if (cepDigits.length !== 8) {
    await client.sendMessage(from, 'CEP inválido. Digite o CEP com 8 dígitos (ex: 12345678).');
    return;
  }

  await client.sendMessage(from, '🔎 Consultando endereço pelo CEP...');
  const cepInfo = await lookupCepRaw(cepDigits);
  estado.dados._lastCepAttempt_edit = cepDigits;
  estado.dados._lastCepInfo_edit = cepInfo || null;

  if (!cepInfo) {
    await client.sendMessage(from, 'CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos).');
    estado.etapa = 'pedido_cep_edit';
    return;
  }

  const addrText = formatAddressFromCep(cepInfo);
  await client.sendMessage(from, `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (informar número e complemento)\n2️⃣ Tentar outro CEP`);
  estado.etapa = 'pedido_cep_edit_confirm';
  return;
}

// Confirmação após mostrar CEP durante edição
if (estado.etapa === 'pedido_cep_edit_confirm') {
  const opt = (msg.body || '').trim();

  // confirmação direta
  if (opt === '1' || /^sim|confirm/i.test(opt.toLowerCase())) {
    const info = estado.dados._lastCepInfo_edit;
    if (!info) {
      await client.sendMessage(from, 'Erro interno: informação de CEP ausente. Por favor digite o CEP novamente:');
      estado.etapa = 'pedido_cep_edit';
      return;
    }
    const base = formatAddressFromCep(info);
    estado.dados.endereco = base; // ainda sem número/complemento
    await client.sendMessage(from, '📍 Ótimo — agora envie o *número* da residência/loja:');
    estado.etapa = 'pedido_numero_edit';
    return;
  }

  // tentar outro CEP
  if (opt === '2') {
    await client.sendMessage(from, 'Ok. Digite o CEP novamente:');
    estado.etapa = 'pedido_cep_edit';
    return;
  }

  // se pessoa enviou outro CEP direto
  const possibleCep = (msg.body || '').replace(/\D/g, '').slice(0, 8);
  if (possibleCep.length === 8) {
    const cepInfo = await lookupCepRaw(possibleCep);
    estado.dados._lastCepAttempt_edit = possibleCep;
    estado.dados._lastCepInfo_edit = cepInfo || null;

    if (!cepInfo) {
      await client.sendMessage(from, 'CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos).');
      estado.etapa = 'pedido_cep_edit';
      return;
    }

    const addrText = formatAddressFromCep(cepInfo);
    await client.sendMessage(from, `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (informar número e complemento)\n2️⃣ Tentar outro CEP`);
    estado.etapa = 'pedido_cep_edit_confirm';
    return;
  }

  await client.sendMessage(from, 'Opção inválida. Responda 1 (correto) ou envie um CEP válido com 8 dígitos.');
  return;
}

// Recebe o número durante edição (após confirmar CEP)
if (estado.etapa === 'pedido_numero_edit') {
  const numero = (msg.body || '').trim();
  estado.dados.numero = numero;
  await client.sendMessage(from, 'Se tiver complemento, envie agora (ex: \"Apto 101\" ou \"sem\"):');
  estado.etapa = 'pedido_complemento_edit';
  return;
}

// Recebe complemento durante edição
if (estado.etapa === 'pedido_complemento_edit') {
  const complemento = (msg.body || '').trim();
  estado.dados.complemento = complemento && complemento.toLowerCase() !== 'sem' ? complemento : '';
  const base = estado.dados.endereco || (estado.dados._lastCepInfo_edit ? formatAddressFromCep(estado.dados._lastCepInfo_edit) : '');
  const parts = [base];
  if (estado.dados.numero) parts.push(`Nº ${estado.dados.numero}`);
  if (estado.dados.complemento) parts.push(`Compl.: ${estado.dados.complemento}`);
  estado.dados.endereco = parts.filter(Boolean).join(', ');
  await client.sendMessage(from, 'Endereço atualizado.');
  await sendOrderSummary(from, estado);
  return;
}

      if (estado.etapa === 'pedido_edit_pagamento') {
        estado.dados.pagamento = msg.body || '';
        await client.sendMessage(from, 'Método de pagamento atualizado.');
        await sendOrderSummary(from, estado);
        return;
      }

      // DÚVIDAS
      if (estado.etapa === 'duvidas') {
        if (text === '1') {
          await msg.reply('📌 FAQ:\n- Horário: 08h–18h\n-Pagamento: Pix, Dinheiro, Boleto, Depósito Bancário, Cheque\n- Entrega: Retirada ou Delivery\n\nSe quiser voltar ao menu inicial, só digitar "menu".');
          estado.etapa = 'fim';
          return;
        } else if (text === '2') {
          await msg.reply('Escreva sua dúvida e enviaremos a um funcionário:');
          estado.etapa = 'duvida_escrita';
          return;
        } else if (text === '0') {
          estado.etapa = 'inicio';
          await sendPrimaryMenu(from);
          return;
        } else {
          await msg.reply('Responda 1, 2 ou 0.');
          return;
        }
      }
      if (estado.etapa === 'duvida_escrita') {
        // grava localmente
        estado.dados.duvida = msg.body || '';

        // confirma para o usuário (resposta curta) — comportamento parecido com confirmação de orçamento
        try {
          await client.sendMessage(from, '📩 Sua dúvida foi registrada. Em breve retornaremos por aqui.\n\nSe quiser voltar ao menu inicial, só digitar "menu".');
        } catch (e) {
          smallLog('Erro ao enviar confirmação de dúvida ao usuário:', e && e.message ? e.message : e);
        }

        // envia a dúvida para o grupo de Duvidas (ou fallback para STAFF_CHAT_ID) em background
        (async () => {
          try {
            const targetGroup = DUVIDAS_GROUP_ID || STAFF_CHAT_ID;
            if (targetGroup) {
              const snippet = String(estado.dados.duvida || '').trim();
              const groupMsg = [
                '📩 *Nova Dúvida Recebida*',
                `De: ${from}`,
                `Mensagem:`,
                snippet || '(sem texto)',
              ].join('\n');
              await client.sendMessage(targetGroup, groupMsg);
              smallLog('Dúvida enviada para grupo:', targetGroup);
            } else {
              smallLog('Nenhum DUVIDAS_GROUP_ID configurado — dúvida não enviada a grupo.');
            }
          } catch (e) {
            smallLog('Erro ao enviar dúvida para grupo:', e && e.message ? e.message : e);
          }
        })();

        // encerra atendimento automático para este chat — aguarda próxima mensagem do usuário para reiniciar
        userState[from] = { etapa: 'done', dados: {} };
        return;
      }
      // FIM
      if (estado.etapa === 'fim') {
        if (text === '0' || text === 'menu' || text === 'voltar') {
          userState[from] = { etapa: 'inicio', dados: {} };
          await client.sendMessage(from, 'Voltando ao menu inicial...');
          await sendPrimaryMenu(from);
          return;
        }
        await msg.reply('Se precisar de algo, responda "menu" ou digite "1" para ver o catálogo.');
        return;
      }
      // Fallback geral: se nada bateu, envie menu
      await sendPrimaryMenu(from);
    } catch (err) {
      smallLog('Erro no handler de mensagem:', err && err.message ? err.message : err);
    }
  });

  return client;
}
// Inicialização com retries/fallback
async function tryInitializeFlow({torPort, chromePath}) {
  async function attempt({useTor, useSystemChrome, chromePathOverride}) {
    const puppOpt = connections.buildPuppeteerOptions({
      torPort: (useTor ? torPort : null),
      useSystemChrome: !!useSystemChrome,
      chromePath: chromePathOverride || null
    });
    const client = createClient(puppOpt);
    try {
      await client.initialize();
      return { client };
    } catch (e) {
      try { await client.destroy(); } catch(_) {}
      return { error: e };
    }
  }

  smallLog('Tentativa 1: init (com Tor se disponível).');
  const chromeExists = !!chromePath;
  let res1 = await attempt({ useTor: !!torPort, useSystemChrome: chromeExists, chromePathOverride: chromePath });
  if (res1.client) return res1.client;

  const msg1 = res1.error && res1.error.message ? res1.error.message : String(res1.error);
  if (/Execution context was destroyed|Runtime.callFunctionOn/i.test(msg1)) {
    smallLog('Erro Execution context — retry com Chromium embutido.');
    const res2 = await attempt({ useTor: !!torPort, useSystemChrome: false, chromePathOverride: null });
    if (res2.client) return res2.client;

    smallLog('Tentativa 3: sem Tor.');
    const envBackup = connections.clearProxyEnv();
    const res3 = await attempt({ useTor: false, useSystemChrome: false, chromePathOverride: null });
    connections.restoreProxyEnv(envBackup);
    if (res3.client) return res3.client;
    throw res3.error || res2.error || res1.error;
  } else {
    smallLog('Erro não Execution context — fallback sem Tor.');
    const envBackup = connections.clearProxyEnv();
    const resFb = await attempt({ useTor: false, useSystemChrome: false, chromePathOverride: null });
    connections.restoreProxyEnv(envBackup);
    if (resFb.client) return resFb.client;
    throw resFb.error || res1.error;
  }
}

(async () => {
  smallLog('iniciando...');
  const { torExec, torPort, chromePath } = await connections.getStartupOptions();
  if (torPort) smallLog('Tor detectado em', torPort); else smallLog('Sem Tor');
  if (torExec) smallLog('Tor executable:', torExec);
  if (chromePath) smallLog('Chrome detectado em', chromePath); else smallLog('Chrome não detectado, usará Chromium embutido.');
  try {
    const client = await tryInitializeFlow({ torPort, chromePath });
  } catch (err) {
    console.error('Falha ao inicializar cliente:', err && err.message ? err.message : String(err));
    process.exit(1);
  }
})();

