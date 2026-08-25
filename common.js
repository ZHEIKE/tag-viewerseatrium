/* common.js — compartilhado entre index.html (leitura, uso em campo) e
   admin.html (importação, uso de quem prepara). Ambas as páginas vivem
   no mesmo domínio, então compartilham o mesmo IndexedDB. */

const APP_VERSION = "v12";

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

function toast(msg, ms = 2200) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

async function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

async function initDB() {
  db = await openDB();
}
