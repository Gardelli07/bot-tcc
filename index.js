require("dotenv").config();
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const https = require("https");
const connections = require("./connections");
const { loadCatalogFromApi } = require('./bot_catalog_loader');
const COMMAND_GROUP = process.env.COMMAND_GROUP_ID || "120363405061423609@g.us";
const http = require("http");
const CONFIRMED_GROUP_ID =
  process.env.CONFIRMED_GROUP_ID || process.env.PEDIDOS_CONFIRMADOS_ID || null;
const DUVIDAS_GROUP_ID = process.env.DUVIDAS_GROUP_ID || null;

// CATALOGO (catalog_items.json) — carga e utilidades
function tryLoadCatalog() {
  const candidates = [
    path.join(__dirname, "catalog_items.json"),
    path.join(process.cwd(), "catalog_items.json"),
    path.join(__dirname, "catalog", "catalog_items.json"),
    path.join(process.cwd(), "catalog", "catalog_items.json"),
    path.join("/mnt/data", "catalog_items.json"),
  ];
  let rawObj = null;
  let loadedFrom = null;

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      rawObj = JSON.parse(raw);
      loadedFrom = p;
      break;
    }
  }

  // Normalizar para um array de itens: { name, code, price }
  const items = [];
  try {
    if (Array.isArray(rawObj)) {
      // formato: [{ name, code, price, ... }, ...]
      for (const it of rawObj) {
        const name = String(it.name || it.nome || it.label || "").trim();
        const code = String(it.code || it.codigo || it.cod || "").trim();
        const price = "price" in it ? it.price : it.preco || it.valor || null;
        if (name || code)
          items.push({ name: name || code, code: code || "", price: price });
      }
    } else if (rawObj && typeof rawObj === "object") {
      const vals = Object.values(rawObj);
      if (
        vals.length > 0 &&
        (typeof vals[0] !== "object" || vals[0] === null)
      ) {
        // escolher uma amostra não-nula para inferir tipo
        const sample = vals.find((v) => v !== null && v !== undefined);
        if (typeof sample === "number") {
          // mapeamento name -> price
          for (const [k, v] of Object.entries(rawObj)) {
            items.push({ name: String(k).trim(), code: "", price: v });
          }
        } else if (typeof sample === "string") {
          // mapeamento name -> code (ex: "MILHO 48 KG": "MIL4801")
          for (const [k, v] of Object.entries(rawObj)) {
            items.push({
              name: String(k).trim(),
              code: String(v).trim(),
              price: null,
            });
          }
        } else {
          // fallback seguro: tratar como name -> rawValue
          for (const [k, v] of Object.entries(rawObj)) {
            items.push({ name: String(k).trim(), code: "", price: v });
          }
        }
      } else {
        // entradas como: { "COD123": { name: "MILHO 24 KG", code: "COD123", price: 47 }, ... }
        for (const [k, v] of Object.entries(rawObj)) {
          if (v && typeof v === "object") {
            const name =
              String(v.name || v.nome || v.label || "").trim() ||
              String(k).trim();
            const code = String(v.code || v.codigo || v.cod || k).trim();
            const price = "price" in v ? v.price : v.preco || v.valor || null;
            items.push({ name, code, price });
          } else {
            // fallback seguro
            items.push({ name: String(k).trim(), code: "", price: v });
          }
        }
      }
    }
  } catch (e) {
    smallLog(
      "Erro ao normalizar catalog_items.json:",
      e && e.message ? e.message : e
    );
  }

  // índices normalizados (chaves em UPPER + sem acento)
  function keyStr(s) {
    return normalizeString(String(s || ""));
  }

  const byName = new Map(); // key = normalized name => item
  const byCode = new Map(); // key = normalized code => item
  for (const it of items) {
    const n = keyStr(it.name);
    const c = keyStr(it.code);
    const entry = {
      name: it.name,
      code: it.code || null,
      price: it.price !== undefined ? it.price : null,
    };
    if (n) byName.set(n, entry);
    if (c) byCode.set(c, entry);
  }

  smallLog(
    "catalog_items.json carregado de",
    loadedFrom,
    "items(normalizados):",
    items.length,
    "byName:",
    byName.size,
    "byCode:",
    byCode.size
  );
  return { items, byName, byCode, source: loadedFrom };
}

let CATALOG = tryLoadCatalog();

// tentar carregar catálogo diretamente da API (substitui catalog_items.json se funcionar)
(async function loadRemoteCatalogIfAvailable() {
  try {
    // cria cliente axios usando variáveis de ambiente (se já existir API_BASE_URL, prioriza)
    const axios = require('axios');
    const api = axios.create({
      baseURL:
        process.env.API_BASE_URL ||
        `http://${process.env.API_HOST || 'localhost'}:${process.env.API_PORT || 8080}`,
      timeout: 10000,
    });

    // chamada solicitada (usa os sufixos que você pediu)
    const remote = await loadCatalogFromApi(api, { suffixes: ['ens', 'out', 'prod'] });

    // monta items[] no formato esperado pelo restante do código
    const items = [];
    // remote.byOriginalName tem pares { "Nome Original": "CODIGO" }
    for (const [origName, code] of Object.entries(remote.byOriginalName || {})) {
      items.push({ name: String(origName).trim(), code: String(code || '').trim(), price: null });
    }

    // cria índices normalizados (Map) - usa sua util normalizeString já definida
    const byName = new Map();
    const byCode = new Map();
    for (const it of items) {
      const n = normalizeString(it.name);
      const c = normalizeString(it.code);
      const entry = { name: it.name, code: it.code, price: it.price || null };
      if (n) byName.set(n, entry);
      if (c) byCode.set(c, entry);
    }

    CATALOG = { items, byName, byCode, source: 'api' };
    smallLog('CATALOG atualizado a partir da API', items.length, 'itens');
  } catch (err) {
    smallLog(
      'Não foi possível carregar catálogo da API (mantendo catalog_items.json):',
      err && err.message ? err.message : err
    );
  }
})();


function normalizeString(s) {
  if (!s) return "";
  const noAcc = s.normalize
    ? s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    : s;
  return noAcc.toString().trim().toUpperCase().replace(/\s+/g, " ");
}

function postPedidoAPI(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const hostname = process.env.API_HOST || "localhost";
    const port = process.env.API_PORT ? Number(process.env.API_PORT) : 8080;

    const options = {
      hostname,
      port,
      path: "/pedido",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 10000, // 10s
    };

    const reqApi = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body });
        } else {
          reject(new Error(`API /pedido respondeu ${res.statusCode}: ${body}`));
        }
      });
    });

    reqApi.on("error", (err) => reject(err));
    reqApi.on("timeout", () => {
      reqApi.destroy();
      reject(new Error("Timeout ao conectar com API /pedido"));
    });

    reqApi.write(payload);
    reqApi.end();
  });
}

