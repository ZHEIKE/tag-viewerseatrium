/* reader.js — lógica da página index.html (uso em campo).
   Só lê o que já foi importado via admin.html; não tem nenhuma forma
   de adicionar, editar ou apagar documentos. */

// ---------- Navegação entre views ----------
const views = ["scan", "viewer"];
function showView(name) {
  views.forEach((v) => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== name);
  });
  document.querySelectorAll("nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  if (name !== "scan") stopScan();
}
document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});

// ---------- Câmera + leitura de QR (jsQR) ----------
let stream, scanLoopId;
const video = document.getElementById("video");
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

async function startScan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
    video.srcObject = stream;
    await video.play();
    scanLoopId = requestAnimationFrame(scanFrame);
  } catch (err) {
    toast("Não foi possível acessar a câmera: " + err.message);
  }
}
function stopScan() {
  if (scanLoopId) cancelAnimationFrame(scanLoopId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
function scanFrame() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    scanCanvas.width = video.videoWidth;
    scanCanvas.height = video.videoHeight;
    scanCtx.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
    const imgData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
    const code = jsQR(imgData.data, imgData.width, imgData.height);
    if (code && code.data) {
      handleScannedText(code.data);
      stopScan();
      return;
    }
  }
  scanLoopId = requestAnimationFrame(scanFrame);
}
document.getElementById("btnStartScan").addEventListener("click", startScan);
document.getElementById("btnStopScan").addEventListener("click", stopScan);

function handleScannedText(text) {
  // extrai a parte de parâmetros de qualquer URL escaneada, aceitando
  // tanto ?doc=X&tag=Y (formato atual) quanto #doc=X&tag=Y (formato antigo)
  let query = "";
  const qIdx = text.indexOf("?");
  const hIdx = text.indexOf("#");
  if (qIdx >= 0) {
    query = text.slice(qIdx + 1, hIdx >= 0 && hIdx > qIdx ? hIdx : undefined);
  } else if (hIdx >= 0) {
    query = text.slice(hIdx + 1);
  } else {
    query = text;
  }
  const params = new URLSearchParams(query);
  const doc = params.get("doc");
  const tag = params.get("tag");
  if (!doc || !tag) {
    toast("QR code não reconhecido pelo app.");
    return;
  }
  toast(`Tag ${tag} — abrindo...`);
  openTag(doc, tag);
}

// ---------- Busca manual ----------
document.getElementById("btnGoTag").addEventListener("click", () => {
  const doc = document.getElementById("docSelect").value;
  const tag = document.getElementById("tagInput").value.trim().toUpperCase();
  if (!doc) return toast("Nenhum documento disponível neste aparelho ainda.");
  if (!tag) return toast("Digite um tag.");
  openTag(doc, tag);
});

async function refreshDocSelect() {
  const keys = await idbAllKeys("manifests");
  const sel = document.getElementById("docSelect");
  sel.innerHTML = "";
  const msg = document.getElementById("noDocsMsg");
  if (keys.length === 0) {
    msg.textContent = "Nenhum documento disponível ainda neste aparelho — peça para quem prepara os QR codes importar pela área do preparador.";
  } else {
    msg.textContent = "";
  }
  keys.forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  });
}

// ---------- Visualizador de PDF (pdf.js) ----------
let currentPdfDoc = null;
let currentDocId = null;
let currentTag = null;
let currentPages = [];
let currentPageIdx = 0;

async function openTag(docId, tag) {
  const manifest = await idbGet("manifests", docId);
  if (!manifest) {
    toast(`Documento "${docId}" não está disponível neste aparelho. Peça para importarem na área do preparador.`);
    return;
  }
  const pages = manifest.tags[tag];
  if (!pages || pages.length === 0) {
    toast(`Tag "${tag}" não encontrada em "${docId}".`);
    return;
  }
  const pdfBuf = await idbGet("pdfs", docId);
  if (!pdfBuf) {
    toast(`PDF de "${docId}" não está disponível neste aparelho. Peça para importarem na área do preparador.`);
    return;
  }

  document.getElementById("statusText").textContent = "carregando PDF...";
  currentPdfDoc = await pdfjsLib.getDocument({ data: pdfBuf.slice(0) }).promise;
  currentDocId = docId;
  currentTag = tag;
  currentPages = pages;
  currentPageIdx = 0;
  document.getElementById("statusText").textContent = "offline pronto";

  document.getElementById("viewerTagLabel").textContent = tag;
  document.getElementById("viewerDocLabel").textContent = docId;
  renderOtherPagesRow();
  await renderCurrentPage();
  showView("viewer");
}

function renderOtherPagesRow() {
  const row = document.getElementById("otherPagesRow");
  row.innerHTML = "";
  if (currentPages.length <= 1) return;
  const label = document.createElement("span");
  label.className = "muted";
  label.style.width = "100%";
  label.textContent = "Este tag aparece em mais de uma página:";
  row.appendChild(label);
  currentPages.forEach((p, i) => {
    const b = document.createElement("button");
    b.className = "btn" + (i === currentPageIdx ? " primary" : "");
    b.textContent = "pág. " + p;
    b.addEventListener("click", async () => {
      currentPageIdx = i;
      await renderCurrentPage();
      renderOtherPagesRow();
    });
    row.appendChild(b);
  });
}

async function renderCurrentPage() {
  const pageNum = currentPages[currentPageIdx];
  const page = await currentPdfDoc.getPage(pageNum);
  const canvas = document.getElementById("pageCanvas");
  const ctx = canvas.getContext("2d");
  const containerWidth = document.getElementById("pageCanvasWrap").clientWidth || 360;
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = (containerWidth / baseViewport.width) * (window.devicePixelRatio || 1);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = "100%";
  canvas.style.height = "auto";
  await page.render({ canvasContext: ctx, viewport }).promise;
  document.getElementById("pageIndicator").textContent =
    `pág. ${pageNum} de ${currentPdfDoc.numPages}`;
}

document.getElementById("btnPrevPage").addEventListener("click", async () => {
  if (!currentPdfDoc) return;
  const pageNum = currentPages[currentPageIdx];
  if (pageNum > 1) {
    currentPages = [pageNum - 1];
    currentPageIdx = 0;
    await renderCurrentPage();
  }
});
document.getElementById("btnNextPage").addEventListener("click", async () => {
  if (!currentPdfDoc) return;
  const pageNum = currentPages[currentPageIdx];
  if (pageNum < currentPdfDoc.numPages) {
    currentPages = [pageNum + 1];
    currentPageIdx = 0;
    await renderCurrentPage();
  }
});

// ---------- Deep link via hash (#doc=X&tag=Y) ----------
// ---------- Deep link via ?doc=X&tag=Y (novo) ou #doc=X&tag=Y (antigo) ----------
async function handleInitialLink() {
  // prioriza query string (mais robusta contra apps que removem o #)
  let params = new URLSearchParams(location.search);
  let doc = params.get("doc");
  let tag = params.get("tag");
  if ((!doc || !tag) && location.hash) {
    params = new URLSearchParams(location.hash.slice(1));
    doc = params.get("doc");
    tag = params.get("tag");
  }
  if (doc && tag) {
    await openTag(doc, tag);
  }
}

// ---------- Inicialização ----------
(async function init() {
  await initDB();
  await refreshDocSelect();
  await handleInitialLink();
  window.addEventListener("hashchange", handleInitialLink);
  await registerSW();
})();
