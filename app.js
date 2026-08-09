/* Visualizador de TAGs — lógica principal
   Guarda PDFs e manifestos (tag -> páginas) no IndexedDB do navegador.
   Escaneia QR codes (câmera, offline via jsQR) e abre a página exata
   do PDF correspondente. Funciona 100% offline após a primeira carga
   (o service worker cacheia os assets, incl. pdf.js e jsQR). */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const DB_NAME = "tagviewer-db";
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("pdfs")) d.createObjectStore("pdfs");
      if (!d.objectStoreNames.contains("manifests")) d.createObjectStore("manifests");
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = (e) => reject(e);
  });
}
function idbSet(store, key, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}
function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}
function idbAllKeys(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const r = tx.objectStore(store).getAllKeys();
    r.onsuccess = () => resolve(r.result);
    r.onerror = (e) => reject(e);
  });
}

// ---------- UI: navegação entre views ----------
const views = ["scan", "viewer", "docs"];
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

function toast(msg, ms = 2200) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- Câmera + leitura de QR (jsQR) ----------
let stream, scanLoopId;
const video = document.getElementById("video");
const scanCanvas = document.createElement("canvas");
const scanCtx = scanCanvas.getContext("2d", { willReadFrequently: true });

async function startScan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
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
  // aceita URL completa (https://.../#doc=X&tag=Y) ou apenas "doc=X&tag=Y"
  let hash = text;
  const hashIdx = text.indexOf("#");
  if (hashIdx >= 0) hash = text.slice(hashIdx + 1);
  const params = new URLSearchParams(hash);
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
  if (!doc) return toast("Nenhum documento importado ainda.");
  if (!tag) return toast("Digite um tag.");
  openTag(doc, tag);
});

// ---------- Importação de manifesto + PDF ----------
document.getElementById("fileManifest").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const manifest = JSON.parse(text);
    if (!manifest.doc_id || !manifest.tags) throw new Error("formato inválido");
    await idbSet("manifests", manifest.doc_id, manifest);
    toast(`Manifesto "${manifest.doc_id}" importado (${Object.keys(manifest.tags).length} tags).`);
    await refreshDocList();
    await refreshDocSelect();
  } catch (err) {
    toast("Erro ao importar manifesto: " + err.message);
  }
});

document.getElementById("filePdf").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const docId = prompt(
    "Doc ID deste PDF (deve ser IDÊNTICO ao doc_id do manifesto importado):",
    file.name.replace(/\.pdf$/i, "")
  );
  if (!docId) return;
  try {
    const buf = await file.arrayBuffer();
    await idbSet("pdfs", docId, buf);
    toast(`PDF salvo localmente como "${docId}".`);
    await refreshDocList();
    await refreshDocSelect();
  } catch (err) {
    toast("Erro ao salvar PDF: " + err.message);
  }
});

// ---------- Lista de documentos salvos ----------
async function refreshDocList() {
  const manifestKeys = await idbAllKeys("manifests");
  const pdfKeys = await idbAllKeys("pdfs");
  const listEl = document.getElementById("docList");
  listEl.innerHTML = "";
  if (manifestKeys.length === 0) {
    listEl.innerHTML = '<p class="muted">Nenhum documento importado ainda.</p>';
    return;
  }
  for (const key of manifestKeys) {
    const manifest = await idbGet("manifests", key);
    const hasPdf = pdfKeys.includes(key);
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <div>
        <div><strong>${key}</strong></div>
        <div class="meta">${Object.keys(manifest.tags).length} tags · ${manifest.page_count || "?"} páginas ·
          ${hasPdf ? "✅ PDF salvo" : "⚠️ PDF não importado"}</div>
      </div>
      <button class="btn danger" data-doc="${key}">excluir</button>
    `;
    item.querySelector("button").addEventListener("click", async () => {
      await idbDelete("manifests", key);
      await idbDelete("pdfs", key);
      await refreshDocList();
      await refreshDocSelect();
    });
    listEl.appendChild(item);
  }
}

async function refreshDocSelect() {
  const keys = await idbAllKeys("manifests");
  const sel = document.getElementById("docSelect");
  sel.innerHTML = "";
  keys.forEach((k) => {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k;
    sel.appendChild(opt);
  });
}

// ---------- Visualizador de PDF (pdf.js) ----------
let currentPdfDoc = null; // pdf.js document proxy
let currentDocId = null;
let currentTag = null;
let currentPages = [];
let currentPageIdx = 0;

async function openTag(docId, tag) {
  const manifest = await idbGet("manifests", docId);
  if (!manifest) {
    toast(`Manifesto de "${docId}" não encontrado neste aparelho. Importe-o na aba Documentos.`);
    showView("docs");
    return;
  }
  const pages = manifest.tags[tag];
  if (!pages || pages.length === 0) {
    toast(`Tag "${tag}" não encontrada em "${docId}".`);
    return;
  }
  const pdfBuf = await idbGet("pdfs", docId);
  if (!pdfBuf) {
    toast(`PDF de "${docId}" não encontrado neste aparelho. Importe-o na aba Documentos.`);
    showView("docs");
    return;
  }

  document.getElementById("statusText").textContent = "carregando PDF...";
  // pdf.js precisa de uma cópia do buffer (fica "detached" após uso)
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

// ---------- Deep link via hash (#doc=X&tag=Y) ao abrir o app ----------
async function handleInitialHash() {
  if (!location.hash) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const doc = params.get("doc");
  const tag = params.get("tag");
  if (doc && tag) {
    await openTag(doc, tag);
  }
}

// ---------- Inicialização ----------
(async function init() {
  db = await openDB();
  await refreshDocList();
  await refreshDocSelect();
  await handleInitialHash();
  window.addEventListener("hashchange", handleInitialHash);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
