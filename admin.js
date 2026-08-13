/* admin.js — lógica da página admin.html (área do preparador).
   Único lugar do app onde é possível importar/apagar documentos.
   Importa um par manifesto.json + pdf já gerado no PC (extract_tags.py
   ou process_all_blocks.py). */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

document.getElementById("btnImportPair").addEventListener("click", async () => {
  const input = document.getElementById("filePair");
  const files = Array.from(input.files || []);
  const statusEl = document.getElementById("pairStatus");

  const manifestFile = files.find((f) => f.name.toLowerCase().endsWith(".json"));
  const pdfFile = files.find((f) => f.name.toLowerCase().endsWith(".pdf"));

  if (!manifestFile || !pdfFile) {
    statusEl.textContent = "Selecione os DOIS arquivos juntos: o .manifest.json e o .pdf.";
    return;
  }

  try {
    const manifestText = await manifestFile.text();
    const manifest = JSON.parse(manifestText);
    if (!manifest.doc_id || !manifest.tags) throw new Error("manifesto em formato inválido (falta doc_id ou tags)");

    const pdfBuf = await pdfFile.arrayBuffer();

    if (manifest.page_count) {
      try {
        const testDoc = await pdfjsLib.getDocument({ data: pdfBuf.slice(0) }).promise;
        if (testDoc.numPages !== manifest.page_count) {
          statusEl.textContent =
            `Atenção: o manifesto espera ${manifest.page_count} páginas, mas o PDF selecionado tem ${testDoc.numPages}. ` +
            `Confira se são o par correto antes de usar em produção.`;
        }
      } catch (_) { /* não bloqueia a importação por causa disso */ }
    }

    await idbSet("manifests", manifest.doc_id, manifest);
    await idbSet("pdfs", manifest.doc_id, pdfBuf);

    statusEl.textContent = `✅ "${manifest.doc_id}" importado: ${Object.keys(manifest.tags).length} tags, PDF salvo.`;
    toast(`Documento "${manifest.doc_id}" pronto para uso offline.`);
    input.value = "";
    await refreshDocList();
  } catch (err) {
    statusEl.textContent = "Erro ao importar: " + err.message;
  }
});

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
