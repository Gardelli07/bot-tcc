// connections.js
// Utilitários para detectar Tor, checar porta SOCKS, localizar Chrome e montar opções do puppeteer.
// Exporta funções para serem usadas pelo index.js

import net from 'net';
import child from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * checkTorProxy(timeoutMs)
 * checa localhost nas portas 9150 e 9050 (Tor) e retorna a porta se encontrar, ou null.
 */
async function checkTorProxy(timeout = 300) {
  for (const port of [9150, 9050]) {
    const ok = await new Promise(res => {
      const s = new net.Socket();
      let done = false;
      s.setTimeout(timeout);
      s.on('connect', () => { done = true; s.destroy(); res(port); });
      s.on('timeout', () => { if (!done) { done = true; s.destroy(); res(null); } });
      s.on('error', () => { if (!done) { done = true; res(null); } });
      s.connect(port, '127.0.0.1');
    });
    if (ok) return ok;
  }
  return null;
}

/**
 * findTorBrowser()
 * tenta localizar executável do Tor Browser em caminhos comuns.
 * retorna caminho do executável ou null.
 */
function findTorBrowser() {
  const home = os.homedir();
  const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(pf, 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(pf86, 'Tor Browser', 'Browser', 'firefox.exe'),
    path.join(home, 'tor-browser_en-US', 'Browser', 'firefox'),
    '/Applications/Tor Browser.app/Contents/MacOS/firefox',
    '/opt/tor-browser/Browser/firefox'
  ];
  for (const p of candidates) try { if (fs.existsSync(p)) return p } catch(_) {}
  return null;
}

/**
 * ensureTorRunning(torExec, timeoutMs)
 * tenta executar o Tor Browser (detached) e aguarda até timeoutMs para detectar proxy local.
 * retorna a porta detectada (9150/9050) ou null.
 */
async function ensureTorRunning(torExec, timeoutMs = 15000) {
  try { child.spawn(torExec, [], { detached: true, stdio: 'ignore' }).unref(); } catch(_) {}
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await checkTorProxy(300);
    if (p) return p;
    await wait(500);
  }
  return null;
}

/**
 * clearProxyEnv() / restoreProxyEnv(old)
 * limpa temporariamente variáveis de ambiente de proxy e retorna um backup para restaurar depois.
 */
function clearProxyEnv() {
  const keys = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy'];
  const old = {};
  for (const k of keys) { old[k] = process.env[k]; delete process.env[k]; }
  return old;
}
function restoreProxyEnv(old) { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }

/**
 * buildPuppeteerOptions({torPort=null, useSystemChrome=false, chromePath=null})
 * constrói o objeto de puppeteer (opções) que você passa ao Client do whatsapp-web.js
 */
function buildPuppeteerOptions({torPort=null, useSystemChrome=false, chromePath=null} = {}) {
  const args = [
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--start-maximized','--window-size=1200,900',
    '--disable-blink-features=AutomationControlled'
  ];
  if (torPort) args.push(`--proxy-server=socks5://127.0.0.1:${torPort}`);
  const opt = { headless: false, args, defaultViewport: null };
  if (useSystemChrome && chromePath) opt.executablePath = chromePath;
  return opt;
}

/**
 * findSystemChrome()
 * procura caminho do chrome em Windows (Program Files / Program Files (x86)) e retorna primeiro encontrado ou null.
 */
function findSystemChrome() {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe'),
    // possíveis unix/mac padrões (não exaustivo)
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const p of candidates) try { if (fs.existsSync(p)) return p; } catch(_) {}
  return null;
}

/**
 * getStartupOptions()
 * rotina de conveniência que detecta torExec (Tor Browser), tenta detectar proxy local (torPort)
 * e localiza chromePath. Retorna { torExec, torPort, chromePath }.
 *
 * Ele tenta detectar porta Tor já em execução; se não houver porta mas encontrar o executável do Tor,
 * ele tenta iniciar (ensureTorRunning) e detecta novamente a porta.
 */
async function getStartupOptions() {
  const torExec = findTorBrowser();
  let torPort = await checkTorProxy();
  if (!torPort && torExec) {
    torPort = await ensureTorRunning(torExec, 15000);
  }

  const chromePath = findSystemChrome();
  return { torExec, torPort, chromePath };
}

export default {
  checkTorProxy,
  findTorBrowser,
  ensureTorRunning,
  clearProxyEnv,
  restoreProxyEnv,
  buildPuppeteerOptions,
  findSystemChrome,
  getStartupOptions
};

