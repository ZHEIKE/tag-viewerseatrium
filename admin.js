/* admin.js — lógica da página admin.html (área do preparador).
   Faz TUDO no navegador: lê o PDF (pdf.js), extrai os tags de cada
   página (mesmo padrão usado no extract_tags.py), guarda no IndexedDB
   e gera a folha de etiquetas QR para download. Não depende de nenhuma
   ferramenta externa/Python — só o próprio site. */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// mesmo padrão do extract_tags.py:
// 3 dígitos + 1 letra, seguido de 2 a 4 grupos alfanuméricos separados por hífen
const TAG_PATTERN = /\d{3}[A-Z]-[A-Z0-9]{1,5}(?:-[A-Z0-9]{1,5}){1,3}/g;

async function extractManifestFromPdf(pdfDoc, docId, sourceName) {
  const tagToPages = {};
  const pagesWithoutTag = [];
  const pageCount = pdfDoc.numPages;

  for (let i = 1; i <= pageCount; i++) {
    const page = await pdfDoc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join("");
    const found = new Set((text.match(TAG_PATTERN) || []));
    if (found.size === 0) pagesWithoutTag.push(i);
    found.forEach((tag) => {
      if (!tagToPages[tag]) tagToPages[tag] = [];
      tagToPages[tag].push(i);
    });
  }

  return {
    doc_id: docId,
    source_file: sourceName,
    page_count: pageCount,
    tags: tagToPages,
    pages_without_tag: pagesWithoutTag,
  };
}

// ---------- Processar + importar ----------
const fileInput = document.getElementById("filePdf");
const docIdInput = document.getElementById("docIdInput");

fileInput.addEventListener("change", () => {
  const f = fileInput.files[0];
  if (f && !docIdInput.value) {
    docIdInput.value = f.name.replace(/\.pdf$/i, "");
  }
});

document.getElementById("btnProcess").addEventListener("click", async () => {
  const statusEl = document.getElementById("processStatus");
  const file = fileInput.files[0];
  const docId = docIdInput.value.trim();
  const btn = document.getElementById("btnProcess");

  if (!file) return (statusEl.textContent = "Selecione um arquivo PDF.");
  if (!docId) return (statusEl.textContent = "Informe o código do documento (doc_id).");

  btn.disabled = true;
  statusEl.textContent = "Lendo PDF e procurando tags... isso pode levar alguns segundos em PDFs grandes.";

  try {
    const buf = await file.arrayBuffer();
    const pdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
    const manifest = await extractManifestFromPdf(pdfDoc, docId, file.name);

    const nTags = Object.keys(manifest.tags).length;
    if (nTags === 0) {
      statusEl.textContent =
        "Nenhum tag foi encontrado neste PDF. Ele pode usar um padrão de código diferente — " +
        "avise para ajustarmos o reconhecimento antes de importar.";
      btn.disabled = false;
      return;
    }

    await idbSet("manifests", docId, manifest);
    await idbSet("pdfs", docId, buf);

    statusEl.textContent =
      `✅ "${docId}" importado: ${manifest.page_count} páginas, ${nTags} tags encontrados` +
      (manifest.pages_without_tag.length
        ? ` (${manifest.pages_without_tag.length} página(s) sem tag reconhecido: ${manifest.pages_without_tag.join(", ")})`
        : "") + ".";
    toast(`Documento "${docId}" pronto para uso offline.`);
    fileInput.value = "";
    docIdInput.value = "";
    await refreshDocList();
  } catch (err) {
    statusEl.textContent = "Erro ao processar: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Gerar etiquetas QR em PDF (download) ----------
function buildTagUrl(docId, tag) {
  const readerUrl = new URL("index.html", location.href);
  readerUrl.hash = `doc=${encodeURIComponent(docId)}&tag=${encodeURIComponent(tag)}`;
  return readerUrl.href;
}

function makeQrDataUrl(text, sizePx = 220) {
  return new Promise((resolve) => {
    const holder = document.createElement("div");
    holder.style.display = "none";
    document.body.appendChild(holder);
    new QRCode(holder, {
      text,
      width: sizePx,
      height: sizePx,
      correctLevel: QRCode.CorrectLevel.M,
    });
    // qrcodejs renderiza de forma síncrona num <canvas> ou <img>
    setTimeout(() => {
      const canvasEl = holder.querySelector("canvas");
      const dataUrl = canvasEl
        ? canvasEl.toDataURL("image/png")
        : holder.querySelector("img").src;
      document.body.removeChild(holder);
      resolve(dataUrl);
    }, 30);
  });
}

async function downloadLabelsPdf(docId) {
  const manifest = await idbGet("manifests", docId);
  if (!manifest) return toast("Documento não encontrado.");

  const tags = Object.keys(manifest.tags).sort();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const pageW = 210, pageH = 297, margin = 10;
  const cols = 4, rows = 6;
  const cellW = (pageW - 2 * margin) / cols;
  const cellH = (pageH - 2 * margin) / rows;
  const qrSize = Math.min(cellW, cellH) * 0.65;
  const perPage = cols * rows;

  for (let idx = 0; idx < tags.length; idx++) {
    const tag = tags[idx];
    const posInPage = idx % perPage;
    if (idx > 0 && posInPage === 0) doc.addPage();
    const col = posInPage % cols;
    const row = Math.floor(posInPage / cols);
    const x = margin + col * cellW;
    const y = margin + row * cellH;

    const url = buildTagUrl(docId, tag);
    const qrDataUrl = await makeQrDataUrl(url);

    const qrX = x + (cellW - qrSize) / 2;
    const qrY = y + 2;
    doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);

    doc.setFontSize(9);
    doc.setFont(undefined, "bold");
    doc.text(tag, x + cellW / 2, y + qrSize + 8, { align: "center" });
    doc.setFontSize(6);
    doc.setFont(undefined, "normal");
    doc.text(docId, x + cellW / 2, y + qrSize + 12, { align: "center" });

    doc.setDrawColor(180);
    doc.setLineDashPattern([1, 1], 0);
    doc.rect(x + 1, y + 1, cellW - 2, cellH - 2);
    doc.setLineDashPattern([], 0);
  }

  doc.save(`etiquetas_${docId}.pdf`);
}

// ---------- Lista de documentos ----------
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
      <div class="btns">
        <button class="btn ok" data-action="labels" data-doc="${key}">baixar etiquetas QR</button>
        <button class="btn danger" data-action="delete" data-doc="${key}">excluir</button>
      </div>
    `;
    item.querySelector('[data-action="labels"]').addEventListener("click", (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = "gerando...";
      downloadLabelsPdf(key).finally(() => {
        b.disabled = false;
        b.textContent = "baixar etiquetas QR";
      });
    });
    item.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`Remover "${key}" deste aparelho? O pessoal de campo vai perder acesso offline a ele.`)) return;
      await idbDelete("manifests", key);
      await idbDelete("pdfs", key);
      await refreshDocList();
    });
    listEl.appendChild(item);
  }
}

(async function init() {
  await initDB();
  await refreshDocList();
  await registerSW();
})();
