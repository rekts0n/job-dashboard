/* Job Dashboard - vanilla JS, no libraries, no network calls except to this local server. */
(function () {
  "use strict";

  var POLL_MS = 5 * 60 * 1000; // check for new cron output every 5 minutes
  var STALE_HOURS = 36;        // warn if the data files haven't changed for this long

  var D = { jobs: null, queries: null, runs: null, status: null, site: {} };
  var ui = {
    tab: "jobs", q: "", minScore: null, company: "", location: "", source: "", sort: "date", chip: "all",
    hq: "", staleOnly: false, hSort: { key: "avg_results", dir: -1 }
  };
  var lastSignature = null;
  var errors = {};

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null) continue;
      if (k === "text") e.textContent = attrs[k];
      else if (k === "class") e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return e;
  }
  function dash(v) { return v === null || v === undefined || v === "" ? "—" : String(v); }
  function fmtNum(n) { return typeof n === "number" ? n.toLocaleString() : "—"; }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(d) {
    if (!d || !/^\d{4}-\d{2}-\d{2}/.test(d)) return "—";
    var y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
    var s = day + " " + MONTHS[m - 1];
    return y === new Date().getFullYear() ? s : s + " " + y;
  }
  function todayStr() {
    var t = new Date();
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }
  function daysAgo(d) {
    if (!d) return null;
    var a = new Date(d.slice(0, 10) + "T00:00:00"), b = new Date(todayStr() + "T00:00:00");
    return Math.round((b - a) / 86400000);
  }
  function relDay(d) {
    var n = daysAgo(d);
    if (n === null || isNaN(n)) return "—";
    if (n <= 0) return "today";
    if (n === 1) return "yesterday";
    return n + "d ago";
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    var t = new Date(iso);
    if (isNaN(t)) return iso;
    return t.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function store(k, v) { try { localStorage.setItem("jobdash." + k, JSON.stringify(v)); } catch (e) {} }
  function recall(k, dflt) {
    try { var v = localStorage.getItem("jobdash." + k); return v === null ? dflt : JSON.parse(v); } catch (e) { return dflt; }
  }

  function api(path, body) {
    var opts = body === undefined ? { cache: "no-store" } :
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return { error: "bad response (" + r.status + ")" }; }).then(function (j) {
        if (!r.ok && j && !j.error) j.error = "HTTP " + r.status;
        return j;
      });
    });
  }

  // ---------- data sources ----------
  // LOCAL: page served by server.py on this computer -> live JSON API, statuses saved in site_state.json.
  // HOSTED: page on the internet (GitHub Pages) -> encrypted data.json, statuses saved in this browser.
  var HOSTED = /[?&]hosted(=|&|$)/.test(location.search) ||
    !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var VISIT_GAP_MS = 30 * 60 * 1000;

  function isoNow() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }
  function mergeStatuses(statuses, updates) {
    var now = isoNow();
    Object.keys(updates).forEach(function (key) {
      var val = updates[key];
      if (val === null) { delete statuses[key]; return; }
      var e = Object.assign({}, statuses[key] || {});
      if ("status" in val) {
        if (val.status) { if (e.status !== val.status) e[val.status + "_at"] = now; e.status = val.status; }
        else delete e.status;
      }
      if ("note" in val) { if (val.note) e.note = val.note; else delete e.note; }
      if (val.title) e.title = val.title;
      if (val.company) e.company = val.company;
      e.updated_at = now;
      if (e.status || e.note) statuses[key] = e; else delete statuses[key];
    });
    return statuses;
  }

  var Local = {
    offline: "Can't reach the dashboard server. Start it again with “Start Job Dashboard.bat”.",
    load: function (recordVisit) {
      var visit = recordVisit ? api("/api/visit", {}).catch(function () { return null; }) : Promise.resolve(null);
      return visit.then(function (site) {
        return Promise.all([
          api("/api/jobs"), api("/api/queries"), api("/api/runs"), api("/api/status"),
          site ? Promise.resolve(site) : api("/api/state")
        ]);
      }).then(function (res) { res.version = res[3] && res[3].signature; return res; });
    },
    changed: function () {
      return api("/api/status").then(function (st) {
        if (st && st.signature && st.signature !== lastSignature) return true;
        if (st && !st.error) D.status = st;
        return false;
      });
    },
    save: function (updates) {
      return api("/api/state", { statuses: updates }).then(function (res) {
        if (res.error) throw new Error(res.error);
        return res.statuses || {};
      });
    },
    visit: function (markSeen) { return api("/api/visit", markSeen ? { mark_seen: true } : {}); }
  };

  // --- hosted mode: decrypt data.json with the passphrase (Web Crypto, no libraries) ---
  function lockError(msg) { var e = new Error(msg); e.locked = true; return e; }
  function unb64(s) { var bin = atob(s), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function toHex(a) { return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function fromHex(h) { var a = new Uint8Array(h.length / 2); for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16); return a; }
  function deriveKeys(pass, saltB64, iter) {
    var subtle = window.crypto && crypto.subtle;
    if (!subtle) return Promise.reject(new Error("This browser can't decrypt (needs an https:// page)."));
    return subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]).then(function (k) {
      return subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(saltB64), iterations: iter }, k, 512);
    }).then(function (bits) { return new Uint8Array(bits); });
  }
  function decryptBlob(blob, raw) {
    var subtle = crypto.subtle, iv = unb64(blob.iv), ct = unb64(blob.ct), mac = unb64(blob.mac);
    var signed = new Uint8Array(iv.length + ct.length); signed.set(iv); signed.set(ct, iv.length);
    return subtle.importKey("raw", raw.slice(32, 64), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]).then(function (k) {
      return subtle.verify("HMAC", k, mac, signed);
    }).then(function (ok) {
      if (!ok) throw lockError("Wrong passphrase.");
      return subtle.importKey("raw", raw.slice(0, 32), "AES-CTR", false, ["decrypt"]);
    }).then(function (k) {
      return subtle.decrypt({ name: "AES-CTR", counter: iv, length: 64 }, k, ct);
    }).then(function (buf) {
      return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"))).text();
    }).then(JSON.parse);
  }
  function savedKey() {
    var k = null;
    try { k = JSON.parse(sessionStorage.getItem("jobdash.key") || "null"); } catch (e) {}
    return k || recall("key", null);
  }
  function forgetKey() {
    try { sessionStorage.removeItem("jobdash.key"); localStorage.removeItem("jobdash.key"); } catch (e) {}
  }
  function fetchJson(name) {
    return fetch(name + "?t=" + Date.now(), { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(name + " not found (" + r.status + ") — has the publisher run yet?");
      return r.json();
    });
  }

  var Hosted = {
    offline: "Couldn't load the latest data — check your internet connection.",
    unlock: function (pass, remember) {
      return fetchJson("data.json").then(function (blob) {
        return deriveKeys(pass, blob.salt, blob.iter).then(function (raw) {
          return decryptBlob(blob, raw).then(function () {
            var k = { salt: blob.salt, hex: toHex(raw) };
            forgetKey();
            if (remember) store("key", k);
            else try { sessionStorage.setItem("jobdash.key", JSON.stringify(k)); } catch (e) {}
          });
        });
      });
    },
    load: function (recordVisit) {
      var key = savedKey();
      if (!key) return Promise.reject(lockError(""));
      return fetchJson("data.json").then(function (blob) {
        if (blob.salt !== key.salt) { forgetKey(); throw lockError("The passphrase was changed — enter the new one."); }
        return decryptBlob(blob, fromHex(key.hex)).catch(function (e) {
          if (e.locked) forgetKey();
          throw e;
        }).then(function (p) {
          var jobsList = (p.jobs && p.jobs.jobs) || [];
          var site = recordVisit ? Hosted.visitWith(jobsList, false) : Hosted.site();
          var res = [p.jobs, p.queries, p.runs, p.status, site];
          res.version = blob.iv; res.published_at = p.published_at;
          return res;
        });
      });
    },
    changed: function () {
      return fetchJson("version.json").then(function (v) { return v.version !== lastSignature; });
    },
    site: function () { var s = recall("site", {}); s.statuses = s.statuses || {}; return s; },
    save: function (updates) {
      var s = Hosted.site();
      mergeStatuses(s.statuses, updates);
      store("site", s);
      return Promise.resolve(s.statuses);
    },
    visitWith: function (jobsList, markSeen) {
      var s = Hosted.site(), now = isoNow();
      var fs = s.first_seen || {}, boot = !Object.keys(fs).length;
      jobsList.forEach(function (j) {
        if (!fs[j.key]) fs[j.key] = boot ? (j.date ? j.date + "T12:00:00Z" : "2000-01-01T00:00:00Z") : now;
      });
      s.first_seen = fs;
      var last = s.last_visit ? Date.parse(s.last_visit) : null;
      if (markSeen) s.prev_visit = now;
      else if (boot && !("prev_visit" in s)) {
        var latest = jobsList.reduce(function (m, j) { return j.date > m ? j.date : m; }, "");
        s.prev_visit = latest ? latest + "T00:00:00Z" : null;
      } else if (!last || Date.now() - last > VISIT_GAP_MS) s.prev_visit = s.last_visit || null;
      s.last_visit = now;
      store("site", s);
      return s;
    },
    visit: function (markSeen) { return Promise.resolve(Hosted.visitWith(jobs(), markSeen)); }
  };

  var Src = HOSTED ? Hosted : Local;

  // ---------- data loading ----------
  function loadAll(recordVisit) {
    return Src.load(recordVisit).then(function (res) {
      // Keep the previous good data if a file is mid-write / temporarily broken.
      setPart("jobs", res[0], function (x) { return Array.isArray(x.jobs) && x.jobs.length; });
      setPart("queries", res[1], function (x) { return Array.isArray(x.queries) && x.queries.length; });
      setPart("runs", res[2], function (x) { return Array.isArray(x.runs) && x.runs.length; });
      setPart("status", res[3], function (x) { return x.files; });
      if (res[4] && !res[4].error) D.site = res[4];
      lastSignature = res.version;
      D.publishedAt = res.published_at || null;
      delete errors.server;
      showApp();
      $("updated").textContent = HOSTED && D.publishedAt ? "Published " + fmtTime(D.publishedAt)
        : "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      renderAll();
    }).catch(function (e) {
      if (e && e.locked) return showLock(e.message);
      errors.server = HOSTED && e && e.message ? e.message : Src.offline;
      $("updated").textContent = "Offline";
      showApp();
      renderBanner();
    });
  }

  function showLock(msg) {
    document.body.classList.add("locked");
    $("lock").hidden = false;
    $("lockErr").textContent = msg || "";
    $("pass").value = "";
    setTimeout(function () { $("pass").focus(); }, 50);
  }
  function showApp() {
    document.body.classList.remove("locked");
    $("lock").hidden = true;
  }
  function setPart(name, val, hasData) {
    if (!val) return;
    if (val.error) errors[name] = val.error; else delete errors[name];
    if (!val.error || !D[name] || hasData(val)) D[name] = val;
  }

  function poll() {
    if (document.hidden || document.body.classList.contains("locked")) return;
    Src.changed().then(function (changed) {
      delete errors.server;
      if (changed) return loadAll(true);
      renderBanner(); renderHeader();
      if (!HOSTED) $("updated").textContent = "Checked " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }).catch(function () {
      errors.server = Src.offline;
      renderBanner();
    });
  }

  // ---------- job helpers ----------
  function jobs() { return (D.jobs && D.jobs.jobs) || []; }
  function statusOf(j) { var s = (D.site.statuses || {})[j.key]; return (s && s.status) || ""; }
  function noteOf(j) { var s = (D.site.statuses || {})[j.key]; return (s && s.note) || ""; }
  function isNew(j) {
    var fs = (D.site.first_seen || {})[j.key];
    var prev = D.site.prev_visit;
    if (!fs) return true; // appeared since the last visit was recorded
    return !!prev && fs > prev;
  }
  function scoreClass(s) { return typeof s !== "number" ? "na" : s >= 70 ? "hi" : "mid"; }
  var SOURCE_LABEL = { employer: "employer-direct", linkedin: "LinkedIn", aggregator: "aggregator", unknown: "no link" };

  function filteredJobs() {
    var terms = ui.q.toLowerCase().split(/\s+/).filter(Boolean);
    var min = ui.minScore == null ? 0 : ui.minScore;
    return jobs().filter(function (j) {
      if (typeof j.score === "number" && j.score < min) return false;
      if (ui.company && j.company !== ui.company) return false;
      if (ui.location && j.location !== ui.location) return false;
      if (ui.source && j.source !== ui.source) return false;
      if (terms.length) {
        var hay = (j.title + " " + j.company + " " + j.reason + " " + j.location).toLowerCase();
        for (var i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) return false;
      }
      return true;
    });
  }
  function chipMatch(j, chip) {
    var s = statusOf(j);
    if (chip === "rejected") return s === "rejected";
    if (s === "rejected") return false;
    if (chip === "all") return true;
    if (chip === "new") return isNew(j);
    return s === chip;
  }

  // ---------- rendering ----------
  function renderAll() {
    // Don't wipe a note you're in the middle of typing; try again shortly.
    var ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains("note")) { setTimeout(renderAll, 3000); return; }
    renderHeader(); renderBanner(); fillDropdowns(); renderJobs(); renderHealth(); renderRuns(); renderAbout();
  }

  function lastRunDate() {
    var r = D.runs && D.runs.runs && D.runs.runs[0];
    var q = D.queries && D.queries.latest_date;
    var best = r ? r.date : null;
    if (q && (!best || q > best)) best = q;
    return best;
  }

  function renderHeader() {
    var J = D.jobs || {};
    $("statMatches").textContent = fmtNum(J.unique_count != null ? J.unique_count : jobs().length);
    $("statNew").textContent = fmtNum(jobs().filter(function (j) { return isNew(j) && statusOf(j) !== "rejected"; }).length);
    $("statSeen").textContent = fmtNum(J.seen_count);
    $("statLast").textContent = J.last_match_date ? relDay(J.last_match_date) : "—";
    $("statLast").title = J.last_match_date || "";
    var lr = lastRunDate();
    $("statRun").textContent = lr ? relDay(lr) : "—";
    $("statRun").title = lr || "";
    $("statMin").textContent = dash(J.min_score);
  }

  function renderBanner() {
    var b = $("banner"), msgs = [], isErr = false;
    if (errors.server) { msgs.push(errors.server); isErr = true; }
    ["jobs", "queries", "runs", "status"].forEach(function (k) { if (errors[k]) { msgs.push(errors[k]); isErr = true; } });
    var st = D.status;
    if (st && st.data_dir_exists === false) {
      msgs.push("Data folder not found: " + st.data_dir + " — check the path in server.py or start with --data-dir.");
      isErr = true;
    } else if (st && st.newest_file_update) {
      var hrs = (Date.now() - new Date(st.newest_file_update).getTime()) / 3600000;
      if (hrs > STALE_HOURS) msgs.push("No data file has changed for " + Math.round(hrs / 24 * 10) / 10 +
        " days (last update " + fmtTime(st.newest_file_update) + "). Is the Hermes cron job still running?");
    }
    if (!msgs.length) { b.hidden = true; return; }
    b.hidden = false;
    b.className = "banner" + (isErr ? " error" : "");
    b.textContent = msgs.join("  •  ");
  }

  function fillSelect(sel, values, allLabel) {
    var cur = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    sel.options[0].textContent = allLabel;
    values.forEach(function (v) { sel.appendChild(el("option", { value: v[0], text: v[0] + " (" + v[1] + ")" })); });
    sel.value = values.some(function (v) { return v[0] === cur; }) ? cur : "";
  }
  function counts(field) {
    var m = {};
    jobs().forEach(function (j) { if (j[field]) m[j[field]] = (m[j[field]] || 0) + 1; });
    return Object.keys(m).map(function (k) { return [k, m[k]]; })
      .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
  }
  function fillDropdowns() {
    fillSelect($("company"), counts("company"), "All companies");
    fillSelect($("location"), counts("location"), "All locations");
    ui.company = $("company").value; ui.location = $("location").value;
    if (ui.minScore == null && D.jobs) {
      ui.minScore = typeof D.jobs.min_score === "number" ? D.jobs.min_score : 50;
      $("minScore").value = ui.minScore; $("minScoreVal").textContent = ui.minScore;
    }
  }

  var CHIPS = [["all", "All"], ["new", "New"], ["interested", "Interested"], ["applied", "Applied"], ["rejected", "Rejected"]];

  function renderJobs() {
    var base = filteredJobs();
    var chips = $("chips");
    chips.textContent = "";
    CHIPS.forEach(function (c) {
      var n = base.filter(function (j) { return chipMatch(j, c[0]); }).length;
      var b = el("button", { class: "chip" + (ui.chip === c[0] ? " active" : ""), "data-chip": c[0] }, c[1], el("span", { class: "n", text: n }));
      b.addEventListener("click", function () { ui.chip = c[0]; store("chip", ui.chip); renderJobs(); });
      chips.appendChild(b);
    });

    var list = base.filter(function (j) { return chipMatch(j, ui.chip); });
    if (ui.sort === "score") {
      list.sort(function (a, b) { return (b.score || 0) - (a.score || 0) || (b.date > a.date ? 1 : b.date < a.date ? -1 : 0); });
    }
    $("listCount").textContent = "Showing " + list.length + " of " + jobs().length;
    $("markSeen").hidden = !jobs().some(isNew);

    var box = $("jobList");
    box.textContent = "";
    if (!list.length) {
      var msg = !D.jobs ? "Loading…" : !jobs().length ? (D.jobs.error ? "No job data: " + D.jobs.error : "No matches yet. They'll appear here after the cron job reports one.")
        : "No jobs match these filters.";
      box.appendChild(el("div", { class: "empty", text: msg }));
      return;
    }
    var frag = document.createDocumentFragment();
    var tpl = $("jobTpl").content;
    list.forEach(function (j) { frag.appendChild(renderCard(j, tpl)); });
    box.appendChild(frag);
  }

  function renderCard(j, tpl) {
    var node = tpl.firstElementChild.cloneNode(true);
    var s = statusOf(j), fresh = isNew(j);
    if (s === "rejected") node.classList.add("is-rejected");
    if (fresh && s !== "rejected") node.classList.add("is-new");
    node.querySelector(".title").textContent = dash(j.title);
    node.querySelector(".company").textContent = dash(j.company);
    node.querySelector(".location").textContent = dash(j.location);
    var sc = node.querySelector(".score");
    sc.textContent = typeof j.score === "number" ? j.score : "—";
    sc.className = "score " + scoreClass(j.score);
    sc.title = "Match score";

    var tags = node.querySelector(".tags");
    if (fresh && s !== "rejected") tags.appendChild(el("span", { class: "badge new", text: "NEW" }));
    if (s) tags.appendChild(el("span", { class: "badge " + s, text: s === "rejected" ? "rejected" : s }));
    tags.appendChild(el("span", { class: "badge", title: j.date ? "Reported " + j.date : "", text: fmtDate(j.date) }));
    tags.appendChild(el("span", { class: "badge " + j.source, title: j.host || "", text: SOURCE_LABEL[j.source] || j.source }));
    if (j.blocked_domain) tags.appendChild(el("span", { class: "badge blocked", text: "blocked domain" }));
    if (j.times_reported > 1) tags.appendChild(el("span", { class: "badge", title: "First reported " + (j.first_reported || "?"), text: "reported ×" + j.times_reported }));

    var r = node.querySelector(".reason");
    r.textContent = j.reason || "—";
    if (j.description) r.title = j.description;
    r.addEventListener("click", function () { r.classList.toggle("open"); });

    var a = node.querySelector(".apply");
    if (j.url) a.href = j.url; else { a.classList.add("disabled"); a.textContent = "No link"; }

    node.querySelectorAll(".sbtn[data-s]").forEach(function (b) {
      if (b.getAttribute("data-s") === s) b.classList.add("on");
      b.addEventListener("click", function () {
        var want = b.getAttribute("data-s");
        setStatus(j, want === statusOf(j) ? null : want);
      });
    });

    var noteBtn = node.querySelector(".note-btn"), wrap = node.querySelector(".note-wrap"), ta = node.querySelector(".note");
    var note = noteOf(j);
    if (note) { ta.value = note; wrap.hidden = false; noteBtn.classList.add("has-note"); }
    noteBtn.addEventListener("click", function () { wrap.hidden = !wrap.hidden; if (!wrap.hidden) ta.focus(); });
    var timer = null;
    function saveNote() { clearTimeout(timer); timer = null; if (ta.value.trim() !== noteOf(j)) setNote(j, ta.value.trim(), noteBtn); }
    ta.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(saveNote, 800); });
    ta.addEventListener("blur", saveNote);
    return node;
  }

  function setStatus(j, s) {
    var prev = JSON.parse(JSON.stringify(D.site.statuses || {}));
    D.site.statuses = D.site.statuses || {};
    var entry = Object.assign({}, D.site.statuses[j.key] || {});
    if (s) entry.status = s; else delete entry.status;
    D.site.statuses[j.key] = entry;
    renderJobs(); renderHeader();
    var upd = {}; upd[j.key] = { status: s, title: j.title, company: j.company };
    Src.save(upd).then(function (statuses) {
      D.site.statuses = statuses;
      delete errors.server; renderBanner();
    }).catch(function (e) {
      D.site.statuses = prev; renderJobs(); renderHeader();
      errors.server = "Couldn't save: " + e.message; renderBanner();
    });
  }
  function setNote(j, note, btn) {
    var upd = {}; upd[j.key] = { note: note, title: j.title, company: j.company };
    Src.save(upd).then(function (statuses) {
      D.site.statuses = statuses;
      btn.classList.toggle("has-note", !!note);
    }).catch(function (e) { errors.server = "Couldn't save note: " + e.message; renderBanner(); });
  }

  // ---------- search health ----------
  var H_COLS = [
    ["query", "Query", false], ["history", "Recent runs", false], ["runs", "Runs", true], ["total_results", "Total results", true],
    ["avg_results", "Avg / run", true], ["last_hit_date", "Last > 0", false], ["last_run_date", "Last run", false],
    ["zero_streak", "Zero streak", true], ["status", "Status", false]
  ];
  function renderHealth() {
    var t = $("healthTable");
    t.textContent = "";
    var Q = D.queries;
    var rows = (Q && Q.summary) || [];
    var stale = rows.filter(function (r) { return r.stale; }).length;
    var never = rows.filter(function (r) { return r.never_hit; }).length;
    $("healthSummary").textContent = rows.length ? rows.length + " queries · " + ((Q && Q.line_count) || 0) + " log lines · " +
      stale + " stale · " + never + " never returned anything" + (Q && Q.skipped_lines ? " · " + Q.skipped_lines + " unreadable lines skipped" : "") : "";

    var terms = ui.hq.toLowerCase();
    var list = rows.filter(function (r) {
      if (ui.staleOnly && !r.stale) return false;
      return !terms || r.query.toLowerCase().indexOf(terms) >= 0;
    });
    var k = ui.hSort.key, dir = ui.hSort.dir;
    list.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (k === "status") { x = (a.stale ? 2 : 0) + (a.top10 ? 1 : 0); y = (b.stale ? 2 : 0) + (b.top10 ? 1 : 0); }
      if (x == null) x = ""; if (y == null) y = "";
      var c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c * dir || b.total_results - a.total_results;
    });

    var tr = el("tr");
    H_COLS.forEach(function (c) {
      var sortable = c[0] !== "history";
      var th = el("th", { class: (c[2] ? "num " : "") + (sortable ? "sortable" : "") + (k === c[0] ? " sorted" : "") },
        c[1] + (k === c[0] ? (dir < 0 ? " ↓" : " ↑") : ""));
      if (sortable) th.addEventListener("click", function () {
        if (ui.hSort.key === c[0]) ui.hSort.dir *= -1;
        else ui.hSort = { key: c[0], dir: c[2] || c[0] === "status" || /date/.test(c[0]) ? -1 : 1 };
        store("hSort", ui.hSort); renderHealth();
      });
      tr.appendChild(th);
    });
    t.appendChild(el("thead", null, tr));
    var tb = el("tbody");
    if (!list.length) {
      tb.appendChild(el("tr", null, el("td", { colspan: H_COLS.length, class: "zero", text: !Q ? "Loading…" : Q.error ? "No query log: " + Q.error : "No queries match." })));
    }
    var maxN = 1;
    rows.forEach(function (r) { (r.history || []).forEach(function (n) { if (n > maxN) maxN = n; }); });
    list.forEach(function (r) {
      var status = el("td");
      if (r.stale) status.appendChild(el("span", { class: "badge rejected", title: "Zero results on the last " + r.zero_streak + " runs", text: "stale" }));
      if (r.top10) status.appendChild(el("span", { class: "badge employer", text: "top 10" }));
      if (r.never_hit) status.appendChild(el("span", { class: "badge", text: "never hit" }));
      var spark = el("span", { class: "spark", title: "Last " + (r.history || []).length + " runs: " + (r.history || []).join(", ") });
      (r.history || []).forEach(function (n) {
        var h = Math.max(2, Math.round(n / maxN * 16));
        spark.appendChild(el("i", { class: n ? "" : "z", style: "height:" + h + "px" }));
      });
      tb.appendChild(el("tr", { class: r.stale ? "stale" : "" },
        el("td", { class: "wrap", text: r.query }),
        el("td", null, spark),
        el("td", { class: "num", text: r.runs }),
        el("td", { class: "num" + (r.total_results ? "" : " zero"), text: r.total_results }),
        el("td", { class: "num", text: r.avg_results }),
        el("td", { class: r.last_hit_date ? "" : "zero", text: r.last_hit_date ? fmtDate(r.last_hit_date) : "never" }),
        el("td", { class: r.in_latest_run ? "" : "zero", title: r.in_latest_run ? "" : "Not used in the latest run", text: fmtDate(r.last_run_date) }),
        el("td", { class: "num" + (r.zero_streak >= 2 ? " bad" : r.zero_streak ? " warn" : ""), text: r.zero_streak }),
        status));
    });
    t.appendChild(tb);
  }

  // ---------- runs ----------
  function renderRuns() {
    var t = $("runsTable");
    t.textContent = "";
    var R = D.runs;
    var cols = ["Date", "New", "Scanned", "Dedup", "Expired / blocked", "Auto-rejected", "Non-job", "Below threshold", "ATS boards", "DDG"];
    var tr = el("tr");
    cols.forEach(function (c, i) { tr.appendChild(el("th", { class: i > 0 && i < 8 ? "num" : "", text: c })); });
    t.appendChild(el("thead", null, tr));
    var tb = el("tbody");
    var runs = (R && R.runs) || [];
    if (!runs.length) tb.appendChild(el("tr", null, el("td", { colspan: cols.length, class: "zero", text: !R ? "Loading…" : R.error ? "No run log: " + R.error : "No parsed runs yet." })));
    runs.forEach(function (r) {
      var b = r.boards || {}, d = r.ddg || {};
      var boardsTxt = b.ok != null ? b.ok + " OK" + (b.failed ? ", " + b.failed + " failed" : "") : "—";
      var boardsTitle = Object.keys(b).map(function (k) { return k + "=" + b[k]; }).join(", ");
      var ddgTxt = d.queries != null ? d.queries + " q · " + dash(d.empty) + " empty" : "—";
      var ddgWarn = d.queries && d.empty != null && d.empty / d.queries >= 0.5;
      var det = r.details || {};
      function detailFor(prefix) {
        for (var k in det) if (k.indexOf(prefix) === 0) return det[k];
        return null;
      }
      var row = el("tr", { class: "clickable", title: "Click to show the original line" },
        el("td", { text: fmtDate(r.date) + (r.time ? " " + r.time : "") }),
        el("td", { class: "num" + (r.new_matches ? " good" : " zero"), text: dash(r.new_matches) }),
        el("td", { class: "num", title: detailFor("scanned"), text: dash(r.scanned) }),
        el("td", { class: "num", text: dash(r.dedup) }),
        el("td", { class: "num", title: detailFor("expired"), text: dash(r.expired_blocked) }),
        el("td", { class: "num", text: dash(r.auto_rejected) }),
        el("td", { class: "num", text: dash(r.nonjob) }),
        el("td", { class: "num", title: r.near_misses || null, text: dash(r.below_threshold) + (r.near_misses ? " *" : "") }),
        el("td", { class: b.failed ? "bad" : "", title: boardsTitle, text: boardsTxt }),
        el("td", { class: ddgWarn ? "warn" : "", title: ddgWarn ? "Half or more of the DDG queries returned nothing" : null, text: ddgTxt }));
      var extra = [];
      if (r.near_misses) extra.push("Near misses: " + r.near_misses);
      Object.keys(det).forEach(function (k) { if (k.indexOf("below") !== 0) extra.push(k + ": " + det[k]); });
      var raw = el("tr", { class: "raw", hidden: "" }, el("td", { colspan: cols.length },
        el("div", { text: r.raw }), extra.length ? el("div", { style: "margin-top:6px;color:var(--text)", text: extra.join("  ·  ") }) : null));
      row.addEventListener("click", function () { raw.hidden = !raw.hidden; });
      tb.appendChild(row); tb.appendChild(raw);
    });
    t.appendChild(tb);

    var up = $("unparsed");
    up.textContent = "";
    var bad = (R && R.unparsed) || [];
    if (bad.length) {
      var box = el("div", { class: "unparsed" }, el("h3", { text: "Unparsed runs (" + bad.length + ")" }));
      bad.forEach(function (u) { box.appendChild(el("pre", { text: "line " + u.line + ":  " + u.raw })); });
      up.appendChild(box);
    }
    if (runs.some(function (r) { return r.near_misses; })) {
      up.insertBefore(el("p", { class: "muted", style: "font-size:12px;margin:8px 2px 0", text: "* hover or click the row to see near-misses (scored just under the threshold; not in your job list)." }), up.firstChild);
    }
  }

  // ---------- about ----------
  function fmtSalary(s) {
    if (s == null) return "—";
    if (typeof s === "string" || typeof s === "number") return String(s);
    if (Array.isArray(s)) return s.map(function (x) { return typeof x === "number" ? x.toLocaleString() : String(x); }).join(" – ");
    if (typeof s === "object") {
      var lo = s.min != null ? s.min : s.low, hi = s.max != null ? s.max : s.high;
      if (lo != null || hi != null) {
        return [s.currency || "", (lo != null ? Number(lo).toLocaleString() : "?") + " – " + (hi != null ? Number(hi).toLocaleString() : "?"),
          s.period ? "/ " + s.period : ""].join(" ").trim();
      }
      return JSON.stringify(s);
    }
    return "—";
  }
  function fmtSize(n) { return n == null ? "" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B"; }

  function renderAbout() {
    var a = $("about");
    a.textContent = "";
    var st = D.status || {}, cfg = st.config || {}, J = D.jobs || {};

    var c = el("div", { class: "box" }, el("h3", { text: "Search config" }));
    c.appendChild(el("dl", { class: "kv" },
      el("dt", { text: "Min score" }), el("dd", { text: dash(cfg.min_score) }),
      el("dt", { text: "Salary range" }), el("dd", { text: fmtSalary(cfg.salary_range) }),
      el("dt", { text: "ATS watchlist" }), el("dd", { text: (cfg.watchlist || []).length + " companies" })));
    var pills = el("div", { class: "pill-list", style: "margin-top:10px" });
    (cfg.watchlist || []).forEach(function (w) { pills.appendChild(el("span", { class: "badge", title: w.ats || "", text: w.name })); });
    c.appendChild(pills);
    if (cfg.error) c.appendChild(el("p", { class: "muted", style: "margin-top:8px", text: "Config: " + cfg.error }));
    a.appendChild(c);

    var src = el("div", { class: "box" }, el("h3", { text: "Source badges" }),
      el("p", null, el("span", { class: "badge employer", text: "employer-direct" }), " ATS pages (Lever, Greenhouse, Ashby, SmartRecruiters, Workday…) or the company's own careers site."),
      el("p", null, el("span", { class: "badge linkedin", text: "LinkedIn" }), " a linkedin.com/jobs/view listing."),
      el("p", null, el("span", { class: "badge aggregator", text: "aggregator" }), " job boards and everything else."),
      el("p", { class: "muted", text: "From your config: " + (cfg.aggregator_domains || []).length + " aggregator domains, " +
        (cfg.blocked_domains || []).length + " hard-blocked domains." }));
    var srcCounts = {};
    jobs().forEach(function (j) { srcCounts[j.source] = (srcCounts[j.source] || 0) + 1; });
    src.appendChild(el("p", { class: "muted", text: "Your matches: " + Object.keys(srcCounts).map(function (k) { return srcCounts[k] + " " + (SOURCE_LABEL[k] || k); }).join(", ") }));
    a.appendChild(src);

    var f = el("div", { class: "box" }, el("h3", { text: "Data files (read-only)" }));
    var kv = el("dl", { class: "kv" });
    kv.appendChild(el("dt", { text: "Folder" })); kv.appendChild(el("dd", null, el("code", { text: dash(st.data_dir) })));
    Object.keys(st.files || {}).forEach(function (k) {
      var fi = st.files[k];
      kv.appendChild(el("dt", { text: fi.name }));
      kv.appendChild(el("dd", { class: fi.exists ? "" : "muted", text: fi.exists ? "updated " + fmtTime(fi.modified) + " · " + fmtSize(fi.size) : "missing" }));
    });
    f.appendChild(kv);
    f.appendChild(el("p", { class: "muted", style: "margin-top:10px", text: "History: " + dash(J.history_count) + " records → " + dash(J.unique_count) +
      " unique jobs" + (J.duplicates_merged ? " (" + J.duplicates_merged + " repeat URLs merged)" : "") + (J.invalid_records ? ", " + J.invalid_records + " unreadable" : "") + "." }));
    a.appendChild(f);

    var h = el("div", { class: "box" }, el("h3", { text: "How this works" }),
      HOSTED
        ? el("p", { text: "Your PC uploads an encrypted copy of the Hermes data after each cron run (it checks hourly). This page checks for a new upload every 5 minutes and whenever you come back to the tab. Last upload: " + fmtTime(D.publishedAt) + "." })
        : el("p", { text: "The page re-reads your Hermes files every 5 minutes (and whenever you come back to the tab), so it always shows the latest cron run. Nothing is cached and nothing is sent to the internet." }),
      el("p", { text: "“New” means the job appeared since your previous visit (a visit = opening the page after 30+ minutes away). Use “Mark all as seen” to clear the markers." }),
      HOSTED
        ? el("p", { text: "Your Interested / Applied / Reject choices and notes are saved in this browser only — they don't sync between your phone and computer, and clearing browser data erases them." })
        : el("p", null, "Your Interested / Applied / Reject choices and notes are saved in ", el("code", { text: dash(st.state_file) }), " — the only file this site writes. Back it up if you care about your application history."),
      el("p", { class: "muted", text: "Previous visit: " + fmtTime(D.site.prev_visit) + " · This visit: " + fmtTime(D.site.last_visit) }));
    a.appendChild(h);
  }

  // ---------- tabs & controls ----------
  function showTab(name) {
    if (!$("tab-" + name)) name = "jobs";
    ui.tab = name; store("tab", name);
    document.querySelectorAll(".tab").forEach(function (b) {
      var on = b.getAttribute("data-tab") === name;
      b.classList.toggle("active", on); b.setAttribute("aria-selected", on);
    });
    document.querySelectorAll(".panel").forEach(function (p) { p.hidden = p.id !== "tab-" + name; });
    if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  }

  function init() {
    ui.tab = (location.hash || "").slice(1) || recall("tab", "jobs");
    ui.sort = recall("sort", "date");
    ui.chip = recall("chip", "all");
    ui.hSort = recall("hSort", ui.hSort);
    $("sort").value = ui.sort;

    document.querySelectorAll(".tab").forEach(function (b) {
      b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); });
    });
    showTab(ui.tab);

    var qTimer;
    $("q").addEventListener("input", function (e) { clearTimeout(qTimer); qTimer = setTimeout(function () { ui.q = e.target.value; renderJobs(); }, 120); });
    $("minScore").addEventListener("input", function (e) { ui.minScore = +e.target.value; $("minScoreVal").textContent = ui.minScore; renderJobs(); });
    $("company").addEventListener("change", function (e) { ui.company = e.target.value; renderJobs(); });
    $("location").addEventListener("change", function (e) { ui.location = e.target.value; renderJobs(); });
    $("source").addEventListener("change", function (e) { ui.source = e.target.value; renderJobs(); });
    $("sort").addEventListener("change", function (e) { ui.sort = e.target.value; store("sort", ui.sort); renderJobs(); });
    $("hq").addEventListener("input", function (e) { ui.hq = e.target.value; renderHealth(); });
    $("staleOnly").addEventListener("change", function (e) { ui.staleOnly = e.target.checked; renderHealth(); });
    $("refreshBtn").addEventListener("click", function () { $("updated").textContent = "Refreshing…"; loadAll(true); });
    $("markSeen").addEventListener("click", function () {
      Src.visit(true).then(function (s) { if (s && !s.error) { D.site = s; renderJobs(); renderHeader(); renderAbout(); } });
    });
    if (HOSTED) {
      $("lockBtn").hidden = false;
      $("lockBtn").addEventListener("click", function () { forgetKey(); D = { jobs: null, queries: null, runs: null, status: null, site: {} }; showLock(""); });
      $("lockForm").addEventListener("submit", function (e) {
        e.preventDefault();
        var btn = $("unlockBtn");
        btn.disabled = true; btn.textContent = "Unlocking…"; $("lockErr").textContent = "";
        Hosted.unlock($("pass").value, $("remember").checked).then(function () {
          return loadAll(true);
        }).catch(function (err) {
          $("lockErr").textContent = err.message || "Couldn't unlock.";
        }).then(function () { btn.disabled = false; btn.textContent = "Unlock"; });
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault(); showTab("jobs"); $("q").focus();
      }
    });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });
    setInterval(poll, POLL_MS);
    loadAll(true);
  }

  init();
})();
