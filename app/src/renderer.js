// renderer.js
const qrImg = document.getElementById("qr");
const terminalBox = document.getElementById("terminalBox");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");

// asset images for connection states
const CONNECTED_IMG = "./assets/qrvalidado.png";
const DISCONNECTED_IMG = "./assets/qrencerrado.png";

/**
 * setQrSrc: fade-out, change src, then fade-in on load
 */
function setQrSrc(src) {
  if (!qrImg) return;
  try {
    qrImg.style.opacity = 0;
  } catch (e) {}
  // ensure a clean onload handler
  qrImg.onload = () => {
    try {
      qrImg.style.opacity = 1;
    } catch (e) {}
    // remove handler to avoid leaks
    qrImg.onload = null;
  };
  qrImg.src = src;
}

// set initial state to disconnected image (with fade)
setQrSrc(DISCONNECTED_IMG);

function appendLog(text) {
  if (!text) return;
  const p = document.createElement("div");
  p.textContent = text;
  terminalBox.appendChild(p);
  terminalBox.scrollTop = terminalBox.scrollHeight;
}

btnStart.addEventListener("click", () => {
  if (window.electronAPI && window.electronAPI.startBot)
    window.electronAPI.startBot();
});

btnStop.addEventListener("click", () => {
  if (window.electronAPI && window.electronAPI.stopBot)
    window.electronAPI.stopBot();
});

if (window.electronAPI) {
  window.electronAPI.onQR((dataUrl) => {
    if (!dataUrl) return;
    // dataUrl from the bot should be shown directly in the QR area (transitions handled by setQrSrc)
    setQrSrc(dataUrl);
    appendLog("[QR recebido] mostrar no painel");
  });

  window.electronAPI.onLog((msg) => {
    appendLog(msg);
    const lower = (msg || "").toLowerCase();
    // connection established -> show validated image
    if (
      lower.includes("ready") ||
      lower.includes("pronto") ||
      lower.includes("conectado") ||
      lower.includes("connected") ||
      lower.includes("auth")
    ) {
      setQrSrc(CONNECTED_IMG);
      appendLog("[Status] Conectado");
      return;
    }

    // connection lost / bot stopped -> show disconnected image
    if (
      lower.includes("closed") ||
      lower.includes("desconect") ||
      lower.includes("disconnec") ||
      lower.includes("bot closed") ||
      lower.includes("bot error") ||
      lower.includes("stderr")
    ) {
      setQrSrc(DISCONNECTED_IMG);
      appendLog("[Status] Desconectado");
      return;
    }
  });
}
