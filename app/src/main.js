// main.js
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
} = require("electron");
const path = require("path");
const fs = require("fs");
const log = require("electron-log");
const { spawn } = require("child_process");

let win;
let tray;
let botProc = null;

/**
 * Observação sobre caminhos (seu layout):
 * - main.js está em: bot-tcc/app/src  -> __dirname aponta para .../app/src
 * - ícone está em:   bot-tcc/app/src/assets
 * - bot está em:     bot-tcc/bot/index.js
 *
 * Portanto:
 * - iconPath = path.join(__dirname, "assets", "icon.ico")
 * - botPath  = path.join(__dirname, "..", "..", "bot", "index.js")
 */

/** Proteção global para promessas rejeitadas (ajuda no debug) */
process.on("unhandledRejection", (reason, promise) => {
  log.error("Unhandled Rejection at:", promise, "reason:", reason);
});

/** Proteção global para exceções não tratadas (evita crash silencioso) */
process.on("uncaughtException", (err) => {
  log.error("Uncaught Exception:", err);
});

/**
 * Cria a janela principal. Se o ícone existir e for válido, passa-o.
 */
function createWindow() {
  const iconPathCandidate = path.join(__dirname, "assets", "icon.ico"); // ajustado pra sua estrutura
  let winIcon = null;

  try {
    if (fs.existsSync(iconPathCandidate)) {
      const ni = nativeImage.createFromPath(iconPathCandidate);
      if (!ni.isEmpty()) {
        winIcon = ni;
        log.info("Ícone da janela carregado:", iconPathCandidate);
      } else {
        log.warn(
          "Ícone existe mas é inválido (nativeImage vazio):",
          iconPathCandidate
        );
      }
    } else {
      log.warn("Ícone não encontrado em:", iconPathCandidate);
    }
  } catch (err) {
    log.error("Erro ao carregar ícone da janela:", err);
  }

  win = new BrowserWindow({
    width: 420,
    height: 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
    ...(winIcon ? { icon: winIcon } : {}),
  });

  win.loadFile(path.join(__dirname, "index.html"));

  win.on("closed", () => {
    win = null;
  });
}

/**
 * Inicia o bot como child process (apenas se não estiver rodando).
 */
function startBot() {
  if (botProc) {
    log.info("Bot já está rodando, startBot() ignorado.");
    return;
  }

  const botPath = path.join(__dirname, "..", "..", "bot", "index.js"); // ../.. porque main.js está em src/
  log.info("Iniciando bot em:", botPath);

  try {
    const nodeExe = process.execPath.includes("node.exe")
      ? process.execPath
      : process.execPath.replace("node.exe", "node");

    botProc = spawn(nodeExe, [botPath], {
      cwd: path.dirname(botPath),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    botProc.on("error", (err) => {
      log.error("Erro ao iniciar processo do bot:", err);
      sendLogToWindow("[bot error] " + err.toString());
      botProc = null;
    });

    let stdoutBuf = "";
    botProc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      for (const line of lines) {
        handleBotStdoutLine(line);
      }
    });

    botProc.stderr.on("data", (chunk) => {
      const txt = chunk.toString();
      log.error("[bot stderr]", txt);
      sendLogToWindow("[stderr] " + txt);
    });

    botProc.on("close", (code, signal) => {
      log.info("Bot finalizado. code=", code, "signal=", signal);
      sendLogToWindow(`[bot closed] code=${code} signal=${signal}`);
      botProc = null;
    });

    sendLogToWindow("[bot] iniciado");
  } catch (err) {
    log.error("Exceção ao tentar iniciar bot:", err);
    sendLogToWindow("[bot error] " + err.toString());
    botProc = null;
  }
}

/**
 * Processa linhas do stdout do bot.
 */
function handleBotStdoutLine(line) {
  if (!line) return;
  if (line.startsWith("QR_IMAGE::")) {
    const dataUrl = line.slice("QR_IMAGE::".length).trim();
    log.info("QR capturado");
    if (win && !win.isDestroyed()) win.webContents.send("qr", dataUrl);
    return;
  }
  sendLogToWindow(line);
}

/**
 * Envia logs ao renderer (se existir).
 */
function sendLogToWindow(msg) {
  log.info("LOG ->", msg);
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send("log", msg);
    } catch (err) {
      log.warn("Falha ao enviar log para renderer:", err);
    }
  }
}

/**
 * Cria a tray de sistema, se houver ícone válido.
 */
function createTrayIfPossible() {
  const iconPath = path.join(__dirname, "assets", "icon.ico"); // ajustado pra sua estrutura
  try {
    if (fs.existsSync(iconPath)) {
      const ni = nativeImage.createFromPath(iconPath);
      if (!ni.isEmpty()) {
        tray = new Tray(ni);
        const contextMenu = Menu.buildFromTemplate([
          {
            label: "Abrir",
            click: () => {
              if (win) win.show();
            },
          },
          { label: "Iniciar Bot", click: startBot },
          {
            label: "Parar Bot",
            click: () => {
              if (botProc) {
                botProc.kill();
              }
            },
          },
          { type: "separator" },
          { label: "Sair", click: () => app.quit() },
        ]);
        tray.setToolTip("Bot WhatsApp");
        tray.setContextMenu(contextMenu);
        log.info("Tray criada com ícone:", iconPath);
      } else {
        log.warn("Ícone da tray inválido (nativeImage vazio):", iconPath);
      }
    } else {
      log.warn(
        "Ícone da tray não encontrado em:",
        iconPath,
        "=> não criando tray."
      );
    }
  } catch (err) {
    log.error("Erro ao criar a tray:", err);
  }
}

/** Quando o app estiver pronto, cria janela, tray e inicia bot (opcional) */
app.whenReady().then(() => {
  createWindow();
  createTrayIfPossible();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (win && win.isMinimized()) {
      win.restore();
      win.show();
    }
  });
});

/**
 * Quando todas as janelas fecharem:
 * - Se houver tray, só escondemos a janela e mantemos o app rodando.
 * - Caso contrário, comportamos como padrão (sair exceto no mac).
 */
app.on("window-all-closed", (e) => {
  if (tray) {
    e.preventDefault();
    if (win && !win.isDestroyed()) win.hide();
  } else {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }
});

/** Antes do quit, tenta encerrar o bot se estiver rodando */
app.on("before-quit", () => {
  if (botProc) {
    try {
      botProc.kill();
      log.info("Enviando kill ao processo do bot antes de sair.");
    } catch (err) {
      log.warn("Erro ao tentar matar botProc no before-quit:", err);
    }
  }
});

/** IPC do renderer */
ipcMain.on("start-bot", () => startBot());
ipcMain.on("stop-bot", () => {
  if (botProc) {
    try {
      botProc.kill();
    } catch (err) {
      log.warn("Erro ao tentar parar bot via IPC:", err);
    }
  }
});
