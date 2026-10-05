// Study Buddy main code. You don't need to edit this file.
(function () {
  const C = BOT_CONFIG;
  const $ = (id) => document.getElementById(id);

  const KEY_NAME = "studyBuddyApiKey";
  const MATERIAL_NAME = "studyBuddyMaterial";
  const STYLE_NAME = "studyBuddyStyle";
  const MAX_MATERIAL = 30000; // characters

  let history = []; // the conversation so far
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
  function buildSystemText() {
    let text = C.systemInstructions;
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

      const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(C.model) + ":generateContent";

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemText() }] },
          contents: history,
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
    if (value) storeSet(KEY_NAME, value, $("rememberKey").checked);
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
})();