function findCatalogMatch(userText) {
  if (!userText) return null;
  const norm = normalizeString(userText);

  const byCode = CATALOG && CATALOG.byCode ? CATALOG.byCode : new Map();
  const byName = CATALOG && CATALOG.byName ? CATALOG.byName : new Map();

  if (byCode.has(norm)) {
    const i = byCode.get(norm);
    return { key: i.name, name: i.name, code: i.code, price: i.price };
  }

  if (byName.has(norm)) {
    const i = byName.get(norm);
    return { key: i.name, name: i.name, code: i.code, price: i.price };
  }

  const nameMatches = [];
  for (const [k, v] of byName) {
    if (k.includes(norm) || norm.includes(k)) nameMatches.push(v);
  }
  const codeMatches = [];
  for (const [k, v] of byCode) {
    if (k.includes(norm) || norm.includes(k)) codeMatches.push(v);
  }

  // unifica candidatos únicos a partir de CATALOG.items
  const itemsArray = Array.isArray(CATALOG && CATALOG.items ? CATALOG.items : [])
    ? CATALOG.items
    : [];

  const unique = [];
  const seen = new Set();
  for (const it of itemsArray) {
    const id = (it.code && String(it.code).trim()) || String(it.name).trim();
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(it);
    }
  }

  if (unique.length === 1) {
    const i = unique[0];
    return { key: i.name, name: i.name, code: i.code, price: i.price };
  }
  if (unique.length > 1) {
    const i = unique[0];
    return {
      key: i.name,
      name: i.name,
      code: i.code,
      price: i.price,
      multiple: unique,
    };
  }

  // fallback: se houver matches por nome ou código parcialmente
  if (nameMatches.length === 1 && codeMatches.length === 0) {
    const i = nameMatches[0];
    return { key: i.name, name: i.name, code: i.code, price: i.price };
  }
  if (codeMatches.length === 1 && nameMatches.length === 0) {
    const i = codeMatches[0];
    return { key: i.name, name: i.name, code: i.code, price: i.price };
  }
  if (nameMatches.length > 1 || codeMatches.length > 1) {
    const candidates = (nameMatches.length ? nameMatches : codeMatches).slice(0, 10);
    return { multiple: candidates };
  }

  return null;
}

function parseQuantityAndItem(text) {
  // retorna { qty: Number, itemText: String }
  if (!text) return { qty: 1, itemText: "" };
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
    const itemOnly = s.replace(m[0], "").trim();
    return { qty: parseInt(m[1], 10), itemText: itemOnly || "" };
  }
  // fallback: qty 1, item = texto bruto
  return { qty: 1, itemText: s };
}

function smallLog(...args) {
  console.log(...args);
}

