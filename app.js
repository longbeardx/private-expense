"use strict";
/* Private Expense — shared expenses between two people, split 50/50.
 *
 * Data: one JSON file (data.json) in a private GitHub repo, read and written
 * through GitHub's contents API with a fine-grained access key limited to
 * that repo. Each phone keeps a local copy, so it works offline; changes are
 * merged by id (deletions are remembered as "tombstones"), and GitHub's file
 * version (sha) makes sure two phones saving at once never overwrite each other.
 */

// ------------------------------------------------------------- pure logic --
const PE = (() => {
  const emptyDoc = () => ({
    version: 1,
    settings: { people: ["", ""], currency: "$", updatedAt: 0 },
    expenses: [],      // {id, amount, payer: 0|1, note, ts}
    settlements: [],   // {id, from: 0|1, to: 0|1, amount, ts, covers: [expense ids]}
    deleted: [],       // ids of deleted expenses/settlements
  });

  const cents = (n) => Math.round(n * 100) / 100;

  // Union of both copies by id, minus anything either side deleted.
  function merge(a, b) {
    a = a || emptyDoc(); b = b || emptyDoc();
    const del = new Set([...(a.deleted || []), ...(b.deleted || [])]);
    const union = (xs, ys) => {
      const m = new Map();
      [...(xs || []), ...(ys || [])].forEach((x) => m.set(x.id, x));
      return [...m.values()].filter((x) => !del.has(x.id))
        .sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1));
    };
    const sa = a.settings || emptyDoc().settings, sb = b.settings || emptyDoc().settings;
    return {
      version: 1,
      settings: (sa.updatedAt || 0) >= (sb.updatedAt || 0) ? sa : sb,
      expenses: union(a.expenses, b.expenses),
      settlements: union(a.settlements, b.settlements),
      deleted: [...del].sort(),
    };
  }

  // > 0: person 1 owes person 0.  < 0: person 0 owes person 1.
  // Integer math on TWICE the balance in cents, so 50/50 halves stay exact.
  // Odd amounts leave half a cent: it rounds up when shown, and a leftover
  // half cent after settling up counts as settled.
  function balance(doc) {
    let twice = 0;
    for (const e of doc.expenses) twice += (e.payer === 0 ? 1 : -1) * Math.round(e.amount * 100);
    for (const s of doc.settlements) twice += (s.from === 1 ? -1 : 1) * 2 * Math.round(s.amount * 100);
    if (Math.abs(twice) <= 1) return 0;
    return Math.sign(twice) * Math.round(Math.abs(twice) / 2) / 100;
  }

  const covered = (doc) => new Set(doc.settlements.flatMap((s) => s.covers || []));
  const openExpenses = (doc) => { const c = covered(doc); return doc.expenses.filter((e) => !c.has(e.id)); };

  // ----- GitHub contents API (data.json in the private repo) ---------------
  const b64encode = (str) => { const bytes = new TextEncoder().encode(str); let bin = "";
    bytes.forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
  const b64decode = (b64) => { const bin = atob(b64.replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };

  function api(fetchFn, conn, method, body) {
    return fetchFn(`https://api.github.com/repos/${conn.repo}/contents/data.json`, {
      method, cache: "no-store",
      headers: { Authorization: `Bearer ${conn.token}`, Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Pull, merge with the local copy, push if anything changed. If the other
  // phone saved in between, GitHub rejects our stale version (409/422) and we
  // pull and merge again. Resolves to { doc, status: "ok" | "auth" | "offline" }.
  async function syncDoc(fetchFn, conn, local, onMerged) {
    let doc = local;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await api(fetchFn, conn, "GET");
        let remote = null, sha;
        if (r.status === 401 || r.status === 403) return { doc, status: "auth" };
        if (r.status !== 404) {
          if (!r.ok) return { doc, status: "offline" };
          const j = await r.json(); sha = j.sha; remote = JSON.parse(b64decode(j.content));
        }
        doc = merge(doc, remote);
        if (onMerged) onMerged(doc);
        if (remote && JSON.stringify(merge(remote, null)) === JSON.stringify(doc)) return { doc, status: "ok" };
        const put = await api(fetchFn, conn, "PUT", { message: "Update shared expenses",
          content: b64encode(JSON.stringify(doc, null, 1)), ...(sha ? { sha } : {}) });
        if (put.ok) return { doc, status: "ok" };
        if (put.status === 409 || put.status === 422) continue;   // the other phone saved first
        // GitHub hides private repos from keys without access: 404 = no access
        if (put.status === 401 || put.status === 403 || put.status === 404) return { doc, status: "auth" };
        return { doc, status: "offline" };
      }
      return { doc, status: "offline" };
    } catch {
      return { doc, status: "offline" };       // network down
    }
  }

  return { emptyDoc, merge, balance, openExpenses, covered, cents, syncDoc, b64encode, b64decode };
})();
if (typeof module !== "undefined") module.exports = PE;

// --------------------------------------------------------------------- app --
if (typeof document !== "undefined") (() => {
  const $ = (id) => document.getElementById(id);
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("privexp." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("privexp." + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem("privexp." + k); } catch {} },
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const toast = (msg) => { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 2200); };

  // ----- connection (repo + key), possibly delivered by a setup link -------
  // Setup link: …/#connect=<base64url of {"r":"owner/repo","t":"key"}>.
  // The part after # is never sent to any server; we store it and wipe it.
  (function readSetupLink() {
    const m = location.hash.match(/connect=([A-Za-z0-9_-]+)/);
    if (!m) return;
    try {
      const json = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
      const c = JSON.parse(json);
      if (c.r && c.t) LS.set("conn", { repo: c.r, token: c.t });
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  })();

  let conn = LS.get("conn", null);
  let doc = PE.merge(LS.get("doc", null), null);
  let me = LS.get("me", null);           // which person uses this phone (0|1)
  let payer = me ?? 0;

  const saveLocal = () => LS.set("doc", doc);
  const names = () => doc.settings.people;
  const ready = () => names()[0] && names()[1];
  const fmt = (n) => { const c = Math.round(Math.abs(n) * 100) % 100 !== 0 ? 2 : 0;
    return doc.settings.currency + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: c, maximumFractionDigits: c }); };
  const day = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

  // ----- sync (logic lives in PE.syncDoc so it can be tested on its own) ----
  let syncing = null, again = false;
  function setStatus(kind, text) { $("dot").className = "dot " + kind; $("syncText").textContent = text; }

  function sync() {
    if (!conn) return Promise.resolve();
    if (syncing) { again = true; return syncing; }
    setStatus("busy", "Syncing…");
    syncing = PE.syncDoc(fetch.bind(window), conn, doc, (merged) => { doc = merged; saveLocal(); render(); })
      .then(({ doc: d, status }) => {
        doc = d; saveLocal(); render();
        if (status === "ok") {
          LS.set("dirty", false);
          setStatus("ok", "Synced " + new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
        } else if (status === "auth") setStatus("err", "Key expired or wrong");
        else setStatus("err", LS.get("dirty", false) ? "Offline · will sync" : "Offline");
      })
      .finally(() => { syncing = null; if (again) { again = false; sync(); } });
    return syncing;
  }

  function change(mutator) { mutator(doc); doc = PE.merge(doc, null); LS.set("dirty", true); saveLocal(); render(); sync(); }

  // ----- views ---------------------------------------------------------------
  function show(view) {
    ["connectView", "namesView", "meView", "mainView"].forEach((v) => { $(v).hidden = v !== view; });
  }

  function segment(box, onPick, selected) {
    box.innerHTML = "";
    names().forEach((n, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = n || "…"; b.setAttribute("aria-pressed", i === selected);
      b.onclick = () => onPick(i);
      box.appendChild(b);
    });
  }

  function render() {
    if (!conn) { show("connectView"); setStatus("", "Not connected"); return; }
    if (!ready()) {
      show("namesView");
      return;
    }
    if (me === null) { show("meView"); segment($("meSeg"), (i) => { me = i; payer = i; LS.set("me", i); render(); }, -1); return; }
    show("mainView");

    const [p0, p1] = names();
    const bal = PE.balance(doc);
    if (bal === 0) {
      $("balance").textContent = "All settled ✓";
      $("balanceSub").textContent = "Nobody owes anything.";
      $("settleBtn").hidden = true;
    } else {
      const debtor = bal > 0 ? p1 : p0, creditor = bal > 0 ? p0 : p1;
      $("balance").innerHTML = "";
      $("balance").append(`${debtor} owes ${creditor} `);
      const s = document.createElement("span"); s.className = "amt"; s.textContent = fmt(bal); $("balance").append(s);
      const open = PE.openExpenses(doc);
      $("balanceSub").textContent = `${open.length} expense${open.length === 1 ? "" : "s"} since the last settle-up`;
      $("settleBtn").hidden = false;
    }

    $("curSign").textContent = doc.settings.currency.trim();
    segment($("payerSeg"), (i) => { payer = i; render(); }, payer);
    segment($("meSeg2"), (i) => { me = i; payer = i; LS.set("me", i); render(); toast(`This phone is now ${names()[i]}'s`); }, me);

    // open expenses
    const open = PE.openExpenses(doc).slice().reverse();
    const ul = $("openList"); ul.innerHTML = "";
    if (!open.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Nothing to settle yet"; ul.appendChild(li); }
    open.forEach((e) => {
      const li = document.createElement("li");
      li.innerHTML = '<div class="what"><b></b><small></small></div><span class="amt"></span><button class="x" type="button">✕</button>';
      li.querySelector("b").textContent = e.note || "Expense";
      li.querySelector("small").textContent = `${names()[e.payer]} paid · ${day(e.ts)} · each ${fmt(e.amount / 2)}`;
      li.querySelector(".amt").textContent = fmt(e.amount);
      const x = li.querySelector("button");
      x.setAttribute("aria-label", "Delete expense");
      x.onclick = () => {
        if (!confirm(`Delete “${e.note || "Expense"}” (${fmt(e.amount)})?`)) return;
        change((d) => { d.deleted.push(e.id); });
        toast("Deleted");
      };
      ul.appendChild(li);
    });

    // history: settle-ups, newest first; the latest can be undone
    const h = $("history"); h.innerHTML = "";
    const sets = doc.settlements.slice().reverse();
    if (!sets.length) { const p = document.createElement("span"); p.className = "empty"; p.textContent = "No settle-ups yet"; h.appendChild(p); }
    sets.forEach((s, idx) => {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = `${day(s.ts)} · ${names()[s.from]} paid ${names()[s.to]} ${fmt(s.amount)}`;
      det.appendChild(sum);
      const list = document.createElement("ul");
      const exp = doc.expenses.filter((e) => (s.covers || []).includes(e.id));
      exp.forEach((e) => {
        const li = document.createElement("li");
        li.innerHTML = '<div class="what"><b></b><small></small></div><span class="amt"></span>';
        li.querySelector("b").textContent = e.note || "Expense";
        li.querySelector("small").textContent = `${names()[e.payer]} paid · ${day(e.ts)}`;
        li.querySelector(".amt").textContent = fmt(e.amount);
        list.appendChild(li);
      });
      if (!exp.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "No expenses"; list.appendChild(li); }
      det.appendChild(list);
      if (idx === 0) {
        const undo = document.createElement("button");
        undo.type = "button"; undo.className = "btn secondary"; undo.textContent = "Undo this settle-up";
        undo.onclick = () => {
          if (!confirm("Undo this settle-up? Its expenses go back to unsettled.")) return;
          change((d) => { d.deleted.push(s.id); }); toast("Settle-up undone");
        };
        det.appendChild(undo);
      }
      h.appendChild(det);
    });

    // settings fields
    if (document.activeElement !== $("edit0")) $("edit0").value = names()[0];
    if (document.activeElement !== $("edit1")) $("edit1").value = names()[1];
    $("editCur").value = doc.settings.currency;
  }

  // ----- actions ------------------------------------------------------------
  $("connectBtn").onclick = async () => {
    const repo = $("repo").value.trim(), token = $("token").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || token.length < 20) { $("connectErr").hidden = false; $("connectErr").textContent = "Check the repository (owner/repo) and the key."; return; }
    conn = { repo, token }; LS.set("conn", conn); $("token").value = "";
    await sync(); render();
  };

  const namesFilled = () => { $("namesBtn").disabled = !($("name0").value.trim() && $("name1").value.trim()); };
  $("name0").oninput = namesFilled; $("name1").oninput = namesFilled;
  $("namesBtn").onclick = () => {
    const a = $("name0").value.trim(), b = $("name1").value.trim();
    if (!a || !b) return;
    if (a.toLowerCase() === b.toLowerCase()) { toast("Use two different names"); return; }
    change((d) => { d.settings = { people: [a, b], currency: $("currencyPick").value, updatedAt: Date.now() }; });
  };

  const parseAmount = () => { const v = parseFloat(($("amount").value || "").replace(",", "."));
    return Number.isFinite(v) && v > 0 ? PE.cents(v) : null; };
  $("amount").addEventListener("input", () => { $("add").disabled = parseAmount() === null; });
  $("form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const amount = parseAmount(); if (amount === null) return;
    const note = $("note").value.trim();
    change((d) => { d.expenses.push({ id: uid(), amount, payer, note, ts: Date.now() }); });
    toast(`Added ${fmt(amount)} · ${names()[payer]} paid`);
    $("amount").value = ""; $("note").value = ""; $("add").disabled = true;
    payer = me ?? 0; render();
  });

  $("settleBtn").onclick = () => {
    const bal = PE.balance(doc); if (bal === 0) return;
    const from = bal > 0 ? 1 : 0, to = 1 - from;
    if (!confirm(`Record that ${names()[from]} paid ${names()[to]} ${fmt(bal)}? The balance goes back to zero.`)) return;
    const covers = PE.openExpenses(doc).map((e) => e.id);
    change((d) => { d.settlements.push({ id: uid(), from, to, amount: Math.abs(bal), ts: Date.now(), covers }); });
    toast("Settled up ✓");
  };

  $("saveSettings").onclick = () => {
    const a = $("edit0").value.trim(), b = $("edit1").value.trim();
    if (!a || !b || a.toLowerCase() === b.toLowerCase()) { toast("Use two different, non-empty names"); return; }
    change((d) => { d.settings = { people: [a, b], currency: $("editCur").value, updatedAt: Date.now() }; });
    toast("Saved");
  };

  $("copyLink").onclick = async () => {
    if (!conn) return;
    const code = btoa(JSON.stringify({ r: conn.repo, t: conn.token })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const link = location.origin + location.pathname + "#connect=" + code;
    try { await navigator.clipboard.writeText(link); toast("Setup link copied — send it privately"); }
    catch { prompt("Copy this setup link (keep it private):", link); }
  };

  $("export").onclick = () => {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const iso = (ts) => { const t = new Date(ts); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`; };
    const rows = ["date,type,paid_by,amount,note"]
      .concat(doc.expenses.map((e) => [iso(e.ts), "expense", esc(names()[e.payer]), e.amount, esc(e.note)].join(",")))
      .concat(doc.settlements.map((s) => [iso(s.ts), "settle-up", esc(names()[s.from]), s.amount, esc(`paid ${names()[s.to]}`)].join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    a.download = `private-expense-${iso(Date.now())}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };

  $("disconnect").onclick = () => {
    if (!confirm("Disconnect this phone? The shared data stays safe on GitHub; you'll need the setup link to reconnect.")) return;
    ["conn", "doc", "me", "dirty"].forEach(LS.del); conn = null; doc = PE.emptyDoc(); me = null; render();
  };

  $("syncBtn").onclick = () => sync();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
  window.addEventListener("online", () => sync());

  render();
  sync();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
