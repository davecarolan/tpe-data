/**
 * tpe-data.js — The Performance Ecosystem · Shared Data Layer v4 (GitHub Edition)
 *
 * Backend changed from Supabase → GitHub JSON files + GitHub Contents API
 *
 *   READ  → raw.githubusercontent.com  (public CDN, no auth, very fast)
 *   WRITE → api.github.com             (requires PAT token, admin only)
 *
 * GitHub repo structure expected:
 *   data/vendors.json
 *   data/news.json
 *   data/events.json
 *   data/jobs.json
 *   data/clubs.json
 *   data/club_people.json
 *   data/practitioners.json
 *   data/club_vendors.json
 *   data/admin_users.json
 *
 * User preferences (eco, saved events/jobs) → localStorage ONLY
 *   (never stored in GitHub — keeps the repo public-safe)
 *
 * Cache TTLs, session model, and the entire public API are identical
 * to v3 (Supabase).  No HTML page changes required.
 *
 * ── SETUP ────────────────────────────────────────────────────────────
 *  1. Create a GitHub repo (public recommended for read performance)
 *  2. Add the /data/ JSON seed files from this package
 *  3. Create a fine-grained Personal Access Token:
 *       GitHub → Settings → Developer settings → Fine-grained tokens
 *       Repository access: just this repo
 *       Permissions → Contents: Read and write
 *  4. Fill in GH_OWNER, GH_REPO, GH_TOKEN below
 * ─────────────────────────────────────────────────────────────────────
 */

