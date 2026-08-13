/* reader.js — lógica da página index.html (uso em campo).
   Só lê o que já foi importado via admin.html. Sem scanner de câmera
   embutido — o QR é lido pela câmera nativa do celular / Google Lens,
   que abre o link direto (?doc=X&tag=Y), tratado aqui na inicialização. */

// ---------- Navegação entre views ----------
const views = ["scan", "viewer"];
function showView(name) {
  views.forEach((v) => {
    document.getElementById("view-" + v).classList.toggle("hidden", v !== name);
  });
  document.querySelectorAll("nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
}
document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => showView(b.dataset.view));
});

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

  // renderiza numa resolução bem maior que a tela, para que o zoom por
  // pinça mostre detalhe de verdade em vez de ampliar pixels grosseiros
  const QUALITY_BOOST = 3;
  const MAX_DIMENSION = 4200; // limite de segurança para não travar aparelhos mais fracos

  let scale = (containerWidth * QUALITY_BOOST / baseViewport.width) * (window.devicePixelRatio || 1);
  const projectedWidth = baseViewport.width * scale;
  const projectedHeight = baseViewport.height * scale;
  if (Math.max(projectedWidth, projectedHeight) > MAX_DIMENSION) {
    scale *= MAX_DIMENSION / Math.max(projectedWidth, projectedHeight);
  }

  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = "100%";
  canvas.style.height = "auto";
  await page.render({ canvasContext: ctx, viewport }).promise;
  document.getElementById("pageIndicator").textContent =
    `pág. ${pageNum} de ${currentPdfDoc.numPages}`;
  resetZoom();
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

// ---------- Zoom por pinça + pan (touch) ----------
let zoomScale = 1, zoomTx = 0, zoomTy = 0;
let pinchStartDist = null;
let panActive = false;
let panStart = { x: 0, y: 0 };
let panOrigin = { x: 0, y: 0 };
let lastTapTime = 0;

function applyZoomTransform() {
  const canvas = document.getElementById("pageCanvas");
  canvas.style.transform = `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale})`;
}
function resetZoom() {
  zoomScale = 1;
  zoomTx = 0;
  zoomTy = 0;
  applyZoomTransform();
}
function touchDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

const zoomWrap = document.getElementById("pageCanvasWrap");
zoomWrap.addEventListener(
  "touchstart",
  (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
    } else if (e.touches.length === 1) {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        resetZoom();
      }
      lastTapTime = now;
      if (zoomScale > 1) {
        panActive = true;
        panStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        panOrigin = { x: zoomTx, y: zoomTy };
      }
    }
  },
  { passive: true }
);
zoomWrap.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length === 2 && pinchStartDist) {
      e.preventDefault();
      const dist = touchDistance(e.touches[0], e.touches[1]);
      const ratio = dist / pinchStartDist;
      zoomScale = Math.min(Math.max(zoomScale * ratio, 1), 5);
      pinchStartDist = dist;
      applyZoomTransform();
    } else if (e.touches.length === 1 && panActive) {
      e.preventDefault();
      zoomTx = panOrigin.x + (e.touches[0].clientX - panStart.x);
      zoomTy = panOrigin.y + (e.touches[0].clientY - panStart.y);
      applyZoomTransform();
    }
  },
  { passive: false }
);
zoomWrap.addEventListener("touchend", (e) => {
  if (e.touches.length < 2) pinchStartDist = null;
  if (e.touches.length === 0) panActive = false;
});

// ---------- Deep link via ?doc=X&tag=Y (novo) ou #doc=X&tag=Y (antigo) ----------
async function handleInitialLink() {
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