// UTIL: ViaCEP lookup
function lookupCepRaw(cep) {
  return new Promise((resolve) => {
    const clean = (cep || "").replace(/\D/g, "").slice(0, 8);
    if (clean.length !== 8) return resolve(null);
    const url = `https://viacep.com.br/ws/${clean}/json/`;

    const req = https.get(url, { timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          if (json.erro) return resolve(null);
          resolve({
            cep: json.cep,
            logradouro: json.logradouro,
            complemento: json.complemento,
            bairro: json.bairro,
            localidade: json.localidade,
            uf: json.uf,
          });
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function formatAddressFromCep(obj) {
  if (!obj) return "";
  const parts = [];
  if (obj.logradouro) parts.push(obj.logradouro);
  if (obj.bairro) parts.push(obj.bairro);
  const cityState = [obj.localidade, obj.uf].filter(Boolean).join(" - ");
  if (cityState) parts.push(cityState);
  if (obj.cep) parts.push(`CEP: ${obj.cep}`);
  return parts.join(", ");
}

function resolveCatalogFiles() {
  const filenames = [
    "variedades.jpg",
    "variedades (2).jpg",
    "ração.jpg",
    "ração (2).jpg",
    "cereal.jpg",
    "cereal (2).jpg",
  ];

  const found = [];
  const candidateDirs = [
    path.join(__dirname, "catalog"),
    path.join(process.cwd(), "catalog"),
    __dirname,
    process.cwd(),
    "/mnt/data",
  ];

  for (const dir of candidateDirs) {
    for (const fn of filenames) {
      const p = path.join(dir, fn);
      try {
        if (fs.existsSync(p)) found.push(p);
      } catch (_) {}
    }
  }
  return Array.from(new Set(found));
}

const inHandoff = new Set(); // chats que estão em handoff

// normaliza entrada para '5515991234567@c.us'
function normalizeId(input) {
  if (!input) return null;
  input = String(input).trim();
  if (input.endsWith("@c.us")) return input;
  const digits = input.replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@c.us`;
}

async function startHandoff(client, chatId) {
  if (!chatId || inHandoff.has(chatId)) return;
  inHandoff.add(chatId);
  await client.sendMessage(
    chatId,
    "Você foi transferido para um atendente humano. Por favor, aguarde o atendimento."
  );
}

async function endHandoff(client, chatId) {
  if (!chatId) return;
  inHandoff.delete(chatId);
  await client.sendMessage(
    chatId,
    "O atendimento foi encerrado. O bot voltou a funcionar."
  );
}

// CRIA CLIENTE E HANDLERS
function createClient(puppeteerOptions) {
  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerOptions,
  });

  client.on("qr", (qr) => qrcode.generate(qr, { small: true }));

  client.on("ready", () => {
    smallLog("=== BOT PRONTO ===");
  });

  let userState = {};

  function dentroHorario() {
    try {
      const s = new Date().toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour12: false,
        hour: "2-digit",
      });
      const hour = parseInt(s, 10);
      return hour >= 0 && hour <= 23; // inclui até 23h59
    } catch (e) {
      return true;
    }
  }

  // catálogo
  const catalogFiles = resolveCatalogFiles();

  // envia menu primário (forçado)
  async function sendPrimaryMenu(to) {
    if (!userState[to]) userState[to] = { etapa: "inicio", dados: {} };
    userState[to].etapa = "menu_principal";
    await client.sendMessage(
      to,
      "👋 Bem-vindo! ao atendimento virtual da RBS Cereais\nPara iniciarmos escolha uma opção:\n\n" +
        "1️⃣ Ver Catálogo\n" +
        "2️⃣ Fazer Orçamento\n" +
        "3️⃣ Tirar Dúvidas\n" +
        "4️⃣ Acessar Site\n\n" +
        'Responda apenas com o número da opção.\nSe em qualquer momento quiser voltar ao menu inicial, só digitar "menu".'
    );
  }

  async function sendCatalogImages(to) {
    if (!catalogFiles.length) {
      await client.sendMessage(
        to,
        '\nSe quiser voltar ao menu inicial, só digitar "menu".'
      );
      return;
    }

    for (let i = 0; i < catalogFiles.length; i++) {
      const filePath = path.resolve(catalogFiles[i]);
      if (!fs.existsSync(filePath)) continue;

      const media = MessageMedia.fromFilePath(filePath);
      try {
        await client.sendMessage(to, media, { caption: "" });
      } catch {
        // ignora erros
      }

      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    await client.sendMessage(
      to,
      "✅ Enviamos o catálogo completo. Deseja fazer um orçamento? \nResponda com *2* para iniciar o orçamento."
    );
  }

  function formatAddressForSummary(dados) {
    const info = dados._lastCepInfo_edit || dados._lastCepInfo || null;

    if (info) {
      const cepDigits = (info.cep || "").replace(/\D/g, "");
      const numero = dados.numero || "";
      const complemento =
        (dados.complemento && String(dados.complemento).trim()) ||
        (info.complemento && String(info.complemento).trim()) ||
        "";
      const line1 = [info.logradouro || "", numero]
        .filter(Boolean)
        .join(" ")
        .trim();
      const line2Parts = [];
      if (info.bairro) line2Parts.push(info.bairro);
      if (complemento) line2Parts.push(`Compl.: ${complemento}`);
      const line2 = line2Parts.join(" - ");
      const cityUf = [info.localidade || "", info.uf || ""]
        .filter(Boolean)
        .join(", ");
      const line3 = cityUf + (cepDigits ? " " + cepDigits : "");
      return [line1, line2, line3].filter(Boolean).join("\n");
    }
    if (
      dados.endereco &&
      typeof dados.endereco === "string" &&
      dados.endereco.trim()
    ) {
      if (dados.endereco.includes("\n")) return dados.endereco.trim();
      return dados.endereco
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join("\n");
    }
    return "(não informado)";
  }

  async function sendOrderSummary(to, estado) {
    const d = estado.dados || {};
    const qty = Number(d.quantidade) || 1;
    const addrText = formatAddressForSummary(d);
    const lines = [
      "🧾 *Resumo do Orçamento*",
      `Nome: ${d.nome || "(não informado)"}`,
      `Item: \n${d.item || "(não informado)"}`,
      `Endereço:\n${addrText}`,
      `Entrega: ${d.entrega || "(não informado)"}`,
      `Pagamento: ${d.pagamento || "(não informado)"}`,
    ];
    const options = [
      "",
      "Confirme as informações:",
      "1️⃣ Registrar Orçamento",
      "2️⃣ Editar Nome",
      "3️⃣ Editar Item/Quantidade",
      "4️⃣ Editar Endereço",
      "5️⃣ Editar Pagamento",
      "0️⃣ Cancelar / Voltar",
      "",
      "Responda com o número da opção desejada.",
    ];
    const text =
      lines.join("\n\n") +
      "\n\n" +
      options.join("\n") +
      '\n\nSe quiser voltar ao menu inicial, só digitar "menu".';
    await client.sendMessage(to, text);
    estado.etapa = "pedido_confirm";
  }

  function buildOrderReportForGroup(dados, from) {
    const d = dados || {};
    const fromNumber = String(from || "desconhecido")
      .replace(/@c\.us$/i, "") // remove sufixo @c.us se existir
      .replace(/\D/g, ""); // deixa só dígitos
    const lines = [
      "🧾 *Novo Orçamento Confirmado*",
      `De: ${fromNumber || "desconhecido"}`,
      `Nome: ${d.nome || "(não informado)"}`,
      `Item: \n${
        d.item ||
        (d.itemKey ? `${d.quantidade || 1} x ${d.itemKey}` : "(não informado)")
      }`,
      "---",
      `Endereço: ${d.endereco || "(não informado)"}`,
      `Entrega: ${d.entrega || "(não informado)"}`,
      `Pagamento: ${d.pagamento || "(não informado)"}`,
    ];
    return lines.join("\n");
  }

  async function handleHandoffCommand(
    msg,
    body,
    isFromCommandGroup,
    chatId,
    replyTo
  ) {
    const m = body.match(/^!handoff(?:\s+(.+))?$/i);
    if (!m) return false;

    const targetRaw = m[1];
    const target = targetRaw ? normalizeId(targetRaw) : chatId;
    if (!target) {
      await client.sendMessage(
        replyTo,
        "Telefone inválido. Use: !handoff 5515xxxxxxxxx"
      );
      return true;
    }

    await startHandoff(client, target);

    if (isFromCommandGroup) {
      const author = msg.author || "desconhecido";
      const authorShort = String(author).replace(/@c\.us$/i, ""); // já remove o @c.us, mantém o número

      const targetShort = String(target)
        .replace(/@c\.us$/i, "")
        .replace(/\D/g, ""); // deixa só números

      await client.sendMessage(
        replyTo,
        `Handoff iniciado para ${targetShort}.`
      );
    } else if (target !== chatId) {
      const targetShort = String(target).replace(/@c\.us$/i, "");
      await client.sendMessage(
        replyTo,
        `Handoff iniciado para ${targetShort}.`
      );
    } else {
      await client.sendMessage(replyTo, "Handoff iniciado.");
    }

    return true;
  }

  async function handleBotCommand(
    msg,
    body,
    isFromCommandGroup,
    chatId,
    replyTo
  ) {
    const m = body.match(/^!bot(?:\s+(.+))?$/i);
    if (!m) return false;

    const targetRaw = m[1];
    const target = targetRaw ? normalizeId(targetRaw) : chatId;
    if (!target) {
      await client.sendMessage(
        replyTo,
        "Telefone inválido. Use: !bot 5515xxxxxxxxx"
      );
      return true;
    }

    if (!inHandoff.has(target)) {
      await client.sendMessage(
        replyTo,
        `Esse chat (${target}) não está em handoff.`
      );
      return true;
    }

    await endHandoff(client, target);
    try {
      if (!userState) userState = {};
      userState[target] = { etapa: "inicio", dados: {} };
      await sendPrimaryMenu(target);
    } catch (e) {
      smallLog(
        "Erro ao reiniciar estado do usuário após !bot:",
        e && e.message ? e.message : e
      );
    }

    // confirmação para quem emitiu o comando (grupo ou autor)
    if (isFromCommandGroup) {
      const author = msg.author || "desconhecido";
      const authorShort = String(author)
        .replace(/@c\.us$/i, "")
        .replace(/\D/g, ""); // deixa só números

      const targetShort = String(target)
        .replace(/@c\.us$/i, "")
        .replace(/\D/g, ""); // deixa só números

      await client.sendMessage(
        replyTo,
        `Handoff encerrado para ${targetShort}.`
      );
    } else {
      const targetShort = String(target)
        .replace(/@c\.us$/i, "")
        .replace(/\D/g, "");

      await client.sendMessage(replyTo, `Handoff encerrado: ${targetShort}`);
    }

    return true;
  }

  client.on("message", async (msg) => {
    try {
      const from = msg.from; // chat id (user or staff)
      const textRaw = (msg.body || "").trim();
      const text = textRaw.toLowerCase();
      const isFromCommandGroup = msg.from === COMMAND_GROUP; // Determina se a mensagem veio do grupo de comandos
      const chatId = msg.fromMe && msg.to ? msg.to : msg.from; // determina o chat 'efetivo' (para comandos podemos permitir grupo)

      if (!isFromCommandGroup && chatId && inHandoff.has(chatId)) {
        return;
      }

      if (!chatId) {
      } else {
        if (chatId.endsWith("@c.us") || isFromCommandGroup) {
          const replyTo = isFromCommandGroup
            ? COMMAND_GROUP
            : msg.fromMe
            ? chatId
            : msg.from;
          if (
            await handleHandoffCommand(
              msg,
              textRaw,
              isFromCommandGroup,
              chatId,
              replyTo
            )
          )
            return;
          if (
            await handleBotCommand(
              msg,
              textRaw,
              isFromCommandGroup,
              chatId,
              replyTo
            )
          )
            return;
        }
      }

      let chat = null;
      try {
        chat = await msg.getChat();
      } catch (e) {}

      if (!userState[from]) userState[from] = { etapa: "inicio", dados: {} };
      const estado = userState[from];

      if (estado.etapa === "done") {
        userState[from] = { etapa: "inicio", dados: {} };
        await sendPrimaryMenu(from);
        return;
      }
      // se o usuário digitar "menu" em qualquer momento: reset e forçar menu primário
      if (text === "menu") {
        userState[from] = { etapa: "inicio", dados: {} };
        await client.sendMessage(from, "Voltando ao menu inicial...");
        await sendPrimaryMenu(from);
        return;
      }

      // === Bloco a ser inserido ===
      if (
        textRaw &&
        textRaw.toLowerCase().startsWith("novo orçamento, vendedor")
      ) {
        try {
          smallLog(
            "Recebido Orçamento importado (vendedor). Iniciando parse..."
          );

          const raw = textRaw.replace(/\r/g, "");
          const lines = raw.split("\n").map((l) => l.trim());

          // helpers
          const getLineValue = (label) => {
            const re = new RegExp("^" + label + ":\\s*(.+)$", "i");
            const found = lines.find((l) => re.test(l));
            return found ? found.replace(re, "$1").trim() : null;
          };

          const fromRaw = getLineValue("De") || getLineValue("DE");
          const senderNormalized = normalizeId(fromRaw) || msg.from || null;

          const nomeLinha = getLineValue("Nome") || getLineValue("NOME") || "";
          const clienteNome =
            nomeLinha ||
            String(senderNormalized || msg.from || "")
              .replace(/@c\.us$/i, "")
              .replace(/\D/g, "") ||
            "Desconhecido";

          // pegar bloco de itens: encontra o índice da linha "Item:" e pega até Total: or --- or Endereço:
          const idxItem = lines.findIndex((l) => /^Item:?$/i.test(l));
          let itemLines = [];
          if (idxItem !== -1) {
            for (let i = idxItem + 1; i < lines.length; i++) {
              const L = lines[i];
              if (/^(Total:|---|Endereço:|Entrega:|Pagamento:)/i.test(L)) break;
              if (!L) continue;
              itemLines.push(L);
            }
          }

          // Se não tiver "Item:" tenta capturar linhas numeradas como itens
          if (itemLines.length === 0) {
            itemLines = lines.filter((l) => /^\d+\./.test(l));
          }

          // parse address / CEP / número / complemento
          const enderecoRaw = getLineValue("Endereço") || "";
          const cepMatch =
            enderecoRaw.match(/CEP[:\s]*([0-9]{8})/i) ||
            raw.match(/CEP[:\s]*([0-9]{8})/i);
          const cepDigits = cepMatch
            ? String(cepMatch[1]).replace(/\D/g, "")
            : "";
          const numeroMatch = enderecoRaw.match(
            /N(?:º|o)\s*[:\.]?\s*([^,\n]+)/i
          );
          const numero = numeroMatch ? numeroMatch[1].trim() : "";
          const complMatch = enderecoRaw.match(/Compl\.?[:\.]?\s*([^,\n]+)/i);
          const complemento = complMatch ? complMatch[1].trim() : "";

          // tentar buscar via CEP
          let cepInfo = null;
          if (cepDigits && cepDigits.length === 8) {
            cepInfo = await lookupCepRaw(cepDigits).catch(() => null);
          }

          const entrega = getLineValue("Entrega") || "";
          const pagamento =
            getLineValue("Pagamento") || getLineValue("Pagamento") || "";

          // parse cada linha de item
          const parsedItems = [];
          for (const rawLine of itemLines) {
            // remover prefixo numerado ("1.") e preços entre parenteses
            let ln = rawLine
              .replace(/^\d+\.?\s*/, "")
              .replace(/\(.*?\)/g, "")
              .trim();
            if (!ln) continue;

            // usar parseQuantityAndItem para extrair qty e itemText
            const p = parseQuantityAndItem(ln);
            const qty = Number(p.qty || 1);
            const itemText = (p.itemText || ln).trim();

            // tentar extrair preco se houver (ex: R$ 20,00) na linha original
            let price = null;
            const priceMatch = rawLine.match(/R\$\s*([0-9.,]+)/i);
            if (priceMatch) {
              const num = priceMatch[1].replace(/\./g, "").replace(/,/g, ".");
              const nVal = Number(num);
              if (!Number.isNaN(nVal)) price = nVal;
            }

            parsedItems.push({ quantity: qty, name: itemText, price });
          }

          if (parsedItems.length === 0) {
            await client.sendMessage(
              msg.from,
              "Não foi possível identificar itens no orçamento importado. Verifique o formato."
            );
            return;
          }

          // construir payload compatível com postPedidoAPI
          const payload = parsedItems.map((it) => ({
            cep: cepDigits || "",
            numero: numero || "",
            complemento: complemento || "",
            bairro: (cepInfo && cepInfo.bairro) || "",
            logradouro: (cepInfo && cepInfo.logradouro) || "",
            cidade: (cepInfo && cepInfo.localidade) || "",
            nome: clienteNome,
            produto: it.name,
            metodo_pagamento: pagamento || "",
            preco: it.price != null ? it.price : 0,
            quantidade: Number(it.quantity || 1),
          }));

          // enviar relatório pro grupo confirmado (opcional)
          const reportLines = [
            "🧾 Orçamento importado (vendedor)",
            `De: ${senderNormalized || msg.from}`,
            `Nome: ${clienteNome}`,
            "Itens:",
            ...parsedItems.map(
              (it, i) =>
                `${i + 1}. ${it.quantity} x ${it.name} (R$ ${
                  it.price != null ? it.price.toFixed(2) : "0,00"
                })`
            ),
            "---",
            `Endereço: ${enderecoRaw || "(não informado)"}`,
            `Entrega: ${entrega || "(não informado)"}`,
            `Pagamento: ${pagamento || "(não informado)"}`,
          ];

          const report = reportLines.join("\n");

          if (CONFIRMED_GROUP_ID) {
            try {
              await client.sendMessage(CONFIRMED_GROUP_ID, report);
            } catch (e) {
              smallLog(
                "Falha ao enviar relatório para grupo confirmado:",
                e && e.message ? e.message : e
              );
            }
          }

          // postar para API
          try {
            if (payload.length === 0) {
              smallLog("Payload vazio — nada a enviar para API.");
              await client.sendMessage(
                msg.from,
                "Nenhum item válido para registrar."
              );
            } else {
              const resp = await postPedidoAPI(payload);
              smallLog("POST /pedido OK (importado):", resp.status);
              if (CONFIRMED_GROUP_ID) {
                try {
                  await client.sendMessage(
                    CONFIRMED_GROUP_ID,
                    `✅ ${payload.length} pedido(s) gravado(s) no banco (importado).`
                  );
                } catch (e) {}
              }
              await client.sendMessage(
                msg.from,
                `Orçamento importado com sucesso — ${payload.length} pedido(s) enviados.`
              );
            }
          } catch (errApi) {
            smallLog(
              "Erro ao enviar pedidos importados para API:",
              errApi && errApi.message ? errApi.message : errApi
            );
            if (CONFIRMED_GROUP_ID) {
              try {
                await client.sendMessage(
                  CONFIRMED_GROUP_ID,
                  `⚠️ Falha ao gravar pedido(s) importado(s): ${String(
                    errApi && errApi.message ? errApi.message : errApi
                  )}`
                );
              } catch (e) {}
            }
            await client.sendMessage(
              msg.from,
              "Erro ao gravar pedidos importados. Verifique o log."
            );
          }
        } catch (err) {
          smallLog(
            "Erro ao processar Orçamento importado:",
            err && err.message ? err.message : err
          );
          try {
            await client.sendMessage(
              msg.from,
              "Erro interno ao processar orçamento importado. Veja logs."
            );
          } catch (_) {}
        }

        return; // importante: evita que o fluxo continue
      }
      // === fim do bloco ===

      if (estado.etapa === "inicio") {
        if (!dentroHorario()) {
          await msg.reply(
            "⏰ Estamos fora do horário de atendimento (08h–18h). Tente mais tarde."
          );
          return;
        }
        await sendPrimaryMenu(from);
        return;
      }

      if (estado.etapa === "menu_principal") {
        if (text === "1" || text.includes("catalog")) {
          await msg.reply("📦 Enviando o catálogo...");
          await sendCatalogImages(from);
          return;
        }
        if (text === "2") {
          await msg.reply(
            "📝 Para começar o orçamento, informe o *nome do cliente/loja*:"
          );
          estado.etapa = "pedido_nome";
          estado.dados = {};
          return;
        }
        if (text === "3") {
          await msg.reply(
            "❓ Dúvidas:\n1️⃣ Dúvidas recentes (FAQ)\n2️⃣ Escrever nova dúvida\n0️⃣ Voltar"
          );
          estado.etapa = "duvidas";
          return;
        }
        if (text === "4") {
          await msg.reply(
            '🌐 Nosso site: https://seudominio.com\n\nSe quiser voltar ao menu inicial, só digitar "menu".'
          );
          estado.etapa = "fim";
          return;
        }
        if (/pedido|comprar|quero/.test(text)) {
          await msg.reply(
            "📝 Para começar o orçamento, informe o *nome do cliente/loja*:"
          );
          estado.etapa = "pedido_nome";
          estado.dados = {};
          return;
        }
        await msg.reply("Não entendi. Responda com 1, 2, 3 ou 4.");
        return;
      }

      if (estado.etapa === "pedido_nome") {
        estado.dados.nome = msg.body || "";
        await msg.reply(
          'Informe o *item*:\nexemplo: " Milho Ensacado 25kg" ou "MIL2515"'
        );
        estado.etapa = "pedido_item";
        return;
      }

      // === INÍCIO: fluxo de item multi-entrada com confirmação e edição antes da quantidade ===
      if (estado.etapa === "pedido_item") {
        const body = (msg.body || "").trim();
        estado.dados.itemRaw = body;

        const parsed = parseQuantityAndItem(body);
        const suggestedQty = parsed.qty || 1;
        const itemText =
          parsed.itemText || parsed.itemText === "" ? parsed.itemText : body;

        const itemTextUpper = String(itemText).toUpperCase();
        estado.dados.itemRawUpper = itemTextUpper;
        const match = findCatalogMatch(itemTextUpper);

        estado._currentItem = {
          nameCandidate: match ? match.key : itemText,
          catalogMatch: match || null,
          qtyCandidate: suggestedQty,
        };

        if (match) {
          await client.sendMessage(
            from,
            `Encontrei: *${match.key}*\n1️⃣Confirmar esse item\n2️⃣ Digitar outro nome\n3️⃣ Cancelar pedido`
          );
        } else {
          await client.sendMessage(
            from,
            `❗ Não encontrei no catálogo.\n2️⃣ Digitar outro nome\n3️⃣ Cancelar pedido`
          );
        }
        estado.etapa = "pedido_item_confirm";
        return;
      }

      if (estado.etapa === "pedido_item_confirm") {
        const optRaw = (msg.body || "").trim();
        const opt = optRaw.toLowerCase();

        if (opt === "1") {
          estado.etapa = "pedido_item_qty";
          await client.sendMessage(from, `Quantidade (envie um número).`);
          return;
        }

        if (opt === "2") {
          delete estado._currentItem;
          estado.etapa = "pedido_item";
          await client.sendMessage(
            from,
            'Digite o nome do item novamente (ex: "Milho Ensacado 25kg" ou "MIL2515"):'
          );
          return;
        }

        if (opt === "3") {
          userState[from] = { etapa: "inicio", dados: {} };
          await client.sendMessage(
            from,
            "Registro cancelado. Voltando ao menu inicial..."
          );
          await sendPrimaryMenu(from);
          return;
        }

        await client.sendMessage(from, "Responda *1*, *2* ou *3*.");
        return;
      }

      if (estado.etapa === "pedido_item_qty") {
        const body = (msg.body || "").trim();
        let q = parseInt(body.replace(/\D/g, ""), 10);
        if (!(q > 0)) {
          if (estado._currentItem && estado._currentItem.qtyCandidate) {
            q = estado._currentItem.qtyCandidate;
          } else {
            await client.sendMessage(
              from,
              "Quantidade inválida. Digite um número (ex: 3)."
            );
            return;
          }
        }

        const itemNameFinal =
          estado._currentItem && estado._currentItem.nameCandidate
            ? estado._currentItem.nameCandidate
            : "(item não identificado)";
        const itemCatalog =
          estado._currentItem && estado._currentItem.catalogMatch
            ? estado._currentItem.catalogMatch
            : null;

        if (!Array.isArray(estado.dados.items)) estado.dados.items = [];

        const normalizedName = String(itemNameFinal).trim().toUpperCase();
        let existingIndex = -1;
        if (itemCatalog && itemCatalog.key) {
          existingIndex = estado.dados.items.findIndex(
            (it) => it.catalogKey && it.catalogKey === itemCatalog.key
          );
        }
        if (existingIndex === -1) {
          existingIndex = estado.dados.items.findIndex(
            (it) =>
              String(it.name || "")
                .trim()
                .toUpperCase() === normalizedName
          );
        }

        if (existingIndex !== -1) {
          const prevQty = Number(
            estado.dados.items[existingIndex].quantity || 0
          );
          const addQty = Number(q || 0);
          const newQty = prevQty + addQty;
          estado.dados.items[existingIndex].quantity = newQty;

          if (!estado.dados.items[existingIndex].catalogKey && itemCatalog) {
            estado.dados.items[existingIndex].catalogKey = itemCatalog.key;
          }
          if (!estado.dados.items[existingIndex].price && itemCatalog) {
            estado.dados.items[existingIndex].price = itemCatalog.price;
          }
          delete estado._currentItem;

          estado.etapa = "pedido_item_more";
          await client.sendMessage(
            from,
            `Item adicionado: *${itemNameFinal}* \nquantidade: ${newQty}\n\n` +
              `1️⃣Adicionar mais um item\n2️⃣Finalizar itens e prosseguir (CEP)\n3️⃣Ver itens adicionados até agora`
          );
          return;
        }

        estado.dados.items.push({
          name: itemNameFinal,
          catalogKey: itemCatalog ? itemCatalog.key : null,
          price: itemCatalog ? itemCatalog.price : null,
          quantity: q,
        });

        delete estado._currentItem;

        estado.etapa = "pedido_item_more";
        await client.sendMessage(
          from,
          `Item adicionado: *${itemNameFinal}* \nquantidade: ${q}\n\n` +
            `1️⃣Adicionar mais um item\n2️⃣Finalizar itens e prosseguir (CEP)\n3️⃣Ver itens adicionados até agora`
        );
        return;
      }

      if (estado.etapa === "pedido_item_more") {
        const opt = (msg.body || "").trim().toLowerCase();

        if (opt === "1") {
          estado.etapa = "pedido_item";
          await client.sendMessage(from, "Digite o próximo item:");
          return;
        }

        if (opt === "3") {
          if (
            !Array.isArray(estado.dados.items) ||
            estado.dados.items.length === 0
          ) {
            await client.sendMessage(from, "Nenhum item adicionado ainda.");
          } else {
            let resumo = "Itens adicionados até agora:\n\n";
            estado.dados.items.forEach((it, idx) => {
              resumo += `${idx + 1}. ${it.quantity} x ${it.name}\n`;
            });
            resumo += "\n1️⃣(ADICIONAR)\n2️⃣(FINALIZAR).";
            await client.sendMessage(from, resumo);
          }
          return;
        }

        if (opt === "2") {
          if (
            !Array.isArray(estado.dados.items) ||
            estado.dados.items.length === 0
          ) {
            await client.sendMessage(
              from,
              'Nenhum item adicionado. Para continuar, envie o item (ex: "MILHO...").'
            );
            estado.etapa = "pedido_item";
            return;
          }
          const summaryParts = [];
          let totalQty = 0;
          for (let i = 0; i < (estado.dados.items || []).length; i++) {
            const it = estado.dados.items[i];
            summaryParts.push(`${i + 1}. ${it.quantity} x ${it.name}`);
            totalQty += Number(it.quantity || 0);
          }

          estado.dados.item = summaryParts.join("\n");
          estado.dados.quantidade = totalQty || 1;

          await client.sendMessage(
            from,
            `✔️ Itens registrados:\n\n${estado.dados.item}\n\nAgora, digite o *CEP* (8 dígitos, somente números):`
          );

          estado.etapa = "pedido_cep";
          return;
        }

        const maybeParsed = parseQuantityAndItem(msg.body || "");
        if (maybeParsed && (maybeParsed.itemText || maybeParsed.qty > 1)) {
          estado._prefillNextItem = msg.body || "";
          estado.etapa = "pedido_item";
          await client.sendMessage(
            from,
            "Registrando novo item. Confirme quando for solicitado."
          );
          return;
        }

        await client.sendMessage(from, "Responda *1*, *2* ou *3*.");
        return;
      }

      if (estado.etapa === "pedido_cep") {
        const cepRaw = (msg.body || "").trim();
        const cepDigits = cepRaw.replace(/\D/g, "").slice(0, 8);
        if (cepDigits.length !== 8) {
          await msg.reply(
            "CEP inválido. Digite o CEP com 8 dígitos (ex: 12345678)."
          );
          return;
        }

        await msg.reply("🔎 Consultando endereço pelo CEP...");
        const cepInfo = await lookupCepRaw(cepDigits);
        estado.dados._lastCepAttempt = cepDigits;
        estado.dados._lastCepInfo = cepInfo || null;

        if (!cepInfo) {
          await msg.reply(
            "CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos)."
          );
          estado.etapa = "pedido_cep";
          return;
        }

        const addrText = formatAddressFromCep(cepInfo);
        await client.sendMessage(
          from,
          `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (continuar número e complemento)\n2️⃣ Tentar outro CEP`
        );
        estado.etapa = "pedido_cep_confirm";
        return;
      }

      if (estado.etapa === "pedido_cep_confirm") {
        const opt = (msg.body || "").trim();

        if (opt === "1") {
          const info = estado.dados._lastCepInfo;
          if (!info) {
            await client.sendMessage(
              from,
              "Erro interno: informação de CEP ausente. Por favor digite o CEP novamente:"
            );
            estado.etapa = "pedido_cep";
            return;
          }
          const base = formatAddressFromCep(info);
          estado.dados.endereco = base;
          await client.sendMessage(
            from,
            "Certo, agora envie o *número* da residência/loja:"
          );
          estado.etapa = "pedido_numero";
          return;
        }

        if (opt === "2") {
          await client.sendMessage(from, "Ok. Digite o CEP novamente:");
          estado.etapa = "pedido_cep";
          return;
        }

        const possibleCep = (msg.body || "").replace(/\D/g, "").slice(0, 8);
        if (possibleCep.length === 8) {
          const cepInfo = await lookupCepRaw(possibleCep);
          estado.dados._lastCepAttempt = possibleCep;
          estado.dados._lastCepInfo = cepInfo || null;

          if (!cepInfo) {
            await client.sendMessage(
              from,
              "CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos)."
            );
            estado.etapa = "pedido_cep";
            return;
          }

          const addrText = formatAddressFromCep(cepInfo);
          await client.sendMessage(
            from,
            `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (continuar número e complemento)\n2️⃣ Tentar outro CEP`
          );
          estado.etapa = "pedido_cep_confirm";
          return;
        }

        await client.sendMessage(
          from,
          "Opção inválida. Responda 1 (correto) ou envie um CEP válido com 8 dígitos."
        );
        return;
      }

      if (estado.etapa === "pedido_numero") {
        const numero = (msg.body || "").trim();
        estado.dados.numero = numero;
        await client.sendMessage(
          from,
          'Se tiver complemento, envie agora (ex: "Apto 101" ou "sem"):'
        );
        estado.etapa = "pedido_complemento";
        return;
      }

      if (estado.etapa === "pedido_complemento") {
        const complemento = (msg.body || "").trim();
        estado.dados.complemento =
          complemento && complemento.toLowerCase() !== "sem" ? complemento : "";
        const base =
          estado.dados.endereco ||
          (estado.dados._lastCepInfo
            ? formatAddressFromCep(estado.dados._lastCepInfo)
            : "");
        const parts = [base];
        if (estado.dados.numero) parts.push(`Nº ${estado.dados.numero}`);
        if (estado.dados.complemento)
          parts.push(`Compl.: ${estado.dados.complemento}`);
        estado.dados.endereco = parts.filter(Boolean).join(", ");

        estado.dados.entrega = "Fretado";
        await client.sendMessage(
          from,
          "Método de pagamento (Pix/Dinheiro/Boleto/Depósito Bancário/Cheque):"
        );
        estado.etapa = "pedido_pagamento";
        return;
      }

      if (estado.etapa === "pedido_pagamento") {
        estado.dados.pagamento = msg.body || "";
        await sendOrderSummary(from, estado);
        return;
      }

      if (estado.etapa === "pedido_confirm") {
        if (text === "1") {
          await client.sendMessage(
            from,
            `✅ Orçamento confirmado e registrado!\n\nObrigado! Em breve entraremos em contato.\n\nSe quiser voltar ao menu inicial, só digitar "menu".`
          );

          try {
            const targetGroup = CONFIRMED_GROUP_ID;
            const report = buildOrderReportForGroup(estado.dados || {}, from);

            if (targetGroup) {
              try {
                await client.sendMessage(targetGroup, report);
              } catch {}
            }

            const items = Array.isArray(estado.dados.items)
              ? estado.dados.items
              : [];

            const cepInfo =
              estado.dados._lastCepInfo ||
              estado.dados._lastCepInfo_edit ||
              null;
            const cepDigits =
              (cepInfo && cepInfo.cep) ||
              estado.dados._lastCepAttempt ||
              estado.dados._lastCepAttempt_edit ||
              "";

            const payload = items.map((it) => {
              return {
                cep: cepDigits
                  ? cepDigits.replace(/\D/g, "")
                  : String(estado.dados._lastCepAttempt || ""),
                numero: estado.dados.numero || "",
                complemento: estado.dados.complemento || "",
                bairro: (cepInfo && cepInfo.bairro) || "",
                logradouro: (cepInfo && cepInfo.logradouro) || "",
                cidade:
                  (cepInfo && cepInfo.localidade) || estado.dados.cidade || "",
                nome: estado.dados.nome || from,
                produto: it.name,
                metodo_pagamento: estado.dados.pagamento || "",
                preco:
                  it.price != null
                    ? it.price
                    : estado.dados.preco != null
                    ? estado.dados.preco
                    : 0,
                quantidade: Number(it.quantity || 1),
              };
            });

            if (payload.length === 0) {
              smallLog("Nenhum item encontrado para enviar à rota /pedido");
            } else {
              try {
                const resp = await postPedidoAPI(payload);
                smallLog("POST /pedido OK:", resp.status);
                if (targetGroup) {
                  await client.sendMessage(
                    targetGroup,
                    `✅ ${payload.length} pedido(s) gravado(s) no banco com sucesso.`
                  );
                }
              } catch (errApi) {
                smallLog(
                  "Erro ao enviar pedido para API:",
                  errApi && errApi.message ? errApi.message : errApi
                );
                if (targetGroup) {
                  await client.sendMessage(
                    targetGroup,
                    `⚠️ Falha ao gravar pedido no banco: ${String(
                      errApi.message || errApi
                    )}`
                  );
                }
              }
            }
          } catch (err) {
            smallLog(
              "Erro no fluxo de envio de resumo / pedido:",
              err && err.message ? err.message : err
            );
          }

          userState[from] = { etapa: "done", dados: {} };
          return;
        }

        if (text === "2") {
          await client.sendMessage(
            from,
            "✏️ OK, envie o *novo nome* (nome do cliente/loja):"
          );
          estado.etapa = "pedido_edit_nome";
          return;
        }
        if (text === "3") {
          await client.sendMessage(
            from,
            '✏️ OK, envie o *novo item e quantidade* (ex: "Milho Ensacado 25kg" ou "MIL2515"):'
          );
          estado.etapa = "pedido_item";
          estado._editingItem = true;
          return;
        }
        if (text === "4") {
          await client.sendMessage(
            from,
            "✏️ Para alterar o endereço, informe o *CEP* (somente números):"
          );
          estado.etapa = "pedido_cep_edit";
          estado.dados._lastCepAttempt_edit = null;
          estado.dados._lastCepInfo_edit = null;
          return;
        }
        if (text === "5") {
          await client.sendMessage(
            from,
            "✏️ OK, envie o *novo método de pagamento* (Pix/Dinheiro/Boleto/Depósito Bancário/Cheque):"
          );
          estado.etapa = "pedido_edit_pagamento";
          return;
        }

        if (text === "0" || text === "cancel" || text === "cancelar") {
          userState[from] = { etapa: "inicio", dados: {} };
          await client.sendMessage(
            from,
            "Orçamento cancelado. Voltando ao menu inicial..."
          );
          await sendPrimaryMenu(from);
          return;
        }
        await client.sendMessage(
          from,
          "Não entendi sua opção.\n1️⃣confirma \n2️⃣–6️⃣editar \n0️⃣cancelar."
        );
        return;
      }

      if (estado.etapa === "pedido_edit_nome") {
        estado.dados.nome = msg.body || "";
        await client.sendMessage(from, "Nome atualizado.");
        await sendOrderSummary(from, estado);
        return;
      }

      if (estado.etapa === "pedido_edit_item") {
        const body = (msg.body || "").trim();
        estado.dados.itemRaw = body;

        const parsed = parseQuantityAndItem(body);
        estado.dados.quantidade = parsed.qty || 1;
        const itemText =
          parsed.itemText || parsed.itemText === "" ? parsed.itemText : body;

        const itemTextUpper = String(itemText).toUpperCase();
        estado.dados.itemRawUpper = itemTextUpper;

        const match = findCatalogMatch(itemTextUpper);
        if (!match) {
          await client.sendMessage(
            from,
            '❗ Não encontrei esse item no catálogo. Digite o item exatamente como está no catálogo (ex: "Milho Ensacado 25kg" ou "MIL2515").'
          );
          estado.etapa = "pedido_edit_item";
          return;
        }

        estado.dados.itemKey = match.key;
        estado.dados.item = `${estado.dados.quantidade} x ${match.key}`;

        await client.sendMessage(from, "Item/Quantidade atualizado.");
        await sendOrderSummary(from, estado);
        return;
      }
      if (estado.etapa === "pedido_edit_endereco") {
        await client.sendMessage(
          from,
          "✏️ Para alterar o endereço, informe o *CEP* (somente números):"
        );
        estado.etapa = "pedido_cep_edit";
        estado.dados._lastCepAttempt_edit = null;
        estado.dados._lastCepInfo_edit = null;
        return;
      }
      if (estado.etapa === "pedido_cep_edit") {
        const body = (msg.body || "").trim();

        const cepDigits = body.replace(/\D/g, "").slice(0, 8);
        if (cepDigits.length !== 8) {
          await client.sendMessage(
            from,
            "CEP inválido. Digite o CEP com 8 dígitos (ex: 12345678)."
          );
          return;
        }

        await client.sendMessage(from, "🔎 Consultando endereço pelo CEP...");
        const cepInfo = await lookupCepRaw(cepDigits);
        estado.dados._lastCepAttempt_edit = cepDigits;
        estado.dados._lastCepInfo_edit = cepInfo || null;

        if (!cepInfo) {
          await client.sendMessage(
            from,
            "CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos)."
          );
          estado.etapa = "pedido_cep_edit";
          return;
        }

        const addrText = formatAddressFromCep(cepInfo);
        await client.sendMessage(
          from,
          `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (continuar número e complemento)\n2️⃣ Tentar outro CEP`
        );
        estado.etapa = "pedido_cep_edit_confirm";
        return;
      }

      if (estado.etapa === "pedido_cep_edit_confirm") {
        const opt = (msg.body || "").trim();

        if (opt === "1") {
          const info = estado.dados._lastCepInfo_edit;
          if (!info) {
            await client.sendMessage(
              from,
              "Erro interno: informação de CEP ausente. Por favor digite o CEP novamente:"
            );
            estado.etapa = "pedido_cep_edit";
            return;
          }
          const base = formatAddressFromCep(info);
          estado.dados.endereco = base;
          await client.sendMessage(
            from,
            "Certo, agora envie o *número* da residência/loja:"
          );
          estado.etapa = "pedido_numero_edit";
          return;
        }

        if (opt === "2") {
          await client.sendMessage(from, "Ok. Digite o CEP novamente:");
          estado.etapa = "pedido_cep_edit";
          return;
        }

        const possibleCep = (msg.body || "").replace(/\D/g, "").slice(0, 8);
        if (possibleCep.length === 8) {
          const cepInfo = await lookupCepRaw(possibleCep);
          estado.dados._lastCepAttempt_edit = possibleCep;
          estado.dados._lastCepInfo_edit = cepInfo || null;

          if (!cepInfo) {
            await client.sendMessage(
              from,
              "CEP não encontrado. Por favor, verifique e envie o CEP novamente (8 dígitos)."
            );
            estado.etapa = "pedido_cep_edit";
            return;
          }

          const addrText = formatAddressFromCep(cepInfo);
          await client.sendMessage(
            from,
            `Endereço encontrado:\n${addrText}\n\n1️⃣ Está correto (continuar número e complemento)\n2️⃣ Tentar outro CEP`
          );
          estado.etapa = "pedido_cep_edit_confirm";
          return;
        }

        await client.sendMessage(
          from,
          "Opção inválida. Responda 1 (correto) ou envie um CEP válido com 8 dígitos."
        );
        return;
      }

      if (estado.etapa === "pedido_numero_edit") {
        const numero = (msg.body || "").trim();
        estado.dados.numero = numero;
        await client.sendMessage(
          from,
          'Se tiver complemento, envie agora (ex: "Apto 101" ou "sem"):'
        );
        estado.etapa = "pedido_complemento_edit";
        return;
      }

      if (estado.etapa === "pedido_complemento_edit") {
        const complemento = (msg.body || "").trim();
        estado.dados.complemento =
          complemento && complemento.toLowerCase() !== "sem" ? complemento : "";
        const base =
          estado.dados.endereco ||
          (estado.dados._lastCepInfo_edit
            ? formatAddressFromCep(estado.dados._lastCepInfo_edit)
            : "");
        const parts = [base];
        if (estado.dados.numero) parts.push(`Nº ${estado.dados.numero}`);
        if (estado.dados.complemento)
          parts.push(`Compl.: ${estado.dados.complemento}`);
        estado.dados.endereco = parts.filter(Boolean).join(", ");
        await client.sendMessage(from, "Endereço atualizado.");
        await sendOrderSummary(from, estado);
        return;
      }

      if (estado.etapa === "pedido_edit_pagamento") {
        estado.dados.pagamento = msg.body || "";
        await client.sendMessage(from, "Método de pagamento atualizado.");
        await sendOrderSummary(from, estado);
        return;
      }

      if (estado.etapa === "duvidas") {
        if (text === "1") {
          await msg.reply(
            '📌 FAQ:\n- Horário: 08h–18h\n- Pagamento: Pix, Dinheiro, Boleto, Depósito Bancário, Cheque\n\nSe quiser voltar ao menu inicial, só digitar "menu".'
          );
          estado.etapa = "fim";
          return;
        } else if (text === "2") {
          await msg.reply("Escreva sua dúvida e enviaremos a um funcionário:");
          estado.etapa = "duvida_escrita";
          return;
        } else if (text === "0") {
          estado.etapa = "inicio";
          await sendPrimaryMenu(from);
          return;
        } else {
          await msg.reply("Responda 1, 2 ou 0.");
          return;
        }
      }
      if (estado.etapa === "duvida_escrita") {
        estado.dados.duvida = msg.body || "";

        await client.sendMessage(
          from,
          '📩 Sua dúvida foi registrada. Em breve retornaremos por aqui.\n\nSe quiser voltar ao menu inicial, só digitar "menu".'
        );

        (async () => {
          const targetGroup = DUVIDAS_GROUP_ID || STAFF_CHAT_ID;
          if (targetGroup) {
            const snippet = String(estado.dados.duvida || "").trim();
            const fromNumber = String(from || "desconhecido")
              .replace(/@c\.us$/i, "")
              .replace(/\D/g, "");
            const groupMsg = [
              "📩 *Nova Dúvida Recebida*",
              `De: ${fromNumber}`,
              "Mensagem:",
              snippet || "(sem texto)",
            ].join("\n");
            await client.sendMessage(targetGroup, groupMsg);
          }
        })();

        userState[from] = { etapa: "done", dados: {} };
        return;
      }

      if (estado.etapa === "fim") {
        if (text === "0" || text === "menu" || text === "voltar") {
          userState[from] = { etapa: "inicio", dados: {} };
          await client.sendMessage(from, "Voltando ao menu inicial...");
          await sendPrimaryMenu(from);
          return;
        }
        await msg.reply(
          'Se precisar de algo, responda "menu" ou digite "1" para ver o catálogo.'
        );
        return;
      }
      await sendPrimaryMenu(from);
    } catch (err) {
      smallLog(
        "Erro no handler de mensagem:",
        err && err.message ? err.message : err
      );
    }
  });

  return client;
}
// Inicialização com retries/fallback
async function tryInitializeFlow({ torPort, chromePath }) {
  async function attempt({ useTor, useSystemChrome, chromePathOverride }) {
    const puppOpt = connections.buildPuppeteerOptions({
      torPort: useTor ? torPort : null,
      useSystemChrome: !!useSystemChrome,
      chromePath: chromePathOverride || null,
    });
    const client = createClient(puppOpt);
    try {
      await client.initialize();
      return { client };
    } catch (e) {
      try {
        await client.destroy();
      } catch (_) {}
      return { error: e };
    }
  }

  smallLog("Tentativa 1: init (com Tor se disponível).");
  const chromeExists = !!chromePath;
  let res1 = await attempt({
    useTor: !!torPort,
    useSystemChrome: chromeExists,
    chromePathOverride: chromePath,
  });
  if (res1.client) return res1.client;

  const msg1 =
    res1.error && res1.error.message ? res1.error.message : String(res1.error);
  if (/Execution context was destroyed|Runtime.callFunctionOn/i.test(msg1)) {
    smallLog("Erro Execution context — retry com Chromium embutido.");
    const res2 = await attempt({
      useTor: !!torPort,
      useSystemChrome: false,
      chromePathOverride: null,
    });
    if (res2.client) return res2.client;

    smallLog("Tentativa 3: sem Tor.");
    const envBackup = connections.clearProxyEnv();
    const res3 = await attempt({
      useTor: false,
      useSystemChrome: false,
      chromePathOverride: null,
    });
    connections.restoreProxyEnv(envBackup);
    if (res3.client) return res3.client;
    throw res3.error || res2.error || res1.error;
  } else {
    smallLog("Erro não Execution context — fallback sem Tor.");
    const envBackup = connections.clearProxyEnv();
    const resFb = await attempt({
      useTor: false,
      useSystemChrome: false,
      chromePathOverride: null,
    });
    connections.restoreProxyEnv(envBackup);
    if (resFb.client) return resFb.client;
    throw resFb.error || res1.error;
  }
}

(async () => {
  smallLog("iniciando...");
  const { torExec, torPort, chromePath } =
    await connections.getStartupOptions();
  if (torPort) smallLog("Tor detectado em", torPort);
  else smallLog("Sem Tor");
  if (torExec) smallLog("Tor executable:", torExec);
  if (chromePath) smallLog("Chrome detectado em", chromePath);
  else smallLog("Chrome não detectado, usará Chromium embutido.");
  try {
    const client = await tryInitializeFlow({ torPort, chromePath });
  } catch (err) {
    console.error(
      "Falha ao inicializar cliente:",
      err && err.message ? err.message : String(err)
    );
    process.exit(1);
  }
})();