const TPE = (function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
     GITHUB CONFIG  ← fill these in before deploying
  ══════════════════════════════════════════════════════════════════ */
  var GH_OWNER  = 'davecarolan';
  var GH_REPO   = 'tpe-data';
  var GH_BRANCH = 'main';
  // Fine-grained PAT — Contents: read+write on this repo only
  // ← Paste your token here after completing Step 3 in the setup guide
  var GH_TOKEN  = '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';

  var GH_RAW = 'https://raw.githubusercontent.com/' +
    GH_OWNER + '/' + GH_REPO + '/' + GH_BRANCH + '/data/';
  var GH_API = 'https://api.github.com/repos/' +
    GH_OWNER + '/' + GH_REPO + '/contents/data/';

  /* ── Session key ─────────────────────────────────────────────────── */
  var KEYS = { session: 'eg_session_v1' };

  /* ── UUID v4 generator (replaces Supabase gen_random_uuid()) ─────── */
  function _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     EGRESS CACHE — TTL localStorage cache (unchanged from v3)
  ══════════════════════════════════════════════════════════════════ */
  var MIN = 60 * 1000;
  var CACHE_CFG = {
    vendors:       { key: 'tpe_cache_vendors',       ttl: 30 * MIN },
    news:          { key: 'tpe_cache_news',          ttl: 10 * MIN },
    events:        { key: 'tpe_cache_events',        ttl: 10 * MIN },
    jobs:          { key: 'tpe_cache_jobs',          ttl: 10 * MIN },
    clubs:         { key: 'tpe_cache_clubs',         ttl: 15 * MIN },
    practitioners: { key: 'tpe_cache_practitioners', ttl: 15 * MIN }
  };

  function _cacheGet(cfg) {
    try {
      var raw = localStorage.getItem(cfg.key);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.ts || !Array.isArray(obj.data)) return null;
      if (Date.now() - obj.ts > cfg.ttl) return null;
      return obj.data;
    } catch (e) { return null; }
  }

  function _cacheSet(cfg, data) {
    try {
      localStorage.setItem(cfg.key, JSON.stringify({ ts: Date.now(), data: data }));
    } catch (e) {}
  }

  function _cacheBust(cfg) {
    try { localStorage.removeItem(cfg.key); } catch (e) {}
  }

  function bustAllCaches() {
    Object.values(CACHE_CFG).forEach(function (cfg) { _cacheBust(cfg); });
  }

  /* ══════════════════════════════════════════════════════════════════
     USER DATA — in-memory + localStorage (no GitHub storage for user data)
  ══════════════════════════════════════════════════════════════════ */
  var _userData = { ecoNow: [], ecoFuture: [], events: [], jobs: [] };
  function _emptyUserData() { return { ecoNow: [], ecoFuture: [], events: [], jobs: [] }; }

  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }

  function lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('[TPE] localStorage write failed:', key, e.message);
      return false;
    }
  }

  function _unique(arr) {
    var seen = {};
    return (arr || []).filter(function (v) {
      if (!v || seen[v]) return false;
      seen[v] = true;
      return true;
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     GITHUB DATA LAYER — Read (raw CDN) + Write (Contents API)
  ══════════════════════════════════════════════════════════════════ */

  /**
   * Fetch a JSON file from the repo's /data/ folder.
   * Uses the raw CDN — fast, no auth, works without a token.
   * Cache-busting query param ensures admins see fresh data after writes.
   */
  function ghGet(filename) {
    var url = GH_RAW + filename + '.json?t=' + Date.now();
    return fetch(url)
      .then(function (res) {
        if (!res.ok) {
          console.warn('[TPE] ghGet', filename, res.status);
          return [];
        }
        return res.json().then(function (d) { return Array.isArray(d) ? d : []; });
      })
      .catch(function (err) {
        console.warn('[TPE] ghGet', filename, 'network:', err.message);
        return [];
      });
  }

  /**
   * Get the current blob SHA for a file.
   * Required by the GitHub Contents API before any write.
   */
  function _ghGetSha(filename) {
    return fetch(GH_API + filename + '.json', {
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept':        'application/vnd.github+json'
      }
    })
      .then(function (res) {
        if (!res.ok) return null;
        return res.json().then(function (d) { return d.sha || null; });
      })
      .catch(function () { return null; });
  }

  /**
   * Write (PUT) a records array back to GitHub.
   * sha must be the current blob SHA (from _ghGetSha).
   */
  function _ghWrite(filename, records, sha) {
    var json = JSON.stringify(records, null, 2);
    var content;
    try {
      // encodeURIComponent → unescape handles multi-byte Unicode in btoa
      content = btoa(unescape(encodeURIComponent(json)));
    } catch (e) {
      content = btoa(json);
    }
    var payload = {
      message: 'Update ' + filename + '.json [TPE admin]',
      content: content,
      branch:  GH_BRANCH
    };
    if (sha) payload.sha = sha;

    return fetch(GH_API + filename + '.json', {
      method:  'PUT',
      headers: {
        'Authorization': 'Bearer ' + GH_TOKEN,
        'Accept':        'application/vnd.github+json',
        'Content-Type':  'application/json'
      },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            console.error('[TPE] ghWrite FAILED', filename, res.status, t.slice(0, 400));
            return null;
          });
        }
        return res.json();
      })
      .catch(function (err) {
        console.warn('[TPE] ghWrite network:', err.message);
        return null;
      });
  }

  /* ── Low-level upsert / patch / delete ───────────────────────────── */

  /** Upsert a record into a JSON file. Returns the saved record (or null). */
  function dbSave(filename, body) {
    var now = new Date().toISOString();
    return Promise.all([ghGet(filename), _ghGetSha(filename)])
      .then(function (results) {
        var records = results[0];
        var sha     = results[1];
        if (!Array.isArray(records)) records = [];

        var saved;
        if (body.id) {
          var idx = -1;
          for (var i = 0; i < records.length; i++) {
            if (records[i].id === body.id) { idx = i; break; }
          }
          if (idx > -1) {
            records[idx] = Object.assign({}, records[idx], body, { updated_at: now });
            saved = records[idx];
          } else {
            saved = Object.assign({ created_at: now }, body, { updated_at: now });
            records.push(saved);
          }
        } else {
          saved = Object.assign({ id: _uuid(), created_at: now, updated_at: now }, body);
          records.push(saved);
        }

        return _ghWrite(filename, records, sha).then(function (res) {
          return res ? saved : null;
        });
      });
  }

  /** Patch specific fields on one record identified by id. */
  function dbPatch(filename, id, updates) {
    var now = new Date().toISOString();
    return Promise.all([ghGet(filename), _ghGetSha(filename)])
      .then(function (results) {
        var records = results[0];
        var sha     = results[1];
        var found   = null;
        for (var i = 0; i < records.length; i++) {
          if (records[i].id === id) {
            records[i] = Object.assign({}, records[i], updates, { updated_at: now });
            found = records[i];
            break;
          }
        }
        if (!found) return null;
        return _ghWrite(filename, records, sha).then(function () { return found; });
      });
  }

  /** Delete a record by id from a JSON file. Returns true on success. */
  function dbDelete(filename, id) {
    return Promise.all([ghGet(filename), _ghGetSha(filename)])
      .then(function (results) {
        var records = results[0].filter(function (r) { return r.id !== id; });
        var sha     = results[1];
        return _ghWrite(filename, records, sha).then(function (res) { return !!res; });
      });
  }

  /* ══════════════════════════════════════════════════════════════════
     AUTH
  ══════════════════════════════════════════════════════════════════ */

  function getSession() {
    // 1. Primary admin session (eg_session_v1)
    try {
      var raw = localStorage.getItem(KEYS.session);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.email && s.id) {
          return Object.assign({ name: s.name || s.email.split('@')[0] }, s);
        }
      }
    } catch (e) {}
    // 2. SportsOS user session
    try {
      var rawU = localStorage.getItem('tpe_user_session_v1');
      if (rawU) {
        var su = JSON.parse(rawU);
        if (su && su.id && su.email) {
          return Object.assign({ name: su.name || su.email.split('@')[0] }, su);
        }
      }
    } catch (e) {}
    return null;
  }

  function setSession(data)  { lsSet(KEYS.session, data); }

  function clearSession() {
    try {
      localStorage.removeItem(KEYS.session);
      localStorage.removeItem('tpe_user_session_v1');
      // Remove any Supabase SDK tokens still lingering in localStorage
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0) localStorage.removeItem(k);
      }
    } catch (e) {}
  }

  function isAdmin() {
    var s = getSession();
    return !!(s && s.type === 'admin');
  }

  function adminLogin(email, password) {
    // Hardcoded primary admin (unchanged from v3)
    var ADMIN_EMAIL = 'admin@ecosystemgenesis.com';
    var ADMIN_PASS  = 'Genesis2026';
    if (email === ADMIN_EMAIL && password === ADMIN_PASS) {
      setSession({ type: 'admin', id: 'admin', email: ADMIN_EMAIL, name: 'Admin' });
      return Promise.resolve({ ok: true });
    }
    // Secondary: check admin_users.json in the GitHub repo
    return ghGet('admin_users').then(function (users) {
      var user = null;
      for (var i = 0; i < users.length; i++) {
        if (users[i].email === email) { user = users[i]; break; }
      }
      if (!user) return { ok: false, error: 'Invalid credentials' };
      var stored = user.password_hash || user.password || '';
      if (stored && stored === password) {
        setSession({
          type:  'admin',
          id:    user.id,
          email: user.email,
          name:  user.name || email.split('@')[0]
        });
        return { ok: true, user: user };
      }
      return { ok: false, error: 'Invalid credentials' };
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     USER DATA — localStorage ONLY
     (User preferences are personal; GitHub repo stays public-safe.)
  ══════════════════════════════════════════════════════════════════ */

  function loadUserData(userId) {
    if (!userId) return Promise.resolve({ current: [], future: [] });
    // Restore from localStorage if same user as last session
    var lsUid = lsGet('tpe_ud_uid', null);
    if (lsUid && lsUid === userId) {
      _userData.ecoNow    = lsGet('tpe_ud_eco',    []);
      _userData.ecoFuture = lsGet('tpe_ud_future', []);
      _userData.events    = lsGet('tpe_ud_events', []);
      _userData.jobs      = lsGet('tpe_ud_jobs',   []);
    }
    return Promise.resolve({ current: _userData.ecoNow, future: _userData.ecoFuture });
  }

  function initUserCache(data) {
    if (!data) return;
    _userData.ecoNow    = Array.isArray(data.eco_current)  ? data.eco_current  : [];
    _userData.ecoFuture = Array.isArray(data.eco_future)   ? data.eco_future   : [];
    _userData.events    = Array.isArray(data.saved_events) ? data.saved_events : [];
    _userData.jobs      = Array.isArray(data.saved_jobs)   ? data.saved_jobs   : [];
  }

  function clearUserData() { _userData = _emptyUserData(); }

  function _saveUserData() {
    var sess   = getSession();
    var userId = sess && sess.id ? sess.id : null;
    if (!userId && typeof window !== 'undefined' && window._tpeCurrentUser && window._tpeCurrentUser.id) {
      userId = window._tpeCurrentUser.id;
    }
    if (!userId) return;
    lsSet('tpe_ud_uid',    userId);
    lsSet('tpe_ud_eco',    _unique(_userData.ecoNow));
    lsSet('tpe_ud_future', _unique(_userData.ecoFuture));
    lsSet('tpe_ud_events', _unique(_userData.events));
    lsSet('tpe_ud_jobs',   _unique(_userData.jobs));
  }

  /* ── Ecosystem ───────────────────────────────────────────────────── */
  function getEco() {
    return { current: _userData.ecoNow.slice(), future: _userData.ecoFuture.slice() };
  }

  function saveEco(eco) {
    _userData.ecoNow    = _unique(eco.current || []);
    _userData.ecoFuture = _unique(eco.future  || []);
    _saveUserData();
    return eco;
  }

  function ecoToggle(vendorId, type) {
    var key  = type === 'current' ? 'ecoNow' : 'ecoFuture';
    var list = (_userData[key] || []).slice();
    var idx  = list.indexOf(vendorId);
    if (idx > -1) list.splice(idx, 1); else list.push(vendorId);
    _userData[key] = list;
    _saveUserData();
    return getEco();
  }

  function ecoHas(vendorId, type) {
    return (type === 'current' ? _userData.ecoNow : _userData.ecoFuture).indexOf(vendorId) > -1;
  }

  function getUserEcosystem(userId)          { return loadUserData(userId); }
  function saveUserEcosystem(userId, eco)    { saveEco(eco); return Promise.resolve(true); }

  /* ── Saved Events ────────────────────────────────────────────────── */
  function getSavedEvents()       { return _userData.events.slice(); }
  function isEventSaved(eventId)  { return _userData.events.indexOf(eventId) > -1; }
  function toggleSavedEvent(eventId) {
    var ids = _userData.events.slice();
    var idx = ids.indexOf(eventId);
    if (idx > -1) ids.splice(idx, 1); else ids.push(eventId);
    _userData.events = ids;
    _saveUserData();
    return ids;
  }

  /* ── Saved Jobs ──────────────────────────────────────────────────── */
  function getSavedJobs()        { return _userData.jobs.slice(); }
  function isJobSaved(jobId)     { return _userData.jobs.indexOf(jobId) > -1; }
  function toggleSavedJob(jobId) {
    var ids = _userData.jobs.slice();
    var idx = ids.indexOf(jobId);
    if (idx > -1) ids.splice(idx, 1); else ids.push(jobId);
    _userData.jobs = ids;
    _saveUserData();
    return ids;
  }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC DATA READS  (with TTL cache — identical contract to v3)
  ══════════════════════════════════════════════════════════════════ */

  function getVendors() {
    var cached = _cacheGet(CACHE_CFG.vendors);
    if (cached) return Promise.resolve(cached);

    return ghGet('vendors').then(function (rows) {
      var result = rows
        .filter(function (r) { return r.is_active !== false && !r.is_archived; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .map(function (r) {
          return {
            id:            r.id            || '',
            name:          r.name          || '',
            website:       r.website       || '#',
            tech:          r.tech          || '',
            sport:         r.sport         || 'MultiSports',
            logo:          r.logo_url      || r.logo_data || '',
            categories:    Array.isArray(r.categories)    ? r.categories    : [],
            synopsis:      r.synopsis      || '',
            synopsis_long: r.synopsis_long || '',
            type:          Array.isArray(r.type) ? r.type : (r.type ? [r.type] : []),
            portfolio:     r.portfolio     || '',
            ecosystem:     Array.isArray(r.ecosystem)     ? r.ecosystem     : [],
            strengths:     r.strengths     || '',
            challenges:    r.challenges    || '',
            opportunities: r.opportunities || '',
            threats:       r.threats       || '',
            background:    r.background    || '',
            key_clients:   Array.isArray(r.key_clients)   ? r.key_clients   : [],
            is_featured:   !!r.is_featured,
            is_new:        !!r.is_new,
            is_archived:   !!r.is_archived,
            show_in_gallery: !!r.show_in_gallery,
            scores:        r.scores        || {},
            swot:          r.swot          || null,
            tags:          Array.isArray(r.tags)          ? r.tags          : [],
            social:        Array.isArray(r.social)        ? r.social        : [],
            key_personnel: Array.isArray(r.key_personnel) ? r.key_personnel : []
          };
        })
        .filter(function (v) { return v.name; });

      _cacheSet(CACHE_CFG.vendors, result);
      return result;
    });
  }

  function getNews(limit) {
    var cacheKey = limit ? null : CACHE_CFG.news;
    var cached   = cacheKey ? _cacheGet(cacheKey) : null;
    if (cached) return Promise.resolve(cached);

    return ghGet('news').then(function (rows) {
      var result = rows
        .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); })
        .map(function (r) {
          return {
            id:              r.id          || '',
            headline:        r.headline    || '',
            summary:         r.summary     || '',
            url:             r.url         || '#',
            source:          r.source      || '',
            date:            r.date        || '',
            image_url:       r.image_url   || '',
            tags:            Array.isArray(r.tags)        ? r.tags        : [],
            departments:     Array.isArray(r.departments) ? r.departments : [],
            vendors:         Array.isArray(r.vendors)     ? r.vendors     : [],
            featured:        !!r.featured,
            is_new:          !!r.is_new,
            is_archived:     !!r.is_archived,
            show_in_gallery: !!r.show_in_gallery
          };
        });

      if (limit) result = result.slice(0, limit);
      if (cacheKey) _cacheSet(cacheKey, result);
      return result;
    });
  }

  function getEvents(limit) {
    var cacheKey = limit ? null : CACHE_CFG.events;
    var cached   = cacheKey ? _cacheGet(cacheKey) : null;
    if (cached) return Promise.resolve(cached);

    return ghGet('events').then(function (rows) {
      var result = rows
        .filter(function (r) { return !r.is_archived; })
        .sort(function (a, b) { return (a.date_start || '').localeCompare(b.date_start || ''); })
        .map(function (r) {
          return {
            id:               r.id               || '',
            title:            r.title            || '',
            date_start:       r.date_start       || '',
            date_end:         r.date_end         || '',
            location:         r.location         || '',
            country:          r.country          || '',
            url:              r.url              || '#',
            synopsis:         r.synopsis         || '',
            description:      r.description      || '',
            type:             r.type             || 'Conference',
            logo_url:         r.logo_url         || '',
            sponsor:          r.sponsor          || '',
            sponsor_url:      r.sponsor_url      || '',
            organiser:        r.organiser        || '',
            sponsors:         Array.isArray(r.sponsors)     ? r.sponsors     : [],
            early_bird_date:  r.early_bird_date  || '',
            early_bird_price: r.early_bird_price || '',
            ticket_types:     Array.isArray(r.ticket_types) ? r.ticket_types : [],
            tags:             Array.isArray(r.tags)          ? r.tags         : [],
            departments:      Array.isArray(r.departments)   ? r.departments  :
                              (Array.isArray(r.tags)         ? r.tags         : []),
            is_featured:      !!r.is_featured,
            is_new:           !!r.is_new,
            is_archived:      !!r.is_archived,
            show_in_gallery:  !!r.show_in_gallery
          };
        });

      if (limit) result = result.slice(0, limit);
      if (cacheKey) _cacheSet(cacheKey, result);
      return result;
    });
  }

  function getJobs(limit) {
    var cacheKey = limit ? null : CACHE_CFG.jobs;
    var cached   = cacheKey ? _cacheGet(cacheKey) : null;
    if (cached) return Promise.resolve(cached);

    return ghGet('jobs').then(function (rows) {
      var result = rows
        .sort(function (a, b) {
          return (b.posted_date || '').localeCompare(a.posted_date || '');
        })
        .map(function (r) {
          return {
            id:                r.id                || '',
            title:             r.title             || '',
            org:               r.org               || '',
            location:          r.location          || '',
            salary:            r.salary            || '',
            url:               r.url               || '#',
            sport:             r.sport             || '',
            synopsis:          r.synopsis          || '',
            description:       r.description       || '',
            type:              r.type              || 'Full-Time',
            posted_date:       r.posted_date       || '',
            dept:              r.dept              || '',
            departments:       Array.isArray(r.departments) ? r.departments  :
                               (r.dept ? [r.dept] : []),
            categories:        Array.isArray(r.categories)  ? r.categories   : [],
            closing_date:      r.closing_date      || '',
            logo_url:          r.logo_url          || '',
            reports_to:        r.reports_to        || '',
            contract_length:   r.contract_length   || '',
            responsibilities:  r.responsibilities  || '',
            requirements_min:  r.requirements_min  || '',
            requirements_pref: r.requirements_pref || '',
            benefits:          r.benefits          || '',
            about_org:         r.about_org         || '',
            is_featured:       !!r.is_featured,
            is_new:            !!r.is_new,
            is_archived:       !!r.is_archived,
            show_in_gallery:   !!r.show_in_gallery
          };
        })
        .filter(function (j) { return j.title; });

      if (limit) result = result.slice(0, limit);
      if (cacheKey) _cacheSet(cacheKey, result);
      return result;
    });
  }

  function getTickerFeed() {
    return Promise.all([getNews(8), getEvents(5), getJobs(5), getVendors()])
      .then(function (results) {
        var news   = results[0];
        var events = results[1];
        var jobs   = results[2];
        var featuredVendors = (results[3] || [])
          .filter(function (v) { return v.is_featured; }).slice(0, 4);
        var ni = 0, ei = 0, ji = 0, vi = 0, out = [];
        while (ni < news.length || ei < events.length ||
               ji < jobs.length || vi < featuredVendors.length) {
          if (ni < news.length) {
            out.push({ type: 'news', color: '#3ecf8e',
              text: news[ni].headline, url: news[ni].url });
            ni++;
          }
          if (ei < events.length) {
            out.push({ type: 'event', color: '#7c6af7',
              text: events[ei].title +
                (events[ei].location
                  ? ' · ' + events[ei].location.split(',').pop().trim() : '') +
                (events[ei].date_start
                  ? ' · ' + events[ei].date_start.slice(0, 7) : ''),
              url: events[ei].url });
            ei++;
          }
          if (ji < jobs.length) {
            out.push({ type: 'jobs', color: '#f4622a',
              text: jobs[ji].title + (jobs[ji].org ? ' · ' + jobs[ji].org : ''),
              url: jobs[ji].url || 'careers.html' });
            ji++;
          }
          if (vi < featuredVendors.length) {
            out.push({ type: 'vendor', color: '#e8c547',
              text: '★ ' + featuredVendors[vi].name +
                (featuredVendors[vi].tech
                  ? ' · ' + featuredVendors[vi].tech.slice(0, 40) : ''),
              url: featuredVendors[vi].website || 'vendors.html' });
            vi++;
          }
        }
        return out;
      });
  }

  /* ══════════════════════════════════════════════════════════════════
     CLUBS & PRACTITIONERS
  ══════════════════════════════════════════════════════════════════ */

  function getClubs(limit) {
    var cacheKey = limit ? null : CACHE_CFG.clubs;
    var cached   = cacheKey ? _cacheGet(cacheKey) : null;
    if (cached) return Promise.resolve(cached);

    return ghGet('clubs').then(function (rows) {
      var result = rows.sort(function (a, b) {
        return (a.name || '').localeCompare(b.name || '');
      });
      if (limit) result = result.slice(0, limit);
      if (cacheKey) _cacheSet(cacheKey, result);
      return result;
    });
  }

  function saveClub(c) {
    _cacheBust(CACHE_CFG.clubs);
    var body = {
      name:         c.name,
      sport:        c.sport         || null,
      league:       c.league        || null,
      country:      c.country       || null,
      tier:         c.tier          || null,
      bio:          c.bio           || null,
      synopsis:     c.synopsis      || null,
      logo_url:     c.logo_url      || null,
      founded:      c.founded       || null,
      stadium:      c.stadium       || null,
      capacity:     c.capacity      || null,
      manager:      c.manager       || null,
      chairman:     c.chairman      || null,
      website:      c.website       || null,
      wiki_url:     c.wiki_url      || null,
      wiki_extract: c.wiki_extract  || null,
      extra_info:   c.extra_info    || null,
      vendor_stack: c.vendor_stack  || null,
      sportsdb_id:  c.sportsdb_id   || null,
      is_featured:  !!(c.is_featured),
      is_archived:  !!(c.is_archived)
    };
    if (c.id) body.id = c.id;
    return dbSave('clubs', body);
  }

  function getClubPeople(clubId) {
    return ghGet('club_people').then(function (rows) {
      return rows
        .filter(function (r) { return r.club_id === clubId; })
        .sort(function (a, b) {
          var dc = (a.discipline || '').localeCompare(b.discipline || '');
          return dc !== 0 ? dc : (a.name || '').localeCompare(b.name || '');
        });
    });
  }

  function getPeople(limit) {
    return Promise.all([ghGet('club_people'), ghGet('clubs')]).then(function (results) {
      var people  = results[0];
      var clubs   = results[1];
      var clubMap = {};
      clubs.forEach(function (c) {
        clubMap[c.id] = { id: c.id, name: c.name, country: c.country };
      });
      var result = people
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
        .map(function (p) {
          return Object.assign({}, p, {
            clubs: p.club_id ? (clubMap[p.club_id] || null) : null
          });
        });
      if (limit) result = result.slice(0, limit);
      return result;
    });
  }

  function savePerson(p) {
    _cacheBust(CACHE_CFG.clubs);
    var body = {
      club_id:        p.club_id        || null,
      name:           p.name,
      role:           p.role           || null,
      discipline:     p.discipline     || 'Other',
      sub_discipline: p.sub_discipline || null,
      bio:            p.bio            || null,
      linkedin:       p.linkedin       || null,
      avatar_url:     p.avatar_url     || null,
      email:          p.email          || null,
      phone:          p.phone          || null,
      nationality:    p.nationality    || null,
      profile_url:    p.profile_url    || null,
      is_featured:    !!(p.is_featured),
      team_group:     p.team_group     || null,
      role_category:  p.role_category  || null,
      tm_table:       p.tm_table       || null
    };
    if (p.id) body.id = p.id;
    return dbSave('club_people', body);
  }

  function getPractitioners(limit) {
    var cacheKey = limit ? null : CACHE_CFG.practitioners;
    var cached   = cacheKey ? _cacheGet(cacheKey) : null;
    if (cached) return Promise.resolve(cached);

    return ghGet('practitioners').then(function (rows) {
      var result = rows.sort(function (a, b) {
        return (a.name || '').localeCompare(b.name || '');
      });
      if (limit) result = result.slice(0, limit);
      if (cacheKey) _cacheSet(cacheKey, result);
      return result;
    });
  }

  function savePractitioner(p) {
    _cacheBust(CACHE_CFG.practitioners);
    var body = {
      name:           p.name,
      role:           p.role           || null,
      organisation:   p.organisation   || null,
      discipline:     p.discipline     || 'Other',
      sub_discipline: p.sub_discipline || null,
      bio:            p.bio            || null,
      linkedin:       p.linkedin       || null,
      avatar_url:     p.avatar_url     || null,
      email:          p.email          || null,
      phone:          p.phone          || null,
      nationality:    p.nationality    || null,
      is_featured:    !!(p.is_featured)
    };
    if (p.id) body.id = p.id;
    return dbSave('practitioners', body);
  }

  /* ── club_vendors junction ───────────────────────────────────────── */

  function getClubVendors(clubId) {
    return Promise.all([ghGet('club_vendors'), ghGet('vendors')]).then(function (results) {
      var cv        = results[0].filter(function (r) { return r.club_id === clubId; });
      var vendorMap = {};
      results[1].forEach(function (v) { vendorMap[v.id] = v; });
      return cv.map(function (r) {
        var v = vendorMap[r.vendor_id];
        return Object.assign({}, r, {
          vendors: v ? {
            id:         r.vendor_id,
            name:       v.name,
            website:    v.website,
            logo_url:   v.logo_url || v.logo || '',
            categories: v.categories,
            tech:       v.tech,
            synopsis:   v.synopsis
          } : null
        });
      });
    });
  }

  function saveClubVendor(clubId, vendorId, notes) {
    return ghGet('club_vendors').then(function (rows) {
      var existing = null;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].club_id === clubId && rows[i].vendor_id === vendorId) {
          existing = rows[i];
          break;
        }
      }
      var body = Object.assign(
        existing || {},
        { club_id: clubId, vendor_id: vendorId, notes: notes || null }
      );
      return dbSave('club_vendors', body);
    });
  }

  function deleteClubVendor(clubId, vendorId) {
    return Promise.all([ghGet('club_vendors'), _ghGetSha('club_vendors')])
      .then(function (results) {
        var filtered = results[0].filter(function (r) {
          return !(r.club_id === clubId && r.vendor_id === vendorId);
        });
        return _ghWrite('club_vendors', filtered, results[1])
          .then(function (res) { return !!res; });
      });
  }

  /* ══════════════════════════════════════════════════════════════════
     ADMIN WRITES  — each save busts the relevant cache
  ══════════════════════════════════════════════════════════════════ */

  function saveVendor(v) {
    _cacheBust(CACHE_CFG.vendors);
    var body = {
      name:       v.name,
      website:    v.website  || null,
      tech:       v.tech     || null,
      sport:      v.sport    || 'MultiSports',
      categories: v.categories || [],
      is_active:  v.is_active !== false
    };
    if (v.id) body.id = v.id;
    ['type','portfolio','logo_url','logo_data','synopsis','synopsis_long','ecosystem',
     'strengths','challenges','opportunities','threats','background','key_clients',
     'tags','social','key_personnel','scores','swot','is_featured','is_new',
     'is_archived','show_in_gallery']
      .forEach(function (k) { if (v[k] !== undefined) body[k] = v[k]; });
    return dbSave('vendors', body);
  }

  function saveNews(a) {
    _cacheBust(CACHE_CFG.news);
    var body = {
      headline:        a.headline,
      summary:         a.summary     || null,
      source:          a.source      || null,
      date:            a.date        || new Date().toISOString().slice(0, 10),
      url:             a.url         || null,
      image_url:       a.image_url   || null,
      tags:            a.tags        || [],
      departments:     a.departments || [],
      vendors:         a.vendors     || [],
      featured:        !!(a.featured),
      is_new:          !!(a.is_new),
      is_archived:     !!(a.is_archived),
      show_in_gallery: !!(a.show_in_gallery)
    };
    if (a.id) body.id = a.id;
    return dbSave('news', body);
  }

  function saveEvent(ev) {
    _cacheBust(CACHE_CFG.events);
    var body = {
      title:            ev.title,
      type:             ev.type             || 'Conference',
      url:              ev.url              || null,
      date_start:       ev.date_start       || null,
      date_end:         ev.date_end         || null,
      location:         ev.location         || null,
      country:          ev.country          || null,
      description:      ev.description      || null,
      synopsis:         ev.synopsis         || null,
      sponsor:          ev.sponsor          || null,
      sponsor_url:      ev.sponsor_url      || null,
      organiser:        ev.organiser        || null,
      sponsors:         ev.sponsors         || [],
      early_bird_date:  ev.early_bird_date  || null,
      early_bird_price: ev.early_bird_price || null,
      ticket_types:     ev.ticket_types     || [],
      tags:             ev.tags             || [],
      departments:      ev.departments      || [],
      logo_url:         ev.logo_url         || null,
      is_featured:      !!(ev.is_featured),
      is_new:           !!(ev.is_new),
      is_archived:      !!(ev.is_archived),
      show_in_gallery:  !!(ev.show_in_gallery)
    };
    if (ev.id) body.id = ev.id;
    return dbSave('events', body);
  }

  function saveJob(j) {
    _cacheBust(CACHE_CFG.jobs);
    var body = {
      title:           j.title,
      org:             j.org          || null,
      location:        j.location     || null,
      salary:          j.salary       || 'No Salary Disclosed',
      type:            j.type         || 'Full-Time',
      url:             j.url          || null,
      synopsis:        j.synopsis     || null,
      description:     j.description  || null,
      departments:     j.departments  || [],
      categories:      j.categories   || [],
      posted_date:     j.posted_date  || new Date().toISOString(),
      is_featured:     !!(j.is_featured),
      is_new:          !!(j.is_new),
      is_archived:     !!(j.is_archived),
      show_in_gallery: !!(j.show_in_gallery)
    };
    if (j.id) body.id = j.id;
    ['dept','closing_date','reports_to','responsibilities','requirements_min',
     'requirements_pref','contract_length','benefits','about_org','logo_url']
      .forEach(function (k) { if (j[k] !== undefined) body[k] = j[k]; });
    return dbSave('jobs', body);
  }

  function deleteRecord(table, id) {
    if (table === 'vendors')       _cacheBust(CACHE_CFG.vendors);
    if (table === 'news')          _cacheBust(CACHE_CFG.news);
    if (table === 'events')        _cacheBust(CACHE_CFG.events);
    if (table === 'jobs')          _cacheBust(CACHE_CFG.jobs);
    if (table === 'clubs')         _cacheBust(CACHE_CFG.clubs);
    if (table === 'practitioners') _cacheBust(CACHE_CFG.practitioners);
    return dbDelete(table, id);
  }

  /* ══════════════════════════════════════════════════════════════════
     PUBLIC API  — identical surface to v3 (Supabase edition)
     No HTML page changes required.
  ══════════════════════════════════════════════════════════════════ */
  return {
    // Public data reads
    getVendors:    getVendors,
    getNews:       getNews,
    getEvents:     getEvents,
    getJobs:       getJobs,
    getTickerFeed: getTickerFeed,

    // Compatibility shims for any direct dbGetPublic / dbSavePublic callers
    dbGetPublic:   function (table)        { return ghGet(table); },
    dbSavePublic:  function (table, body)  { return dbSave(table, body); },
    dbPatchPublic: function (table, id, b) { return dbPatch(table, id, b); },

    // User data
    KEYS:              KEYS,
    loadUserData:      loadUserData,
    initUserCache:     initUserCache,
    clearUserData:     clearUserData,
    getEco:            getEco,
    saveEco:           saveEco,
    ecoToggle:         ecoToggle,
    ecoHas:            ecoHas,
    getUserEcosystem:  getUserEcosystem,
    saveUserEcosystem: saveUserEcosystem,

    getSavedEvents:    getSavedEvents,
    toggleSavedEvent:  toggleSavedEvent,
    isEventSaved:      isEventSaved,

    getSavedJobs:      getSavedJobs,
    toggleSavedJob:    toggleSavedJob,
    isJobSaved:        isJobSaved,

    // Clubs & People
    getClubs:          getClubs,
    saveClub:          saveClub,
    getClubPeople:     getClubPeople,
    getPeople:         getPeople,
    savePerson:        savePerson,
    getPractitioners:  getPractitioners,
    savePractitioner:  savePractitioner,
    getClubVendors:    getClubVendors,
    saveClubVendor:    saveClubVendor,
    deleteClubVendor:  deleteClubVendor,

    // Admin writes
    saveVendor:   saveVendor,
    saveNews:     saveNews,
    saveEvent:    saveEvent,
    saveJob:      saveJob,
    deleteRecord: deleteRecord,
    patchVendor:  function (id, fields) { return dbPatch('vendors', id, fields); },

    // Auth
    adminLogin:   adminLogin,
    getSession:   getSession,
    setSession:   setSession,
    clearSession: clearSession,
    isAdmin:      isAdmin,

    // Cache utilities
    bustAllCaches: bustAllCaches
  };
})();

window.TPE = TPE;
