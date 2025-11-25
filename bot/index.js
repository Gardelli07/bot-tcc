import dotenv from "dotenv";
dotenv.config();

import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

import qrcode from "qrcode-terminal";
import qrcodeLib from "qrcode";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import axios from "axios";
import connections from "./connections.js";
import { loadCatalogFromApi } from "./bot_catalog_loader.js";
import { fileURLToPath } from "url";
import api from "./api/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMMAND_GROUP = process.env.COMMAND_GROUP_ID || "120363405061423609@g.us";
const CONFIRMED_GROUP_ID =
  process.env.CONFIRMED_GROUP_ID || process.env.PEDIDOS_CONFIRMADOS_ID || null;
const DUVIDAS_GROUP_ID = process.env.DUVIDAS_GROUP_ID || null;

let CATALOG = { items: [], byName: new Map(), byCode: new Map(), source: null };

(async function loadRemoteCatalogIfAvailable() {
  try {
    const remote = await loadCatalogFromApi(api, {
      suffixes: ["ens", "out", "prod"],
    });
    const items = [];
    for (const [origName, code] of Object.entries(
      remote.byOriginalName || {}
    )) {
      items.push({
        name: String(origName).trim(),
        code: String(code || "").trim(),
        price: null,
      });
    }
    const byName = new Map();
    const byCode = new Map();
    for (const it of items) {
      const n = normalizeString(it.name);
      const c = normalizeString(it.code);
      const entry = { name: it.name, code: it.code, price: it.price || null };
      if (n) byName.set(n, entry);
      if (c) byCode.set(c, entry);
    }
    CATALOG = { items, byName, byCode, source: "api" };
    smallLog("CATALOG atualizado a partir da API", items.length, "itens");
  } catch (err) {
    smallLog(
      "Não foi possível carregar catálogo da API (mantendo catalog_items.json):",
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
  // log completo do que vamos enviar (formatado)
  try {
    smallLog(
      "POST /pedido — payload (compact):",
      Array.isArray(data) ? `${data.length} itens` : ""
    );
    console.log(
      ">>> POST /pedido payload (full):\n",
      JSON.stringify(data, null, 2)
    );
  } catch (e) {
    console.log("Erro ao logar payload:", e);
  }

  return api
    .post("/pedido", data)
    .then((res) => {
      // log da resposta completa (útil para debug)
      smallLog(`POST /pedido OK — status ${res.status}`);
      try {
        console.log(
          "<<< POST /pedido response body:\n",
          JSON.stringify(res.data, null, 2)
        );
      } catch (_) {}
      return { status: res.status, body: res.data };
    })
    .catch((err) => {
      // log detalhado do erro antes de re-throw
      if (err.response) {
        smallLog(
          `API /pedido respondeu ${
            err.response.status
          } — body: ${JSON.stringify(err.response.data)}`
        );
        console.error(
          "API /pedido erro (response):",
          err.response.status,
          err.response.data
        );
        throw new Error(
          `API /pedido respondeu ${err.response.status}: ${JSON.stringify(
            err.response.data
          )}`
        );
      }
      console.error("API /pedido erro (no response):", err);
      throw err;
    });
}

async function ensureClientExists({
  nome,
  telefone,
  cep,
  numero,
  complemento,
  email,
}) {
  try {
    const payload = {
      nome: nome || "Sem Nome",
      telefone: telefone || null,
      cep: cep || null,
      numero: numero || null,
      complemento: complemento || null,
      email: email && String(email).trim() !== "" ? String(email).trim() : null,
      senha: null,
    };
    // remove undefined
    Object.keys(payload).forEach((k) => {
      if (payload[k] === undefined) delete payload[k];
    });

    const resp = await api.post("/cadastro", payload);
    smallLog && smallLog("ensureClientExists:", resp.status, resp.data || "");
    return true;
  } catch (err) {
    smallLog &&
      smallLog(
        "Erro ensureClientExists:",
        err && err.message ? err.message : err
      );
    return false;
  }
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
  const itemsArray = Array.isArray(
    CATALOG && CATALOG.items ? CATALOG.items : []
  )
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
    const candidates = (nameMatches.length ? nameMatches : codeMatches).slice(
      0,
      10
    );
    return { multiple: candidates };
  }

  return null;
}

function parseQuantityAndItem(text) {
  if (!text) return { qty: 1, itemText: "" };

  // Agora o texto é SEMPRE somente o nome do produto
  const itemText = text.trim();

  return { qty: 1, itemText };
}

function smallLog(...args) {
  console.log(...args);
}

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

const inHandoff = new Set();

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

  client.on("qr", async (qr) => {
    // Print ASCII QR to terminal as before
    qrcode.generate(qr, { small: true });

    // Generate DataURL image for Electron app
    try {
      const dataUrl = await qrcodeLib.toDataURL(qr);
      console.log("QR_IMAGE::" + dataUrl);
    } catch (err) {
      console.error("Erro gerando dataUrl do QR:", err);
    }
  });

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
  const catalogFiles = resolveCatalogFiles();

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
      } catch {}
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
      .replace(/@c\.us$/i, "")
      .replace(/\D/g, "");
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
      const authorShort = String(author).replace(/@c\.us$/i, "");

      const targetShort = String(target)
        .replace(/@c\.us$/i, "")
        .replace(/\D/g, "");

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

    if (isFromCommandGroup) {
      const targetShort = String(target)
        .replace(/@c\.us$/i, "")
        .replace(/\D/g, "");

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
      const from = msg.from;
      const textRaw = (msg.body || "").trim();
      const text = textRaw.toLowerCase();
      const isFromCommandGroup = msg.from === COMMAND_GROUP;
      const chatId = msg.fromMe && msg.to ? msg.to : msg.from;
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

      if (text === "menu") {
        userState[from] = { etapa: "inicio", dados: {} };
        await client.sendMessage(from, "Voltando ao menu inicial...");
        await sendPrimaryMenu(from);
        return;
      }

      // === Bloco vendedor (com logs de debug) ===

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

          const getLineValue = (label) => {
            const re = new RegExp("^" + label + ":\\s*(.+)$", "i");
            const found = lines.find((l) => re.test(l));
            return found ? found.replace(re, "$1").trim() : null;
          };

          const fromRaw = getLineValue("De") || getLineValue("DE");
          const senderNormalized = normalizeId(fromRaw) || msg.from || null;

          const senderPhone =
            senderNormalized &&
            String(senderNormalized)
              .replace(/@c\.us$/i, "")
              .trim();

          const nomeLinha = getLineValue("Nome") || getLineValue("NOME") || "";
          const clienteNome =
            nomeLinha ||
            String(senderNormalized || msg.from || "")
              .replace(/@c\.us$/i, "")
              .replace(/\D/g, "") ||
            "Desconhecido";

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

          if (itemLines.length === 0) {
            itemLines = lines.filter((l) => /^\d+\./.test(l));
          }

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

          let cepInfo = null;
          if (cepDigits && cepDigits.length === 8) {
            cepInfo = await lookupCepRaw(cepDigits).catch(() => null);
          }

          const entrega = getLineValue("Entrega") || "";
          const pagamento =
            getLineValue("Pagamento") || getLineValue("Pagamento") || "";

          const parsedItems = [];
          for (const rawLine of itemLines) {
            let ln = rawLine
              .replace(/^\d+\.?\s*/, "")
              .replace(/\(.*?\)/g, "")
              .trim();
            if (!ln) continue;

            const p = parseQuantityAndItem(ln);
            const qty = Number(p.qty || 1);
            const itemText = (p.itemText || ln).trim();

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

          const safeCep = cepDigits && String(cepDigits).replace(/\D/g, "");

          const payload = parsedItems.map((it) => ({
            cep: safeCep && safeCep.length === 8 ? safeCep : null,
            numero:
              numero && String(numero).trim() !== ""
                ? String(numero).trim()
                : null,
            complemento:
              complemento && String(complemento).trim() !== ""
                ? String(complemento).trim()
                : null,
            bairro: cepInfo && cepInfo.bairro ? cepInfo.bairro : null,
            logradouro:
              cepInfo && cepInfo.logradouro ? cepInfo.logradouro : null,
            cidade: cepInfo && cepInfo.localidade ? cepInfo.localidade : null,
            nome: clienteNome || null,
            produto: normalizeString(it.name.replace(/^\d+\s*x\s*/i, "")),
            metodo_pagamento:
              pagamento && pagamento.trim() !== "" ? pagamento.trim() : null,
            preco: it.price != null ? Number(it.price) : 0,
            quantidade: Number(it.quantity || 1),

            // marca explícita de origem + campo de status (para o servidor consumir)
            origem: "vendedor",
            Status_pedprod: "Em analise",
          }));

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

          try {
            if (payload.length === 0) {
              smallLog("Payload vazio — nada a enviar para API.");
              await client.sendMessage(
                msg.from,
                "Nenhum item válido para registrar."
              );
            } else {
              // --- garantir cliente mínimo antes de enviar pedidos importados ---
              try {
                const senderPhone =
                  senderNormalized &&
                  String(senderNormalized)
                    .replace(/@c\.us$/i, "")
                    .trim();
                const clienteNomeSafe =
                  clienteNome || senderPhone || "Cliente Vendedor";

                await ensureClientExists({
                  nome: clienteNomeSafe,
                  telefone: senderPhone || null,
                  cep: safeCep && safeCep.length === 8 ? safeCep : null,
                  numero: numero || null,
                  complemento: complemento || null,
                  email: null,
                });
              } catch (e) {
                smallLog &&
                  smallLog(
                    "ensureClientExists (vendedor) erro não-fatal:",
                    e && e.message ? e.message : e
                  );
              }
              // --- fim garantia cliente ---

              // =======================
              // LOGS DETALHADOS ANTES DO POST
              // =======================
              try {
                smallLog(
                  `Preparando envio de ${payload.length} pedido(s) para /pedido (importado)`
                );
                console.log(
                  "===> Payload /pedido (full):\n",
                  JSON.stringify(payload, null, 2)
                );

                payload.forEach((p, idx) => {
                  smallLog(
                    `Pedido[${idx}] produto="${p.produto}" quantidade=${
                      p.quantidade
                    } preco=${p.preco} cep=${p.cep || "null"}`
                  );
                  console.log(`Pedido[${idx}] raw:`, p);
                });
              } catch (e) {
                console.error("Erro ao logar payload antes do envio:", e);
              }

              // =======================
              // CHAMADA À API COM LOGS DE RESPOSTA/ERRO
              // =======================
              try {
                const resp = await postPedidoAPI(payload);
                smallLog("POST /pedido OK (importado):", resp.status);
                try {
                  console.log(
                    "POST /pedido response.body:\n",
                    JSON.stringify(resp.body, null, 2)
                  );
                } catch (_) {}

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
              } catch (errApi) {
                // log detalhado do erro para facilitar debug (produto não encontrado, etc)
                smallLog(
                  "Erro ao enviar pedidos importados para API:",
                  errApi && errApi.message ? errApi.message : errApi
                );
                try {
                  // se for erro Axios contendo response, logue status + body
                  if (errApi && errApi.response) {
                    console.error(
                      "API /pedido erro (response):",
                      errApi.response.status,
                      errApi.response.data
                    );
                  } else {
                    console.error("API /pedido erro (no response):", errApi);
                  }
                } catch (e) {
                  console.error("Erro ao logar errApi:", e);
                }

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

                // mensagem amigável pro vendedor
                await client.sendMessage(
                  msg.from,
                  "Erro ao gravar pedidos importados. Verifique o log."
                );
              }
            }
          } catch (errInner) {
            smallLog(
              "Erro no fluxo de envio (vendedor):",
              errInner && errInner.message ? errInner.message : errInner
            );
            await client.sendMessage(
              msg.from,
              "Erro ao processar orçamento para envio. Veja logs."
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

        return;
      }
      // === fim do bloco vendedor ===

      // === Bloco usuário ===
      if (
        textRaw &&
        textRaw.toLowerCase().startsWith("novo orçamento, usuário")
      ) {
        try {
          smallLog &&
            smallLog(
              "Recebido Orçamento importado (usuário). Iniciando parse..."
            );

          const raw = textRaw.replace(/\r/g, "");
          const lines = raw.split("\n").map((l) => l.trim());

          const getLineValue = (label) => {
            const re = new RegExp("^" + label + ":\\s*(.+)$", "i");
            const found = lines.find((l) => re.test(l));
            return found ? found.replace(re, "$1").trim() : null;
          };

          const fromRaw = getLineValue("De") || getLineValue("DE");
          const senderNormalized = normalizeId(fromRaw) || msg.from || null;

          const senderPhone =
            senderNormalized &&
            String(senderNormalized)
              .replace(/@c\\.us$/i, "")
              .trim();

          const nomeLinha = getLineValue("Nome") || getLineValue("NOME") || "";
          const clienteNome =
            nomeLinha ||
            String(senderNormalized || msg.from || "")
              .replace(/@c\.us$/i, "")
              .replace(/\D/g, "") ||
            "Desconhecido";

          // procurar seção "Itens" (plural) ou fallback para linhas numeradas
          const idxItens = lines.findIndex((l) => /^Itens?:?$/i.test(l));
          let itemLines = [];
          if (idxItens !== -1) {
            for (let i = idxItens + 1; i < lines.length; i++) {
              const L = lines[i];
              if (/^(Total:|---|Endereço:|Entrega:|Pagamento:)/i.test(L)) break;
              if (!L) continue;
              itemLines.push(L);
            }
          }
          if (itemLines.length === 0) {
            // fallback: qualquer linha que comece com "1.", "2."...
            itemLines = lines.filter((l) => /^\d+\./.test(l));
          }

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

          let cepInfo = null;
          if (cepDigits && cepDigits.length === 8) {
            cepInfo = await lookupCepRaw(cepDigits).catch(() => null);
          }

          const entrega = getLineValue("Entrega") || "";
          const pagamento =
            getLineValue("Pagamento") || getLineValue("Pagamento") || "";

          const parsedItems = [];
          for (const rawLine of itemLines) {
            let ln = rawLine
              .replace(/^\d+\.?\s*/, "")
              .replace(/\(.*?\)/g, "")
              .trim();
            if (!ln) continue;

            const p = parseQuantityAndItem(ln);
            const qty = Number(p.qty || 1);
            let itemText = (p.itemText || ln).trim();

            // Remove quantity prefix pattern (e.g., "1 x ", "2 x ") from itemText
            itemText = itemText.replace(/^\d+\s*x\s*/i, "").trim();

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
              "Não foi possível identificar itens no orçamento importado (usuário). Verifique o formato."
            );
            return;
          }

          const safeCep = cepDigits && String(cepDigits).replace(/\D/g, "");

          const payload = parsedItems.map((it) => ({
            cep: safeCep && safeCep.length === 8 ? safeCep : null,
            numero:
              numero && String(numero).trim() !== ""
                ? String(numero).trim()
                : null,
            complemento:
              complemento && String(complemento).trim() !== ""
                ? String(complemento).trim()
                : null,
            bairro: cepInfo && cepInfo.bairro ? cepInfo.bairro : null,
            logradouro:
              cepInfo && cepInfo.logradouro ? cepInfo.logradouro : null,
            cidade: cepInfo && cepInfo.localidade ? cepInfo.localidade : null,
            nome: clienteNome || null,
            telefone: senderPhone || null,
            produto: it.name,
            metodo_pagamento:
              pagamento && pagamento.trim() !== "" ? pagamento.trim() : null,
            preco: it.price != null ? Number(it.price) : 0,
            quantidade: Number(it.quantity || 1),

            // marca explícita de origem + campo de status (para o servidor consumir)
            origem: "usuario",
            Status_pedprod: "Em orçamento",
          }));

          const reportLines = [
            "🧾 Orçamento importado (usuário)",
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
              smallLog &&
                smallLog(
                  "Falha ao enviar relatório para grupo confirmado (usuário):",
                  e && e.message ? e.message : e
                );
            }
          }

          try {
            if (payload.length === 0) {
              smallLog &&
                smallLog("Payload vazio — nada a enviar para API (usuário).");
              await client.sendMessage(
                msg.from,
                "Nenhum item válido para registrar."
              );
            } else {
              // --- garantir cliente mínimo antes de enviar pedidos importados ---
              try {
                const clienteNomeSafe =
                  clienteNome || senderPhone || "Cliente Usuário";

                await ensureClientExists({
                  nome: clienteNomeSafe,
                  telefone: senderPhone || null,
                  cep: safeCep && safeCep.length === 8 ? safeCep : null,
                  numero: numero || null,
                  complemento: complemento || null,
                  email: null,
                });
              } catch (e) {
                smallLog &&
                  smallLog(
                    "ensureClientExists (usuário) erro não-fatal:",
                    e && e.message ? e.message : e
                  );
              }
              // --- fim garantia cliente ---

              const resp = await postPedidoAPI(payload);
              smallLog &&
                smallLog("POST /pedido OK (importado - usuário):", resp.status);
              if (CONFIRMED_GROUP_ID) {
                try {
                  await client.sendMessage(
                    CONFIRMED_GROUP_ID,
                    `✅ ${payload.length} pedido(s) gravado(s) no banco (importado, usuário).`
                  );
                } catch (e) {}
              }
              await client.sendMessage(
                msg.from,
                `Orçamento importado com sucesso — ${payload.length} pedido(s) enviados.`
              );
            }
          } catch (errApi) {
            smallLog &&
              smallLog(
                "Erro ao enviar pedidos importados para API (usuário):",
                errApi && errApi.message ? errApi.message : errApi
              );
            if (CONFIRMED_GROUP_ID) {
              try {
                await client.sendMessage(
                  CONFIRMED_GROUP_ID,
                  `⚠️ Falha ao gravar pedido(s) importado(s) (usuário): ${String(
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
          smallLog &&
            smallLog(
              "Erro ao processar Orçamento importado (usuário):",
              err && err.message ? err.message : err
            );
          try {
            await client.sendMessage(
              msg.from,
              "Erro interno ao processar orçamento importado (usuário). Veja logs."
            );
          } catch (_) {}
        }

        return;
      }
      // === fim do bloco usuário ===

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
            "📝 Para começarmos o orçamento, informe o *nome do cliente/loja*:"
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
            "📝 Para começarmos o orçamento, informe o *nome do cliente/loja*:"
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

      // === Bloco pedido_confirm ===

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

            const lastCepAttempt =
              (cepInfo && cepInfo.cep) ||
              estado.dados._lastCepAttempt ||
              estado.dados._lastCepAttempt_edit ||
              "";
            const safeCepConfirm = lastCepAttempt
              ? String(lastCepAttempt).replace(/\D/g, "")
              : "";

            const payload = items.map((it) => {
              const cidadeVal =
                (cepInfo && cepInfo.localidade) || estado.dados.cidade || null;
              return {
                cep:
                  safeCepConfirm && safeCepConfirm.length === 8
                    ? safeCepConfirm
                    : null,
                numero:
                  estado.dados.numero &&
                  String(estado.dados.numero).trim() !== ""
                    ? String(estado.dados.numero).trim()
                    : null,
                complemento:
                  estado.dados.complemento &&
                  String(estado.dados.complemento).trim() !== ""
                    ? String(estado.dados.complemento).trim()
                    : null,
                bairro: (cepInfo && cepInfo.bairro) || null,
                logradouro: (cepInfo && cepInfo.logradouro) || null,
                cidade: cidadeVal,
                nome: estado.dados.nome || from,
                produto: it.name,
                metodo_pagamento:
                  estado.dados.pagamento &&
                  String(estado.dados.pagamento).trim() !== ""
                    ? String(estado.dados.pagamento).trim()
                    : null,
                preco:
                  it.price != null
                    ? Number(it.price)
                    : estado.dados.preco != null
                    ? Number(estado.dados.preco)
                    : 0,
                quantidade: Number(it.quantity || 1),
              };
            });

            if (payload.length === 0) {
              smallLog("Nenhum item encontrado para enviar à rota /pedido");
            } else {
              // --- garantir cliente mínimo antes de enviar pedidos de confirmação ---
              try {
                const fromPhone = from
                  ? String(from)
                      .replace(/@c\.us$/i, "")
                      .trim()
                  : null;
                const nomeDoPedido =
                  estado.dados.nome || fromPhone || "Cliente";

                await ensureClientExists({
                  nome: nomeDoPedido,
                  telefone: fromPhone || null,
                  cep:
                    safeCepConfirm && safeCepConfirm.length === 8
                      ? safeCepConfirm
                      : null,
                  numero: estado.dados.numero || null,
                  complemento: estado.dados.complemento || null,
                  email: null,
                });
              } catch (e) {
                smallLog &&
                  smallLog(
                    "ensureClientExists (pedido_confirm) erro não-fatal:",
                    e && e.message ? e.message : e
                  );
              }
              // --- fim garantia cliente ---

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

  const chromeExists = !!chromePath;
  let lastError = null;

  // --- Primeiro: tentar SEM Tor ---
  smallLog("Tentativa inicial: sem Tor (navegador do sistema primeiro).");
  // limpamos env de proxy para evitar que o sistema force um proxy mesmo quando não queremos Tor
  const envBackup = connections.clearProxyEnv();
  try {
    if (chromeExists) {
      smallLog(
        "Tentativa 1: sem Tor, usando navegador do sistema:",
        chromePath
      );
      const resSysNoTor = await attempt({
        useTor: false,
        useSystemChrome: true,
        chromePathOverride: chromePath,
      });
      if (resSysNoTor.client) return resSysNoTor.client;
      lastError = resSysNoTor.error;
    }

    smallLog("Tentativa 2: sem Tor, usando Chromium embutido.");
    const resBuiltNoTor = await attempt({
      useTor: false,
      useSystemChrome: false,
      chromePathOverride: null,
    });
    if (resBuiltNoTor.client) return resBuiltNoTor.client;
    lastError = resBuiltNoTor.error || lastError;
  } finally {
    // restaurar env independente do resultado das tentativas sem Tor
    connections.restoreProxyEnv(envBackup);
  }

  // --- Depois: tentar COM Tor (se houver torPort detectado) ---
  if (!torPort) {
    smallLog(
      "Tor não detectado. Não foram bem-sucedidas as tentativas sem Tor; abortando."
    );
    throw lastError || new Error("Falha ao inicializar (sem Tor disponível).");
  }

  smallLog(
    "Tentativas com Tor (já que a inicial sem Tor falhou). Tor em:",
    torPort
  );

  // Tentar com Tor usando navegador do sistema primeiro (se disponível), depois Chromium embutido
  if (chromeExists) {
    smallLog("Tentativa 3: com Tor, usando navegador do sistema:", chromePath);
    const resSysTor = await attempt({
      useTor: true,
      useSystemChrome: true,
      chromePathOverride: chromePath,
    });
    if (resSysTor.client) return resSysTor.client;
    lastError = resSysTor.error || lastError;
  }

  smallLog("Tentativa 4: com Tor, usando Chromium embutido.");
  const resBuiltTor = await attempt({
    useTor: true,
    useSystemChrome: false,
    chromePathOverride: null,
  });
  if (resBuiltTor.client) return resBuiltTor.client;
  lastError = resBuiltTor.error || lastError;

  // se chegou até aqui, todas as tentativas falharam
  throw (
    lastError || new Error("Todas as tentativas de inicialização falharam.")
  );
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
    // você pode usar `client` aqui...
  } catch (err) {
    console.error(
      "Falha ao inicializar cliente:",
      err && err.message ? err.message : String(err)
    );
    process.exit(1);
  }
})();
