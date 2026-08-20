/* admin.js — lógica da página admin.html (área do preparador).
   Único lugar do app onde é possível importar/apagar documentos.
   Importa um par manifesto.json + pdf já gerado no PC (extract_tags.py
   ou process_all_blocks.py). */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

function baseNameOf(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".manifest.json")) return filename.slice(0, -".manifest.json".length);
  if (lower.endsWith(".json")) return filename.slice(0, -".json".length);
  if (lower.endsWith(".pdf")) return filename.slice(0, -".pdf".length);
  return filename;
}

async function importOnePair(manifestFile, pdfFile, statusList) {
  const li = document.createElement("li");
  li.textContent = `${manifestFile.name} + ${pdfFile.name}: importando...`;
  statusList.appendChild(li);
  try {
    const manifestText = await manifestFile.text();
    const manifest = JSON.parse(manifestText);
    if (!manifest.doc_id || !manifest.tags) throw new Error("manifesto em formato inválido (falta doc_id ou tags)");

    const pdfBuf = await pdfFile.arrayBuffer();

    let warning = "";
    if (manifest.page_count) {
      try {
        const testDoc = await pdfjsLib.getDocument({ data: pdfBuf.slice(0) }).promise;
        if (testDoc.numPages !== manifest.page_count) {
          warning = ` ⚠️ manifesto espera ${manifest.page_count} páginas, PDF tem ${testDoc.numPages} — confira se é o par certo.`;
        }
      } catch (_) { /* não bloqueia a importação por causa disso */ }
    }

    await idbSet("manifests", manifest.doc_id, manifest);
    await idbSet("pdfs", manifest.doc_id, pdfBuf);

    li.textContent = `✅ "${manifest.doc_id}": ${Object.keys(manifest.tags).length} tags importados.${warning}`;
  } catch (err) {
    li.textContent = `❌ ${manifestFile.name} + ${pdfFile.name}: erro — ${err.message}`;
  }
}

document.getElementById("btnImportPair").addEventListener("click", async () => {
  const input = document.getElementById("filePair");
  const files = Array.from(input.files || []);
  const statusEl = document.getElementById("pairStatus");
  statusEl.innerHTML = "";

  if (files.length === 0) {
    statusEl.textContent = "Selecione ao menos um par de arquivos (.manifest.json + .pdf).";
    return;
  }

  // agrupa os arquivos selecionados pelo nome-base (ex: "B1" a partir de
  // "B1.manifest.json" e "B1.pdf"), para permitir importar vários
  // documentos de uma vez só
  const groups = {};
  for (const f of files) {
    const base = baseNameOf(f.name);
    if (!groups[base]) groups[base] = {};
    if (f.name.toLowerCase().endsWith(".json")) groups[base].json = f;
    else if (f.name.toLowerCase().endsWith(".pdf")) groups[base].pdf = f;
  }

  const statusList = document.createElement("ul");
  statusList.style.margin = "0";
  statusList.style.paddingLeft = "18px";
  statusList.style.listStyle = "none";
  statusEl.appendChild(statusList);

  const baseNames = Object.keys(groups).sort();
  let missing = [];
  for (const base of baseNames) {
    const { json, pdf } = groups[base];
    if (json && pdf) {
      await importOnePair(json, pdf, statusList);
    } else {
      missing.push(`${base} (falta ${json ? ".pdf" : ".manifest.json"})`);
    }
  }
  if (missing.length) {
    const li = document.createElement("li");
    li.textContent = `⚠️ Incompletos, não importados: ${missing.join(", ")}`;
    statusList.appendChild(li);
  }

  input.value = "";
  toast("Importação concluída — confira a lista de documentos abaixo.");
  await refreshDocList();
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
  const vEl = document.getElementById("versionTag");
  if (vEl) vEl.textContent = `app ${APP_VERSION}`;
})();
