/* Job Hunt dashboard. Decrypts data.json with your passphrase (Web Crypto); no libraries, no trackers.
   Your Shortlist / Applied / notes are saved in this browser (localStorage). */
(function () {
  "use strict";

  var POLL_MS = 5 * 60 * 1000;
  var STALE_HOURS = 36;
  var FOLLOW_UP_DAYS = 7;
  var STAGES = [["applied", "Applied"], ["interview", "Interviewing"], ["offer", "Offer"], ["rejected", "Rejected"], ["withdrawn", "Withdrawn"]];
  var APP_STAGES = { applied: 1, interview: 1, offer: 1, rejected: 1, withdrawn: 1 };

  var P = null;            // decrypted payload
  var S = loadSite();      // per-device state
  var version = null;
  var ui = { tab: recall("tab", "review"), view: recall("view", "todo"), q: "", open: {}, fOpen: true, fNear: false, fOld: false, fSkipped: false };

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "class") e.className = v;
      else if (k === "on") for (var ev in v) e.addEventListener(ev, v[ev]);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) e.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
      else e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  function store(k, v) { try { localStorage.setItem("jobhunt." + k, JSON.stringify(v)); } catch (e) {} }
  function recall(k, d) { try { var v = localStorage.getItem("jobhunt." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }
  function todayStr() { var t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); }
  function daysSince(d) {
    if (!d) return null;
    var a = new Date(String(d).slice(0, 10) + "T00:00:00"), b = new Date(todayStr() + "T00:00:00");
    var n = Math.round((b - a) / 864e5); return isNaN(n) ? null : n;
  }
  function ago(d) {
    var n = daysSince(d);
    if (n === null) return "";
    return n <= 0 ? "today" : n === 1 ? "yesterday" : n < 30 ? n + "d ago" : Math.round(n / 30) + "mo ago";
  }
  function fmtTime(iso) {
    var t = new Date(iso); if (isNaN(t)) return "";
    return t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : null; }
  function scoreClass(s) { return s >= 75 ? "s-hi" : s >= 60 ? "s-mid" : "s-lo"; }

  // ---------- per-device state ----------
  function loadSite() { var s = recall("site", {}); s.st = s.st || {}; return s; }
  function saveSite() { store("site", S); }
  function stOf(j) { return (S.st[j.id] || {}).s || ""; }
  function setStatus(j, s) {
    var e = S.st[j.id] || { at: {} };
    e.at = e.at || {};
    if (s && e.s !== s) e.at[s] = todayStr();
    if (s) e.s = s; else delete e.s;
    e.t = j.title; e.c = j.company;
    if (e.s || e.note) S.st[j.id] = e; else delete S.st[j.id];
    saveSite(); renderAll();
  }
  function setNote(j, note) {
    var e = S.st[j.id] || { at: {} };
    if (note) e.note = note; else delete e.note;
    if (e.s || e.note) S.st[j.id] = e; else delete S.st[j.id];
    saveSite();
  }
  function recordVisit() {
    var now = Date.now(), last = S.lastVisit || 0;
    if (!S.prevVisitDay || now - last > 30 * 60 * 1000) S.prevVisitDay = last ? new Date(last).toISOString().slice(0, 10) : null;
    S.lastVisit = now; saveSite();
  }
  function isNew(j) {
    if (j.legacy || !j.found) return false;
    return S.prevVisitDay ? j.found > S.prevVisitDay : daysSince(j.found) <= 1;
  }
  // Carry over Interested/Applied/Reject from the previous version of this site (keyed by URL).
  function migrateOldStatuses() {
    if (S.migrated || !P) return;
    var old = null;
    try { old = JSON.parse(localStorage.getItem("jobdash.site") || "null"); } catch (e) {}
    var map = { interested: "shortlist", applied: "applied", rejected: "skip" };
    if (old && old.statuses) {
      var byUrl = {}; P.jobs.forEach(function (j) { byUrl[j.url] = j; });
      Object.keys(old.statuses).forEach(function (url) {
        var o = old.statuses[url], j = byUrl[url];
        if (!j || S.st[j.id]) return;
        var e = { at: {}, t: j.title, c: j.company };
        if (map[o.status]) { e.s = map[o.status]; e.at[e.s] = (o[o.status + "_at"] || "").slice(0, 10) || todayStr(); }
        if (o.note) e.note = o.note;
        if (e.s || e.note) S.st[j.id] = e;
      });
    }
    S.migrated = true; saveSite();
  }

  // ---------- crypto ----------
  function lockError(msg) { var e = new Error(msg); e.locked = true; return e; }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function toHex(a) { return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function fromHex(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function deriveKeys(pass, salt, iter) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error("This browser can't decrypt (needs an https:// page)."));
    return crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]).then(function (k) {
      return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: iter }, k, 512);
    }).then(function (b) { return new Uint8Array(b); });
  }
  function decrypt(blob, raw) {
    var iv = unb64(blob.iv), ct = unb64(blob.ct), mac = unb64(blob.mac);
    var signed = new Uint8Array(iv.length + ct.length); signed.set(iv); signed.set(ct, iv.length);
    return crypto.subtle.importKey("raw", raw.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]).then(function (k) {
      return crypto.subtle.verify("HMAC", k, mac, signed);
    }).then(function (ok) {
      if (!ok) throw lockError("Wrong passphrase.");
      return crypto.subtle.importKey("raw", raw.slice(0, 32), "AES-CTR", false, ["decrypt"]);
    }).then(function (k) {
      return crypto.subtle.decrypt({ name: "AES-CTR", counter: iv, length: 64 }, k, ct);
    }).then(function (buf) {
      return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"))).text();
    }).then(JSON.parse);
  }
  function savedKey() {
    var k = null;
    try { k = JSON.parse(sessionStorage.getItem("jobhunt.key") || "null"); } catch (e) {}
    return k || recall("key", null);
  }
  function forgetKey() { try { sessionStorage.removeItem("jobhunt.key"); localStorage.removeItem("jobhunt.key"); } catch (e) {} }
  function fetchJson(name) {
    return fetch(name + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("Couldn't load " + name + " (" + r.status + ").");
      return r.json();
    });
  }
  function unlock(pass, remember) {
    return fetchJson("data.json").then(function (blob) {
      return deriveKeys(pass, blob.salt, blob.iter).then(function (raw) {
        return decrypt(blob, raw).then(function () {
          var k = { salt: blob.salt, hex: toHex(raw) };
          forgetKey();
          if (remember) store("key", k); else try { sessionStorage.setItem("jobhunt.key", JSON.stringify(k)); } catch (e) {}
        });
      });
    });
  }
  function load() {
    var key = savedKey();
    if (!key) return Promise.reject(lockError(""));
    return fetchJson("data.json").then(function (blob) {
      if (blob.salt !== key.salt) { forgetKey(); throw lockError("The passphrase changed. Enter the new one."); }
      return decrypt(blob, fromHex(key.hex)).catch(function (e) { if (e.locked) forgetKey(); throw e; })
        .then(function (p) { version = blob.iv; return p; });
    });
  }

  // ---------- loading & polling ----------
  var loadError = null;
  function refresh(first) {
    return load().then(function (p) {
      P = p; loadError = null;
      if (first) recordVisit();
      migrateOldStatuses();
      document.body.classList.remove("locked"); $("lock").hidden = true;
      renderAll();
    }).catch(function (e) {
      if (e && e.locked) return showLock(e.message);
      loadError = e.message || "Couldn't load the latest data.";
      document.body.classList.remove("locked"); $("lock").hidden = true;
      renderAll();
    });
  }
  function poll() {
    if (document.hidden || !P) return;
    fetchJson("version.json").then(function (v) { if (v.version !== version) refresh(false); }).catch(function () {});
  }
  function showLock(msg) {
    document.body.classList.add("locked"); $("lock").hidden = false;
    $("lockErr").textContent = msg || ""; $("pass").value = "";
    setTimeout(function () { $("pass").focus(); }, 50);
  }

  // ---------- selections ----------
  function jobs() { return (P && P.jobs) || []; }
  function isMatch(j) { return !j.legacy && (j.score || 0) >= (P.min_score || 60); }
  function todo() {
    return jobs().filter(function (j) { return isMatch(j) && j.open !== false && !stOf(j); })
      .sort(function (a, b) { return (b.score - a.score) || ((b.found || "") > (a.found || "") ? 1 : -1); });
  }
  function shortlist() { return jobs().filter(function (j) { return stOf(j) === "shortlist"; }).sort(byScore); }
  function apps() { return jobs().filter(function (j) { return APP_STAGES[stOf(j)]; }); }
  function byScore(a, b) { return ((b.score || b.legacy_score || 0) - (a.score || a.legacy_score || 0)); }
  function allJobs() {
    var terms = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    return jobs().filter(function (j) {
      var s = stOf(j);
      if (j.legacy && !ui.fOld) return false;
      if (!j.legacy && !isMatch(j) && !ui.fNear) return false;
      if (ui.fOpen && j.open === false) return false;
      if (s === "skip" && !ui.fSkipped) return false;
      if (terms.length) {
        var hay = [j.title, j.company, j.location, j.summary, j.seat].join(" ").toLowerCase();
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return ((b.found || "") > (a.found || "") ? 1 : (b.found || "") < (a.found || "") ? -1 : byScore(a, b)); });
  }

  // ---------- rendering ----------
  function renderAll() {
    if (!P && !loadError) return;
    renderHeader(); renderReview(); renderApps(); renderInsights(); showTab(ui.tab);
  }

  function lastRun() { var r = (P && P.runs) || []; return r.length ? r[r.length - 1] : null; }

  function renderHeader() {
    var nNew = P ? todo().filter(isNew).length : 0;
    var parts = [];
    if (P) parts.push("Updated " + fmtTime(P.generated));
    if (nNew) parts.push(nNew + " new");
    $("status").textContent = parts.join(" · ");
    $("cReview").textContent = P ? (todo().length || "") : "";
    $("cApps").textContent = P ? (apps().length || "") : "";
    var msgs = [], err = false, run = lastRun();
    if (loadError) { msgs.push(loadError); err = true; }
    if (P) {
      var hrs = (Date.now() - new Date(P.generated).getTime()) / 36e5;
      if (hrs > STALE_HOURS) msgs.push("No update for " + Math.round(hrs) + " hours. The daily run may have failed; check the Actions tab of the job-hunter repository.");
      if (run && run.errors && run.errors.length) { msgs.push("Last run had problems: " + run.errors.join("; ")); }
    }
    var b = $("banner");
    b.hidden = !msgs.length; b.className = "banner" + (err ? " error" : ""); b.textContent = msgs.join("  •  ");
  }

  function renderReview() {
    if (!P) return;
    var views = { todo: todo(), shortlist: shortlist(), all: allJobs() };
    document.querySelectorAll(".seg button").forEach(function (b) {
      var v = b.getAttribute("data-view");
      b.classList.toggle("active", v === ui.view);
      var n = b.querySelector(".n"); if (!n) { n = el("span", { class: "n" }); b.appendChild(n); }
      n.textContent = v === "all" ? "" : views[v].length;
    });
    $("allTools").hidden = ui.view !== "all";
    var list = views[ui.view] || [];
    $("listHint").textContent = ui.view === "todo" && list.length
      ? "Best matches first. Tap a job for details. Anything you shortlist, apply to, or mark “Not for me” leaves this list."
      : ui.view === "all" ? list.length + " jobs" : "";
    var box = $("list"); box.textContent = "";
    if (!list.length) {
      box.appendChild(ui.view === "todo"
        ? el("div", { class: "empty" }, el("b", { text: "You're all caught up." }), "New matches appear here after each daily run (around 9am).")
        : ui.view === "shortlist"
          ? el("div", { class: "empty" }, el("b", { text: "No shortlisted jobs yet." }), "Tap a job, then Shortlist, to keep it here.")
          : el("div", { class: "empty", text: "No jobs match these filters." }));
      return;
    }
    var frag = document.createDocumentFragment();
    list.slice(0, 300).forEach(function (j) { frag.appendChild(card(j)); });
    box.appendChild(frag);
  }

  function card(j) {
    var s = stOf(j), score = j.legacy ? j.legacy_score : j.score, open = !!ui.open[j.id];
    var tags = el("span", { class: "tags" },
      isNew(j) && !s ? el("span", { class: "tag new", text: "new" }) : null,
      j.cv ? el("span", { class: "tag cv", text: "CV ready" }) : null,
      j.open === false ? el("span", { class: "tag closed", text: "closed" }) : null,
      s && s !== "skip" && ui.view !== "shortlist" ? el("span", { class: "tag st", text: s === "shortlist" ? "shortlisted" : s }) : null,
      j.legacy ? el("span", { class: "tag", text: "old" }) : null);
    var metaBits = [j.company, j.location, ago(j.posted || j.found)].filter(Boolean).join(" · ");
    var main = el("button", { class: "card-main", "aria-expanded": open ? "true" : "false", on: { click: function () { ui.open[j.id] = !ui.open[j.id]; renderReview(); } } },
      el("span", { class: "score " + (j.legacy ? "s-lo" : scoreClass(score || 0)), title: j.legacy ? "Old keyword score from Hermes" : "Match score" }, score == null ? "–" : String(score)),
      el("span", { class: "cm" },
        el("h3", null, j.title || "Untitled", tags),
        el("div", { class: "meta", text: metaBits }),
        j.summary ? el("p", { class: "sum", text: j.summary }) : null));
    var c = el("article", { class: "card" + (j.open === false ? " closed" : "") }, main);
    if (open) c.appendChild(detail(j));
    return c;
  }

  function list(cls, items) {
    return items && items.length ? el("ul", { class: cls }, items.map(function (t) { return el("li", { text: t }); })) : null;
  }

  function tailorUrl(j) {
    if (!P.repo) return null;
    var title = "Tailor CV: " + j.title + " @ " + j.company;
    var body = "Job ID: " + j.id + "\nPosting: " + j.url + "\n\nSubmit this issue to generate a tailored CV (takes about 3 minutes).\n" +
      "Optional: write anything the AI should emphasise below this line.\n---\n";
    return "https://github.com/" + P.repo + "/issues/new?title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body);
  }
  function repoFile(path, raw) { return "https://github.com/" + P.repo + (raw ? "/raw/main/" : "/blob/main/") + path.split("/").map(encodeURIComponent).join("/"); }

  function detail(j) {
    var s = stOf(j);
    var d = el("div", { class: "detail" });
    if (j.strengths && j.strengths.length) d.appendChild(el("div", null, el("h4", { text: "Why it fits" }), list("ok", j.strengths)));
    if (j.gaps && j.gaps.length) d.appendChild(el("div", null, el("h4", { text: "Gaps" }), list("gap", j.gaps)));
    if (j.dealbreakers && j.dealbreakers.length) d.appendChild(el("div", null, el("h4", { text: "Dealbreakers" }), list("bad", j.dealbreakers)));
    var facts = el("dl", { class: "facts" });
    function fact(k, v) { if (v) { facts.appendChild(el("dt", { text: k })); facts.appendChild(el("dd", { text: v })); } }
    fact("Role", [j.seat, j.seniority].filter(Boolean).join(" · "));
    fact("Salary", j.salary);
    fact("Source", ({ greenhouse: "Employer site", lever: "Employer site", ashby: "Employer site", mcf: "MyCareersFuture", linkedin: "LinkedIn", hermes: "Old Hermes search" })[j.source] || j.source);
    fact("Posted", j.posted ? j.posted + " (" + ago(j.posted) + ")" : "");
    fact("Found", j.found);
    if (j.open === false) fact("Status", "Closed" + (j.closed_on ? " (noticed " + j.closed_on + ")" : ""));
    d.appendChild(facts);

    var acts = el("div", { class: "actions" });
    var link = safeUrl(j.apply_url) || safeUrl(j.url);
    if (link) acts.appendChild(el("a", { class: "btn primary", href: link, target: "_blank", rel: "noopener noreferrer", text: "Open posting ↗" }));
    if (j.cv && j.cv.docx) acts.appendChild(el("a", { class: "btn", href: repoFile(j.cv.docx, true), target: "_blank", rel: "noopener", text: "Download CV (Word)" }));
    if (j.cv && j.cv.pdf) acts.appendChild(el("a", { class: "btn", href: repoFile(j.cv.pdf, false), target: "_blank", rel: "noopener", text: "View CV (PDF)" }));
    if (j.cv && j.cv.notes) acts.appendChild(el("a", { class: "btn quiet", href: repoFile(j.cv.notes, false), target: "_blank", rel: "noopener", text: "What changed" }));
    var tu = tailorUrl(j);
    if (tu && !j.legacy) acts.appendChild(el("a", { class: "btn", href: tu, target: "_blank", rel: "noopener", text: j.cv ? "Re-tailor CV" : "Tailor my CV" }));
    d.appendChild(acts);

    var acts2 = el("div", { class: "actions" });
    [["shortlist", "Shortlist"], ["applied", "Applied"], ["skip", "Not for me"]].forEach(function (x) {
      var on = s === x[0] || (x[0] === "applied" && APP_STAGES[s]);
      acts2.appendChild(el("button", { class: "btn" + (on ? " on-" + x[0] : ""), on: { click: function () { setStatus(j, on ? null : x[0]); } } }, x[1]));
    });
    d.appendChild(acts2);
    if (tu && !j.legacy && !j.cv) d.appendChild(el("p", { class: "hint", text: "“Tailor my CV” opens a pre-filled GitHub issue. Press Submit and a tailored CV appears on this job in about 3 minutes." }));
    return d;
  }

  function renderApps() {
    if (!P) return;
    var box = $("apps"); box.textContent = "";
    var items = apps();
    if (!items.length) {
      box.appendChild(el("div", { class: "empty" }, el("b", { text: "No applications tracked yet." }), "Open a job and tap Applied. It will show up here with reminders to follow up."));
      return;
    }
    STAGES.forEach(function (st) {
      var group = items.filter(function (j) { return stOf(j) === st[0]; });
      if (!group.length) return;
      group.sort(function (a, b) { return ((S.st[b.id].at || {}).applied || "") > ((S.st[a.id].at || {}).applied || "") ? 1 : -1; });
      var g = el("div", { class: "stage-group" }, el("h2", { text: st[1] + " (" + group.length + ")" }));
      group.forEach(function (j) { g.appendChild(appRow(j)); });
      box.appendChild(g);
    });
  }

  function appRow(j) {
    var e = S.st[j.id] || {}, at = e.at || {}, s = e.s;
    var appliedOn = at.applied, lastChange = at[s] || appliedOn;
    var sel = el("select", { "aria-label": "Stage", on: { change: function () { setStatus(j, sel.value); } } },
      STAGES.map(function (x) { var o = el("option", { value: x[0], text: x[1] }); if (x[0] === s) o.selected = true; return o; }));
    var since = daysSince(lastChange);
    var follow = (s === "applied" || s === "interview") && since !== null && since >= FOLLOW_UP_DAYS;
    var note = el("textarea", { rows: 2, placeholder: "Notes: contact, interview dates, salary discussed…" });
    note.value = e.note || "";
    var t; note.addEventListener("input", function () { clearTimeout(t); t = setTimeout(function () { setNote(j, note.value.trim()); }, 600); });
    note.addEventListener("blur", function () { setNote(j, note.value.trim()); });
    var link = safeUrl(j.apply_url) || safeUrl(j.url);
    return el("div", { class: "app" },
      el("div", { class: "app-top" },
        el("div", { class: "cm" }, el("h3", { text: j.title }),
          el("div", { class: "meta", text: [j.company, appliedOn ? "applied " + appliedOn + " (" + ago(appliedOn) + ")" : ""].filter(Boolean).join(" · ") }),
          follow ? el("div", { class: "followup", text: "No change for " + since + " days. Time to follow up?" }) : null,
          j.open === false && s === "applied" ? el("div", { class: "followup", text: "The posting has closed." }) : null),
        sel),
      el("div", { class: "actions" },
        link ? el("a", { class: "btn quiet", href: link, target: "_blank", rel: "noopener noreferrer", text: "Posting ↗" }) : null,
        j.cv && j.cv.pdf ? el("a", { class: "btn quiet", href: repoFile(j.cv.pdf, false), target: "_blank", rel: "noopener", text: "CV sent" }) : null),
      note);
  }

  function renderInsights() {
    if (!P) return;
    var box = $("insights"); box.textContent = "";
    var run = lastRun();
    if (run) {
      var col = run.collected || {}, fl = run.filtered || {};
      box.appendChild(el("div", { class: "box" }, el("h2", { text: "Last run · " + fmtTime(run.finished || run.started) }),
        el("div", { class: "kpis" },
          kpi((col.boards || 0) + (col.mcf || 0) + (col.linkedin || 0), "postings checked"),
          kpi((run.triage || {}).in, "new to judge"),
          kpi(run.scored, "read in full by AI"),
          kpi(run.matches, "new matches"),
          kpi(run.closed, "postings closed")),
        el("p", { class: "muted small", style: "margin-top:10px", text:
          "Sources: " + (col.boards || 0) + " from " + (run.boards_ok || 0) + "/" + (run.boards_total || 0) + " employer boards, " +
          (col.mcf || 0) + " MyCareersFuture, " + (col.linkedin || 0) + " LinkedIn. Filtered out by rules: " + (fl.title || 0) + " by title, " +
          (fl.location || 0) + " by location." + (run.deferred ? " " + run.deferred + " left for the next run (daily AI budget)." : "") }),
        run.errors && run.errors.length ? el("p", { class: "err", text: run.errors.join("; ") }) : null));
    }
    var weeks = {}, mine = jobs().filter(isMatch);
    mine.forEach(function (j) { var n = daysSince(j.found); if (n !== null && n < 56) { var w = Math.floor(n / 7); weeks[w] = (weeks[w] || 0) + 1; } });
    var applied = apps().length, interviews = jobs().filter(function (j) { return ["interview", "offer"].indexOf(stOf(j)) >= 0; }).length;
    box.appendChild(el("div", { class: "box" }, el("h2", { text: "Your pipeline" }),
      el("div", { class: "kpis" }, kpi(weeks[0] || 0, "matches this week"), kpi(weeks[1] || 0, "last week"),
        kpi(todo().length, "waiting for review"), kpi(applied, "applications"), kpi(interviews, "interviews / offers"))));

    var qs = (P.queries || []).filter(function (q) { return q.source !== "board"; })
      .sort(function (a, b) { return (b.matches - a.matches) || (b.avg_results - a.avg_results); });
    if (qs.length) {
      var t = el("table", null, el("thead", null, el("tr", null, el("th", { text: "Search" }), el("th", { text: "Where" }),
        el("th", { class: "num", text: "Avg results" }), el("th", { class: "num", text: "Matches" }), el("th", { text: "" }))));
      var tb = el("tbody");
      qs.forEach(function (q) {
        var tag = q.matches ? el("span", { class: "pill good", text: "useful" })
          : q.zero_streak >= 3 ? el("span", { class: "pill stale", text: "stale" })
          : q.runs >= 10 ? el("span", { class: "pill quiet", text: "no matches yet" }) : null;
        tb.appendChild(el("tr", null, el("td", { class: "wrap", text: q.query }), el("td", { text: q.source === "mcf" ? "MyCareersFuture" : "LinkedIn" }),
          el("td", { class: "num", text: q.avg_results }), el("td", { class: "num", text: q.matches }), el("td", null, tag)));
      });
      t.appendChild(tb);
      box.appendChild(el("div", { class: "box" }, el("h2", { text: "Search phrases" }),
        el("p", { text: "Stale = no results on the last 3 runs. Edit the list in config/search.json in the job-hunter repository." }),
        el("details", null, el("summary", { text: "Show " + qs.length + " searches" }), el("div", { class: "tbl-wrap" }, t))));
    }
    var boards = (P.boards || []).slice().sort(function (a, b) { return b.jobs - a.jobs; });
    if (boards.length) {
      var bm = {}; (P.queries || []).forEach(function (q) { if (q.source === "board") bm[q.query] = q; });
      var t2 = el("table", null, el("thead", null, el("tr", null, el("th", { text: "Employer" }), el("th", { class: "num", text: "Open jobs" }),
        el("th", { class: "num", text: "Matches so far" }), el("th", { text: "" }))));
      var tb2 = el("tbody");
      boards.forEach(function (b) {
        tb2.appendChild(el("tr", null, el("td", { text: b.company }), el("td", { class: "num", text: b.jobs }),
          el("td", { class: "num", text: (bm[b.company] || {}).matches || 0 }),
          el("td", null, b.status === 200 ? null : el("span", { class: "pill stale", text: "error " + b.status }))));
      });
      t2.appendChild(tb2);
      box.appendChild(el("div", { class: "box" }, el("h2", { text: "Employer job boards (" + boards.length + ")" }),
        el("details", null, el("summary", { text: "Show boards" }), el("div", { class: "tbl-wrap" }, t2))));
    }
    box.appendChild(el("div", { class: "box" }, el("h2", { text: "How this works" }),
      el("p", { text: "Every morning a job on GitHub checks " + boards.length + " employer job boards, MyCareersFuture and LinkedIn. Simple rules drop obvious mismatches (engineering, marketing, wrong country). An AI then reads each remaining job and scores it against your CAREER_FACTS file and preferences. " + (P.min_score || 60) + "+ shows up for review." }),
      el("p", { text: "The data is encrypted with your passphrase before it is published. Your shortlist, applications and notes stay in this browser on this device." })));
  }
  function kpi(v, label) { return el("div", { class: "kpi" }, el("b", { text: v == null ? "–" : String(v) }), el("span", { text: label })); }

  // ---------- tabs & events ----------
  function showTab(name) {
    if (!$("tab-" + name)) name = "review";
    ui.tab = name; store("tab", name);
    document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-tab") === name); });
    document.querySelectorAll(".panel").forEach(function (p) { p.hidden = p.id !== "tab-" + name; });
  }

  function init() {
    document.querySelectorAll(".tab").forEach(function (b) { b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); window.scrollTo(0, 0); }); });
    document.querySelectorAll(".seg button").forEach(function (b) {
      b.addEventListener("click", function () { ui.view = b.getAttribute("data-view"); store("view", ui.view); renderReview(); });
    });
    var qt; $("q").addEventListener("input", function (e) { clearTimeout(qt); qt = setTimeout(function () { ui.q = e.target.value; renderReview(); }, 150); });
    [["fOpen", "fOpen"], ["fNear", "fNear"], ["fOld", "fOld"], ["fSkipped", "fSkipped"]].forEach(function (x) {
      $(x[0]).addEventListener("change", function (e) { ui[x[1]] = e.target.checked; renderReview(); });
    });
    $("refreshBtn").addEventListener("click", function () { $("status").textContent = "Checking…"; refresh(false); });
    $("lockBtn").addEventListener("click", function () { forgetKey(); P = null; showLock(""); });
    $("lockForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = $("unlockBtn"); btn.disabled = true; btn.textContent = "Unlocking…"; $("lockErr").textContent = "";
      unlock($("pass").value, $("remember").checked).then(function () { return refresh(true); })
        .catch(function (err) { $("lockErr").textContent = err.message || "Couldn't unlock."; })
        .then(function () { btn.disabled = false; btn.textContent = "Unlock"; });
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
    setInterval(poll, POLL_MS);
    showTab(ui.tab);
    refresh(true);
  }
  init();
})();
