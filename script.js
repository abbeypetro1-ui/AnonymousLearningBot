// LearningAnonymousBot main code. You don't need to edit this file.
(function () {
  const C = BOT_CONFIG;
  const $ = (id) => document.getElementById(id);

  const KEY_NAME = "studyBuddyApiKey";
  const MATERIAL_NAME = "studyBuddyMaterial";
  const STYLE_NAME = "studyBuddyStyle";
  const VECTOR_CACHE_NAME = "learningBotNoteVectors";
  const MAX_MATERIAL = 30000; // characters
  const MAX_NOTE_CHARS = 1500; // longer notes are split into parts
  const EMBED_BATCH_SIZE = 50; // notes per embedding request
  const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";

  // Notes settings from config.js (with safe defaults)
  const USE_KB = C.useKnowledge === true;
  const KB_FILE = C.knowledgeFile || "knowledge.md";
  const KB_METHOD = C.searchMethod === "keywords" ? "keywords" : "meaning";
  const KB_TOPK = Math.max(1, parseInt(C.topK, 10) || 3);
  const EMBED_MODEL = C.embeddingModel || "gemini-embedding-2";
  const KB_RULES = (C.knowledgeRules || "").trim();

  let history = []; // the conversation so far (plain questions and answers)
  let busy = false;

  // ---------- Safe storage helpers (wrapped in try/catch) ----------
  function storeGet(name) {
    try {
      return sessionStorage.getItem(name) || localStorage.getItem(name) || "";
    } catch (e) {
      return "";
    }
  }
  function storeSet(name, value, remember) {
    try { sessionStorage.setItem(name, value); } catch (e) {}
    try {
      if (remember) localStorage.setItem(name, value);
      else localStorage.removeItem(name);
    } catch (e) {}
  }
  function storeRemove(name) {
    try { sessionStorage.removeItem(name); } catch (e) {}
    try { localStorage.removeItem(name); } catch (e) {}
  }
  function isRemembered(name) {
    try { return !!localStorage.getItem(name); } catch (e) { return false; }
  }

  // ---------- Setup from config ----------
  document.title = C.name;
  document.documentElement.style.setProperty("--accent", C.themeColor);
  document.documentElement.style.setProperty("--accent2", C.themeColor2);
  $("botEmoji").textContent = C.emoji;
  $("botName").textContent = C.name;
  $("botTagline").textContent = C.tagline;

  C.learningStyles.forEach((s, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = s.label;
    $("styleSelect").appendChild(opt);
  });
  const savedStyle = parseInt(storeGet(STYLE_NAME), 10);
  if (!isNaN(savedStyle) && C.learningStyles[savedStyle]) {
    $("styleSelect").value = savedStyle;
  }
  $("styleSelect").addEventListener("change", () => {
    storeSet(STYLE_NAME, $("styleSelect").value, false);
  });

  // ---------- Safe formatting: escape HTML first, then allow bold + bullets ----------
  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function inline(text) {
    return text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }
  function formatText(raw) {
    const lines = escapeHtml(raw).split("\n");
    let html = "";
    let inList = false;
    lines.forEach((line) => {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + inline(bullet[1]) + "</li>";
      } else {
        if (inList) { html += "</ul>"; inList = false; }
        if (line.trim() !== "") html += "<p>" + inline(line) + "</p>";
      }
    });
    if (inList) html += "</ul>";
    return html;
  }

  // ---------- Chat bubbles ----------
  function addBubble(kind, text) {
    const div = document.createElement("div");
    div.className = "bubble " + kind;
    if (kind === "user") div.textContent = text;
    else div.innerHTML = formatText(text);
    $("messages").appendChild(div);
    scrollDown();
    return div;
  }
  function addThinking() {
    const div = document.createElement("div");
    div.className = "bubble bot";
    div.innerHTML = '<div class="dots"><span></span><span></span><span></span></div>';
    $("messages").appendChild(div);
    scrollDown();
    return div;
  }
  function scrollDown() {
    const m = $("messages");
    m.scrollTop = m.scrollHeight;
  }

  // ---------- Copy button (shown under each AI reply) ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // Older browsers: use a hidden text box instead
      try {
        const box = document.createElement("textarea");
        box.value = text;
        box.style.position = "fixed";
        box.style.opacity = "0";
        document.body.appendChild(box);
        box.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(box);
        return ok;
      } catch (e2) {
        return false;
      }
    }
  }
  function addCopyButton(text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "📋 Copy";
    btn.addEventListener("click", async () => {
      const ok = await copyText(text);
      btn.textContent = ok ? "✅ Copied!" : "Couldn't copy";
      setTimeout(() => { btn.textContent = "📋 Copy"; }, 1800);
    });
    $("messages").appendChild(btn);
    scrollDown();
  }

  // ==========================================================
  //  YOUR NOTES (knowledge.md): load, search, and show sources
  // ==========================================================
  let notes = [];            // each: { title, part, parts, text, vector }
  let kbState = "off";       // "loading" | "missing" | "empty" | "ready"
  let meaningState = "none"; // "none" | "needkey" | "preparing" | "ready" | "failed"
  let meaningWhy = "";       // why preparing meaning search failed
  let queryProblem = "";     // why the last question could not use meaning search
  let fingerprint = "";      // changes whenever knowledge.md changes
  let kbPromise = Promise.resolve();

  // A small, fast "fingerprint" of a piece of text (cyrb53 hash)
  function hashText(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Split one long note at blank lines so each part is about MAX_NOTE_CHARS or less
  function splitLong(body) {
    if (body.length <= MAX_NOTE_CHARS) return [body];
    const paragraphs = body.split(/\n\s*\n/);
    const parts = [];
    let current = "";
    paragraphs.forEach((p) => {
      const joined = current ? current + "\n\n" + p : p;
      if (current && joined.length > MAX_NOTE_CHARS) {
        parts.push(current);
        current = p;
      } else {
        current = joined;
      }
    });
    if (current) parts.push(current);
    return parts;
  }

  // Turn the file into notes. Everything above the first "## " line is ignored.
  function parseNotes(raw) {
    const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const chunks = text.split(/^## /m).slice(1);
    const result = [];
    chunks.forEach((chunk) => {
      const newline = chunk.indexOf("\n");
      const title = (newline === -1 ? chunk : chunk.slice(0, newline)).trim() || "Untitled note";
      const body = (newline === -1 ? "" : chunk.slice(newline + 1)).trim();
      if (!body) return;
      const parts = splitLong(body);
      parts.forEach((part, i) => {
        result.push({ title: title, part: i + 1, parts: parts.length, text: part, vector: null });
      });
    });
    return result;
  }

  function displayTitle(note) {
    return note.parts > 1 ? note.title + " (part " + note.part + " of " + note.parts + ")" : note.title;
  }
  function docText(note) {
    return "title: " + note.title + " | text: " + note.text;
  }

  // ----- Embeddings (turning text into numbers that capture meaning) -----
  async function embedBatch(texts, key) {
    const url = API_BASE + encodeURIComponent(EMBED_MODEL) + ":batchEmbedContents";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: "models/" + EMBED_MODEL,
          content: { parts: [{ text: t }] },
        })),
      }),
    });
    if (!response.ok) {
      const err = new Error("Embedding request failed");
      err.status = response.status;
      throw err;
    }
    const data = await response.json();
    const list = data.embeddings || [];
    if (list.length !== texts.length || !list.every((e) => e && Array.isArray(e.values))) {
      throw new Error("Unexpected embedding reply");
    }
    return list.map((e) => e.values);
  }
  async function embedTexts(texts, key) {
    let vectors = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = await embedBatch(texts.slice(i, i + EMBED_BATCH_SIZE), key);
      vectors = vectors.concat(batch);
    }
    return vectors;
  }
  function embedReason(err) {
    if (err && err.name === "TypeError") return "no internet";
    const s = err && err.status;
    if (s === 400 || s === 403) return "check your API key";
    if (s === 429) return "rate limit";
    if (s === 404) return "embedding model not found, check embeddingModel in config.js";
    if (s >= 500) return "Google server problem";
    if (s) return "error " + s;
    return "unexpected reply";
  }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }

  // ----- Saved vectors (so they are only made again when knowledge.md changes) -----
  function cacheLoad() {
    try {
      const saved = JSON.parse(localStorage.getItem(VECTOR_CACHE_NAME) || "null");
      if (saved && saved.fingerprint === fingerprint && Array.isArray(saved.vectors) &&
          saved.vectors.length === notes.length) {
        return saved.vectors;
      }
    } catch (e) {}
    return null;
  }
  function cacheSave(vectors) {
    try {
      const small = vectors.map((v) => v.map((x) => Math.round(x * 1e6) / 1e6));
      localStorage.setItem(VECTOR_CACHE_NAME, JSON.stringify({ fingerprint: fingerprint, vectors: small }));
    } catch (e) {}
  }

  function vectorsReady() {
    return notes.length > 0 && notes.every((n) => n.vector);
  }

  // ----- Status line under the header -----
  function methodLabel() {
    if (KB_METHOD === "keywords") return "keyword search";
    if (vectorsReady()) {
      return queryProblem
        ? "keyword search for now (meaning search problem: " + queryProblem + ")"
        : "meaning search";
    }
    if (meaningState === "preparing") return "preparing meaning search…";
    if (meaningState === "failed") {
      return "keyword search (meaning search failed: " + meaningWhy + "; reload to try again)";
    }
    return "keyword search for now (add your API key to turn on meaning search)";
  }
  function renderStatus() {
    const el = $("kbStatus");
    if (!USE_KB) { el.hidden = true; return; }
    let text = "";
    let warn = false;
    if (kbState === "loading") {
      text = "⏳ Loading your notes…";
    } else if (kbState === "missing") {
      text = "⚠️ Couldn't find " + KB_FILE + ". Check that it is in the same folder as index.html, then reload.";
      warn = true;
    } else if (kbState === "empty") {
      text = "⚠️ " + KB_FILE + " has no notes. Start each note with a line like: ## Note title";
      warn = true;
    } else if (kbState === "ready") {
      text = "📖 " + notes.length + (notes.length === 1 ? " note" : " notes") + " loaded • " + methodLabel();
    }
    el.textContent = text;
    el.classList.toggle("warn", warn);
    el.hidden = !text;
  }

  // ----- Load the notes file, then (if possible) make the embeddings -----
  async function prepareMeaning() {
    if (KB_METHOD !== "meaning") { meaningState = "none"; renderStatus(); return; }
    if (vectorsReady()) { meaningState = "ready"; renderStatus(); return; }
    const key = storeGet(KEY_NAME);
    if (!key) { meaningState = "needkey"; renderStatus(); return; }

    meaningState = "preparing";
    renderStatus();
    const cached = cacheLoad();
    if (cached) {
      notes.forEach((n, i) => { n.vector = cached[i]; });
      meaningState = "ready";
      renderStatus();
      return;
    }
    try {
      const vectors = await embedTexts(notes.map(docText), key);
      notes.forEach((n, i) => { n.vector = vectors[i]; });
      cacheSave(vectors);
      meaningState = "ready";
    } catch (err) {
      meaningState = "failed";
      meaningWhy = embedReason(err);
    }
    renderStatus();
  }

  async function loadKnowledge() {
    if (!USE_KB) return;
    try {
      if (kbState !== "ready") {
        kbState = "loading";
        renderStatus();
        let raw = "";
        try {
          const response = await fetch(KB_FILE, { cache: "no-cache" });
          if (!response.ok) throw new Error("not found");
          raw = await response.text();
        } catch (e) {
          kbState = "missing";
          renderStatus();
          return;
        }
        notes = parseNotes(raw);
        if (notes.length === 0) {
          kbState = "empty";
          renderStatus();
          return;
        }
        fingerprint = hashText(raw + "|" + EMBED_MODEL + "|" + MAX_NOTE_CHARS);
        kbState = "ready";
        queryProblem = "";
      }
      renderStatus();
      await prepareMeaning();
    } catch (e) {
      renderStatus(); // never let a notes problem break the chat
    }
  }
  function startKnowledge() {
    kbPromise = kbPromise.then(loadKnowledge);
    return kbPromise;
  }

  // ----- Keyword search -----
  const STOP_WORDS = new Set(("a an the and or but if of to in on at for with about as is are was were be been am " +
    "do does did how what when where which who whom why can could should would will shall may might must i me my " +
    "we our you your it its this that these those there their them they he she his her him from by not no yes so " +
    "than then too very just into over under again more most some any each other such only own same up down out off").split(" "));

  function stem(word) {
    return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
  }
  function wordsOf(text) {
    return (text.toLowerCase().match(/[a-z0-9']+/g) || [])
      .map((w) => w.replace(/'s$/, "").replace(/'/g, ""))
      .filter((w) => (w.length > 1 || /[0-9]/.test(w)) && !STOP_WORDS.has(w))
      .map(stem);
  }
  function keywordRank(question) {
    const terms = Array.from(new Set(wordsOf(question)));
    if (terms.length === 0) return [];
    const ranked = notes.map((note) => {
      if (!note.titleWords) {
        note.titleWords = new Set(wordsOf(note.title));
        note.textWords = new Set(wordsOf(note.text));
      }
      let points = 0;
      terms.forEach((t) => {
        if (note.titleWords.has(t)) points += 2;
        else if (note.textWords.has(t)) points += 1;
      });
      return { note: note, score: points / (2 * terms.length) };
    });
    return ranked.filter((r) => r.score > 0).sort((a, b) => b.score - a.score);
  }

  // ----- Pick the best notes for a question -----
  async function findNotes(question, key) {
    if (!USE_KB || notes.length === 0) return null;
    let ranked = null;
    let method = "keywords";
    if (KB_METHOD === "meaning" && vectorsReady()) {
      try {
        const vectors = await embedTexts(["task: search result | query: " + question], key);
        ranked = notes
          .map((note) => ({ note: note, score: cosine(vectors[0], note.vector) }))
          .sort((a, b) => b.score - a.score);
        method = "meaning";
        if (queryProblem) { queryProblem = ""; renderStatus(); }
      } catch (err) {
        queryProblem = embedReason(err); // fall back to keywords for this question
        renderStatus();
      }
    }
    if (!ranked) ranked = keywordRank(question);
    return { method: method, items: ranked.slice(0, KB_TOPK) };
  }

  // The message Gemini receives: the notes, numbered, then the question
  function buildNotesMessage(question, items) {
    let out = "NOTES:\n";
    if (items.length === 0) out += "(No matching notes were found.)\n";
    items.forEach((item, i) => {
      out += "\n[" + (i + 1) + "] " + displayTitle(item.note) + "\n" + item.note.text + "\n";
    });
    return out + "\nQUESTION: " + question;
  }

  // ----- "Sources" section under each reply -----
  function snippetOf(text) {
    const flat = text.replace(/\s+/g, " ").trim();
    if (flat.length <= 160) return flat;
    return flat.slice(0, 160).replace(/\s+\S*$/, "") + "…";
  }
  function addSources(found) {
    const details = document.createElement("details");
    details.className = "sources";
    const summary = document.createElement("summary");
    summary.textContent = found.items.length
      ? "Sources (" + found.items.length + ")"
      : "Sources (no matching notes)";
    details.appendChild(summary);
    found.items.forEach((item, i) => {
      const box = document.createElement("div");
      box.className = "source-item";
      const title = document.createElement("span");
      title.className = "source-title";
      title.textContent = "[" + (i + 1) + "] " + displayTitle(item.note);
      const score = document.createElement("span");
      score.className = "source-score";
      score.textContent = "score " + item.score.toFixed(2) +
        (found.method === "meaning" ? " (meaning)" : " (keywords)");
      const snippet = document.createElement("p");
      snippet.className = "source-snippet";
      snippet.textContent = snippetOf(item.note.text);
      box.appendChild(title);
      box.appendChild(score);
      box.appendChild(snippet);
      details.appendChild(box);
    });
    $("messages").appendChild(details);
    scrollDown();
  }

  // ---------- Starter buttons and new chat ----------
  function showStarters() {
    const box = $("starters");
    box.innerHTML = "";
    C.starterQuestions.forEach((q) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = q;
      b.addEventListener("click", () => sendMessage(q));
      box.appendChild(b);
    });
  }
  function newChat() {
    history = [];
    $("messages").innerHTML = "";
    addBubble("bot", C.welcomeMessage);
    showStarters();
    $("input").focus();
  }

  // ---------- Build the system instructions ----------
  function buildSystemText(useNotes) {
    let text = C.systemInstructions;
    if (useNotes && KB_RULES) text += "\n\n" + KB_RULES;
    const styleIndex = parseInt($("styleSelect").value, 10) || 0;
    text += "\n\nStyle note: " + C.learningStyles[styleIndex].instruction;
    const material = storeGet(MATERIAL_NAME);
    if (material) {
      text += "\n\nSTUDY MATERIAL (provided by the student or teacher):\n" + material;
    } else {
      text += "\n\nNo study material has been provided yet. If the student wants a study guide or trivia from their class, suggest they paste material with the Material button.";
    }
    return text;
  }

  // ---------- Friendly errors ----------
  function errorMessage(status) {
    if (status === 400 || status === 403) return "Hmm, your API key doesn't seem to work. Tap 🔑 API key and check that you pasted it correctly.";
    if (status === 429) return "Too many requests right now. Please wait a minute and try again.";
    if (status === 404) return "I can't find that AI model. Ask the site owner to check the model name in config.js.";
    if (status >= 500) return "Google's server is having a problem. Please try again in a moment.";
    return "Something went wrong (error " + status + "). Please try again.";
  }

  // ---------- Talk to Gemini ----------
  async function sendMessage(text) {
    text = (text || "").trim();
    if (!text || busy) return;

    const key = storeGet(KEY_NAME);
    if (!key) {
      addBubble("error", "Please add your API key first. Tap 🔑 API key at the top.");
      openKeyDialog();
      return;
    }

    busy = true;
    $("sendBtn").disabled = true;
    $("starters").innerHTML = "";
    addBubble("user", text);
    $("input").value = "";
    autoGrow();
    history.push({ role: "user", parts: [{ text: text }] });
    const thinking = addThinking();

    try {
      if (navigator.onLine === false) throw new TypeError("offline");

      // Wait for the notes to finish loading, then find the best ones
      await kbPromise;
      const found = await findNotes(text, key);

      // The saved history keeps the plain question. Only this request gets the notes.
      let contents = history;
      if (found) {
        contents = history.slice(0, -1).concat([
          { role: "user", parts: [{ text: buildNotesMessage(text, found.items) }] },
        ]);
      }

      const url = API_BASE + encodeURIComponent(C.model) + ":generateContent";

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemText(!!found) }] },
          contents: contents,
        }),
      });

      thinking.remove();

      if (!response.ok) {
        history.pop();
        addBubble("error", errorMessage(response.status));
        return;
      }

      const data = await response.json();
      const parts = (data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts) || [];
      const reply = parts
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text)
        .join("");

      if (!reply.trim()) {
        history.pop();
        addBubble("error", "I couldn't come up with an answer to that. Could you try asking in a different way?");
        return;
      }

      history.push({ role: "model", parts: [{ text: reply }] });
      addBubble("bot", reply);
      addCopyButton(reply);
      if (found) addSources(found);
    } catch (err) {
      thinking.remove();
      history.pop();
      addBubble("error", "I can't reach the internet right now. Check your connection and try again.");
    } finally {
      busy = false;
      $("sendBtn").disabled = false;
      $("input").focus();
    }
  }

  // ---------- Input box ----------
  function autoGrow() {
    const el = $("input");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }
  $("input").addEventListener("input", autoGrow);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage($("input").value);
    }
  });
  $("sendBtn").addEventListener("click", () => sendMessage($("input").value));
  $("newChatBtn").addEventListener("click", newChat);

  // ---------- API key pop-up ----------
  function openKeyDialog() {
    $("keyInput").value = storeGet(KEY_NAME);
    $("rememberKey").checked = isRemembered(KEY_NAME);
    $("keyDialog").showModal();
  }
  $("keyBtn").addEventListener("click", openKeyDialog);
  $("keyCancel").addEventListener("click", () => $("keyDialog").close());
  $("keySave").addEventListener("click", () => {
    const value = $("keyInput").value.trim();
    if (value) {
      storeSet(KEY_NAME, value, $("rememberKey").checked);
      startKnowledge(); // a key is saved, so (re)try preparing meaning search
    }
    $("keyDialog").close();
  });
  $("keyRemove").addEventListener("click", () => {
    storeRemove(KEY_NAME);
    $("keyInput").value = "";
    $("keyDialog").close();
  });

  // ---------- Study material pop-up ----------
  $("materialBtn").addEventListener("click", () => {
    $("materialInput").value = storeGet(MATERIAL_NAME);
    $("rememberMaterial").checked = isRemembered(MATERIAL_NAME);
    $("materialDialog").showModal();
  });
  $("materialCancel").addEventListener("click", () => $("materialDialog").close());
  $("materialSave").addEventListener("click", () => {
    const value = $("materialInput").value.trim().slice(0, MAX_MATERIAL);
    if (value) storeSet(MATERIAL_NAME, value, $("rememberMaterial").checked);
    else storeRemove(MATERIAL_NAME);
    $("materialDialog").close();
    addBubble("bot", value
      ? "Got your material! Try asking for a study guide or a trivia game. 📚"
      : "Material cleared.");
  });
  $("materialClear").addEventListener("click", () => {
    storeRemove(MATERIAL_NAME);
    $("materialInput").value = "";
  });

  // ---------- Start ----------
  newChat();
  renderStatus();
  startKnowledge();
})();
