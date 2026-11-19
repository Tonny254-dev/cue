/* ============================================================
   AQUAPULSE — main.js (corrected for MAWASCO Django backend)
   ------------------------------------------------------------
   - JWT auth via window.Auth (js/auth.js)
   - Auto-redirect to login when no token
   - API client unwraps {success, message, data}
   - 401 → refresh → retry once → else redirect to login
   - WebSocket connects to /ws/stream/?token=<jwt>
     and subscribes to a named channel group
   - All 12 page controllers registered:
       dashboard, live-monitoring, analytics, notifications,
       user-management, activity-logs, settings, profile,
       devices, leak-detection, valve-control
   ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     0. AUTH GATE — redirect before doing anything else
     ============================================================ */
  var IS_LOGIN_PAGE = /(^|\/)login\.html?$/i.test(location.pathname);
  var HAS_TOKEN = !!localStorage.getItem('ap_access');

  if (!IS_LOGIN_PAGE && !HAS_TOKEN) {
    var _depth = (location.pathname.match(/\//g) || []).length;
    location.replace(_depth > 1 ? '../login.html' : 'login.html');
    return;
  }

  /* ============================================================
     1. CONFIG
     ============================================================ */
  var CONFIG = {
    API_BASE: 'http://localhost:8000/api/v1',
    WS_BASE:  (location.protocol === 'https:' ? 'wss://' : 'ws://') +
              (location.hostname || 'localhost') + ':8000/ws/stream/',
    THEME_KEY: 'ap_theme',
    REQUEST_TIMEOUT: 15000,
  };

  /* ============================================================
     2. THEME STORE
     ============================================================ */
  var ThemeStore = {
    get: function () { try { return localStorage.getItem(CONFIG.THEME_KEY) || 'light'; } catch (e) { return 'light'; } },
    set: function (v) { try { localStorage.setItem(CONFIG.THEME_KEY, v); } catch (e) {} },
  };

  /* ============================================================
     3. FORMAT HELPERS
     ============================================================ */
  var fmt = {
    num: function (v, d) {
      if (v == null || isNaN(v)) return '—';
      return Number(v).toFixed(d == null ? 1 : d);
    },
    int: function (v) {
      if (v == null || isNaN(v)) return '—';
      return Number(v).toLocaleString();
    },
    date: function (iso) { return iso ? new Date(iso).toLocaleDateString() : '—'; },
    datetime: function (iso) { return iso ? new Date(iso).toLocaleString() : '—'; },
    timeAgo: function (iso) {
      if (!iso) return '—';
      var s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 0) return 'now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    },
    initials: function (name) {
      if (!name) return '—';
      return String(name).trim().split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase();
    },
  };

  /* ============================================================
     4. DOM HELPERS
     ============================================================ */
  function el(id) { return document.getElementById(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = (v == null ? '—' : v); }
  function setHtml(id, v) { var e = el(id); if (e) e.innerHTML = v; }
  function setBadge(id, text, variant) {
    var e = el(id); if (!e) return;
    e.className = 'status-badge ' + (variant || 'secondary');
    e.textContent = (text == null ? '—' : text);
  }
  function setError(id, msg) {
    setHtml(id, '<div class="text-center text-danger small py-4">' + escapeHtml(msg || 'Failed to load') + '</div>');
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toArray(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    return x.results || x.items || x.data || x.devices ||
           x.notifications || x.sensors || x.events || [];
  }
  function pagedCount(x) {
    if (!x) return 0;
    if (x.pagination && x.pagination.count != null) return x.pagination.count;
    if (x.count != null) return x.count;
    return toArray(x).length;
  }
  function pageNumber(x) {
    if (x && x.pagination && x.pagination.page != null) return x.pagination.page;
    return 1;
  }
  function pageSize(x) {
    if (x && x.pagination && x.pagination.page_size != null) return x.pagination.page_size;
    return 20;
  }

  /* ============================================================
     5. TOASTS
     ============================================================ */
  var toast = {
    _container: function () {
      var c = el('ap-toast-container');
      if (!c) {
        c = document.createElement('div');
        c.id = 'ap-toast-container';
        c.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:9999;display:flex;flex-direction:column;gap:.5rem;max-width:340px;';
        document.body.appendChild(c);
      }
      return c;
    },
    show: function (message, type, timeout) {
      var colors = { info: 'primary', success: 'success', warning: 'warning', error: 'danger' };
      var d = document.createElement('div');
      d.className = 'alert alert-' + (colors[type] || 'primary') + ' shadow mb-0 small';
      d.textContent = message;
      this._container().appendChild(d);
      setTimeout(function () { d.remove(); }, timeout || 4000);
    },
    success: function (m) { this.show(m, 'success'); },
    error:   function (m) { this.show(m, 'error', 6000); },
    warn:    function (m) { this.show(m, 'warning'); },
    info:    function (m) { this.show(m, 'info'); },
  };

  /* ============================================================
     6. API CLIENT (JWT + auto-refresh)
     ============================================================ */
  var Api = (function () {
    var TOKEN_KEY = 'ap_access';
    var REFRESH_KEY = 'ap_refresh';

    function buildUrl(path, query) {
      var base = CONFIG.API_BASE.replace(/\/$/, '');
      var url = base + path;
      if (query) {
        var qs = [];
        Object.keys(query).forEach(function (k) {
          var v = query[k];
          if (v !== undefined && v !== null && v !== '') {
            qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
          }
        });
        if (qs.length) url += (url.indexOf('?') === -1 ? '?' : '&') + qs.join('&');
      }
      return url;
    }

    function parseEnvelope(json) {
      if (json && typeof json === 'object' && 'success' in json) {
        if (json.success === false) {
          var err = new Error(json.message || 'Request failed');
          err.errors = json.errors || {};
          throw err;
        }
        return json.data;
      }
      return json;
    }

    function refreshToken() {
      var r = localStorage.getItem(REFRESH_KEY);
      if (!r) return Promise.reject(new Error('No refresh token'));
      return fetch(CONFIG.API_BASE + '/auth/token/refresh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh: r }),
      }).then(function (res) {
        return res.json().then(function (j) {
          if (!res.ok || !j.access) throw new Error('Session expired');
          localStorage.setItem(TOKEN_KEY, j.access);
          if (j.refresh) localStorage.setItem(REFRESH_KEY, j.refresh);
          return j.access;
        });
      });
    }

    function forceLogout() {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      var depth = (location.pathname.match(/\//g) || []).length;
      location.replace(depth > 1 ? '../login.html' : 'login.html');
    }

    function doRequest(method, path, opts, isRetry) {
      opts = opts || {};
      var url = buildUrl(path, opts.query);
      var headers = { 'Content-Type': 'application/json' };
      var token = localStorage.getItem(TOKEN_KEY);
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, CONFIG.REQUEST_TIMEOUT);

      return fetch(url, {
        method: method,
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      }).then(function (res) {
        clearTimeout(timer);
        if (res.status === 401 && !isRetry) {
          return refreshToken()
            .then(function () { return doRequest(method, path, opts, true); })
            .catch(function () { forceLogout(); throw new Error('Session expired'); });
        }
        return res.text().then(function (text) {
          var json = {};
          try { json = text ? JSON.parse(text) : {}; } catch (e) {}
          if (!res.ok) {
            var err = new Error((json && json.message) || ('HTTP ' + res.status));
            err.status = res.status;
            err.errors = (json && json.errors) || {};
            throw err;
          }
          return parseEnvelope(json);
        });
      }, function (e) {
        clearTimeout(timer);
        throw e;
      });
    }

    return {
      get:   function (p, o) { return doRequest('GET', p, o); },
      post:  function (p, b, o) { o = o || {}; o.body = b; return doRequest('POST', p, o); },
      patch: function (p, b, o) { o = o || {}; o.body = b; return doRequest('PATCH', p, o); },
      del:   function (p, o) { return doRequest('DELETE', p, o); },
    };
  })();

  /* ============================================================
     7. WS CLIENT — /ws/stream/?token=<jwt> + subscribe group
     ============================================================ */
  function WSClient(group, options) {
    options = options || {};
    this.group = group;
    this.onMessage = options.onMessage || function () {};
    this.onStatus  = options.onStatus  || function () {};
    this.reconnect = options.reconnect !== false;
    this.attempts  = 0;
    this.maxDelay  = 30000;
    this.closedByUser = false;
    this.connect();
  }
  WSClient.prototype.connect = function () {
    var self = this;
    var token = localStorage.getItem('ap_access') || '';
    var url = CONFIG.WS_BASE + '?token=' + encodeURIComponent(token);
    try { this.ws = new WebSocket(url); }
    catch (e) { self.onStatus('ERROR'); return; }

    this.ws.onopen = function () {
      self.attempts = 0;
      self.onStatus('OPEN');
      try { self.ws.send(JSON.stringify({ action: 'subscribe', group: self.group })); } catch (e) {}
    };
    this.ws.onmessage = function (e) {
      var data; try { data = JSON.parse(e.data); } catch (_) { return; }
      if (data.event) self.onMessage({ type: data.event, data: data.payload || {} });
      else self.onMessage(data);
    };
    this.ws.onclose = function () {
      self.onStatus('CLOSED');
      if (self.reconnect && !self.closedByUser) self.schedule();
    };
    this.ws.onerror = function () { try { self.ws.close(); } catch (_) {} };
  };
  WSClient.prototype.schedule = function () {
    var self = this;
    var delay = Math.min(1000 * Math.pow(2, this.attempts++), this.maxDelay);
    setTimeout(function () { self.connect(); }, delay);
  };
  WSClient.prototype.close = function () {
    this.closedByUser = true;
    try { this.ws && this.ws.close(); } catch (_) {}
  };

  /* ============================================================
     8. SHELL — theme, sidebar, logout, topbar
     ============================================================ */
  function currentPage() {
    return document.body.getAttribute('data-page')
        || (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var icon = el('themeIcon');
    if (icon) icon.className = theme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-fill';
  }
  function initTheme() { applyTheme(ThemeStore.get()); }

  function initShell() {
    var toggle = el('themeToggle');
    if (toggle) toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      ThemeStore.set(next);
      window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: next } }));
    });

    var sidebar  = el('ap-sidebar');
    var backdrop = el('ap-backdrop');
    var sToggle  = el('sidebarToggle');
    if (sToggle && sidebar) {
      sToggle.addEventListener('click', function () {
        if (window.innerWidth < 992) {
          sidebar.classList.toggle('show');
          if (backdrop) backdrop.classList.toggle('show');
        } else {
          var app = el('ap-app');
          if (app) app.classList.toggle('collapsed');
        }
      });
    }
    if (backdrop && sidebar) {
      backdrop.addEventListener('click', function () {
        sidebar.classList.remove('show');
        backdrop.classList.remove('show');
      });
    }

    ['logoutBtn', 'logoutDropdown'].forEach(function (id) {
      var node = el(id);
      if (node) node.addEventListener('click', function (e) {
        e.preventDefault();
        if (window.Auth) window.Auth.logout();
        else {
          localStorage.removeItem('ap_access');
          localStorage.removeItem('ap_refresh');
          location.replace('../login.html');
        }
      });
    });

    // Topbar identity from /auth/me/
    if (localStorage.getItem('ap_access')) {
      Api.get('/auth/me/').then(function (u) {
        var name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username || '—';
        setText('topbarUserName', name);
        var av = el('topbarAvatar');
        if (av) av.textContent = fmt.initials(name);
      }).catch(function () {});
    }
  }

  /* ============================================================
     9. ROUTER
     ============================================================ */
  var PAGES = {};
  function register(page, initFn) { PAGES[page] = initFn; }

  /* ============================================================
     10. SHARED BADGE
     ============================================================ */
  function statusBadge(status) {
    var s = (status || '').toUpperCase();
    var v = 'secondary';
    if (['SUCCESS','ONLINE','CONNECTED','RESOLVED','HEALTHY','OK','NORMAL','ACTIVE','EXECUTED','CONFIRMED','OPEN'].indexOf(s) >= 0) v = 'success';
    else if (['WARNING','DEGRADED','PENDING','SUSPECTED','RECEIVED','UNDER_INVESTIGATION'].indexOf(s) >= 0) v = 'warning';
    else if (['FAILED','CRITICAL','OFFLINE','DISCONNECTED','ERROR','EXPIRED','CLOSED'].indexOf(s) >= 0) v = 'danger';
    return '<span class="status-badge ' + v + '">' + escapeHtml(s || '—') + '</span>';
  }

  /* ============================================================
     11. PAGE: dashboard
     ============================================================ */
  register('dashboard', function () {
    var flowChart = null, usageChart = null, ws = null, pollTimer = null;

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadOverview() {
      Api.get('/dashboard/overview/').then(function (d) {
        // {current_water_flow:{value,unit}, todays_consumption:{value,unit},
        //  system_health:"HEALTHY", active_alerts:<n>, unread_notifications:<n>,
        //  devices:{total,connected}}
        var flow = d.current_water_flow || {};
        setText('kpiFlow', fmt.num(flow.value));
        setText('kpiFlowUnit', flow.unit || 'L/min');
        setText('kpiFlowNote', 'Live reading');

        var cons = d.todays_consumption || {};
        setText('kpiConsumption', fmt.num(cons.value));
        setText('kpiConsumptionUnit', cons.unit || 'L');
        setText('kpiConsumptionNote', 'Since midnight');

        var health = (d.system_health || 'UNKNOWN').toString().toUpperCase();
        var hv = health === 'HEALTHY' ? 'success' : health === 'DEGRADED' ? 'warning' : 'danger';
        setBadge('kpiHealthBadge', health, hv);
        var dev = d.devices || {};
        setText('kpiHealthNote', dev.total != null ? (dev.connected || 0) + '/' + dev.total + ' devices online' : '');

        var alerts = d.active_alerts != null ? d.active_alerts : 0;
        setText('kpiAlerts', alerts);
        setText('kpiAlertsNote', (d.unread_notifications || 0) + ' unread');

        setText('dashboardSubtitle',
          'System ' + health.toLowerCase() + ' · ' + alerts + ' active alert' + (alerts === 1 ? '' : 's'));
        setText('dashboardLastUpdated', 'Updated ' + new Date().toLocaleTimeString());
      }).catch(function (err) {
        console.error('[dashboard] overview failed:', err);
        toast.error('Failed to load dashboard overview');
      });
    }

    function renderFlowChart(rows) {
      rows = Array.isArray(rows) ? rows : (rows.data || rows.results || []);
      if (!rows.length) {
        setHtml('flowChart', '<div class="text-center text-muted small py-5">No data</div>');
        return;
      }
      var labels = rows.map(function (r) {
        return new Date(r.timestamp || r.reading_timestamp).toLocaleTimeString();
      });
      var values = rows.map(function (r) { return Number(r.flow_rate) || 0; });
      var c = themeColors();
      setText('flowTrendRange', rows.length + ' readings');

      var options = {
        chart: { type: 'area', height: 320, toolbar: { show: false }, animations: { speed: 400 } },
        series: [{ name: 'Flow', data: values }],
        xaxis: { categories: labels, labels: { style: { colors: c.text } } },
        yaxis: { title: { text: 'L/min' }, labels: { style: { colors: c.text } } },
        stroke: { curve: 'smooth', width: 2 },
        colors: ['#3b82f6'],
        dataLabels: { enabled: false },
        tooltip: { y: { formatter: function (v) { return v + ' L/min'; } } },
        grid: { borderColor: c.grid },
        theme: { mode: c.mode },
      };

      var target = el('flowChart');
      if (!target) return;
      if (flowChart) { flowChart.updateOptions(options); flowChart.updateSeries(options.series); }
      else { flowChart = new ApexCharts(target, options); flowChart.render(); }
    }

    function loadFlowTrend() {
      Api.get('/dashboard/flow-trend/').then(renderFlowChart)
        .catch(function (err) { console.error('[dashboard] flow-trend failed:', err); setError('flowChart', 'Could not load flow trend'); });
    }

    function renderUsage(rows) {
      rows = Array.isArray(rows) ? rows : (rows.data || rows.results || []);
      if (!rows.length) {
        setHtml('usageChart', '<div class="text-center text-muted small py-5">No data</div>');
        return;
      }
      var labels = rows.map(function (r) { return r.date || ''; });
      var series = rows.map(function (r) { return Number(r.consumption) || 0; });
      var c = themeColors();
      var options = {
        chart: { type: 'donut', height: 320 },
        series: series,
        labels: labels,
        colors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#f43f5e'],
        legend: { position: 'bottom', labels: { colors: c.text } },
        dataLabels: { enabled: true, formatter: function (v) { return Number(v).toFixed(0) + '%'; } },
        theme: { mode: c.mode },
      };
      var target = el('usageChart');
      if (!target) return;
      if (usageChart) usageChart.updateOptions(options);
      else { usageChart = new ApexCharts(target, options); usageChart.render(); }
    }

    function loadConsumption() {
      Api.get('/dashboard/consumption-overview/').then(renderUsage)
        .catch(function (err) { console.error('[dashboard] consumption failed:', err); setError('usageChart', 'Could not load consumption'); });
    }

    function loadActivity() {
      Api.get('/dashboard/recent-activity/').then(function (data) {
        var rows = toArray(data);
        var tbody = el('activityTableBody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No recent activity</td></tr>';
          return;
        }
        tbody.innerHTML = rows.slice(0, 5).map(function (r) {
          return '<tr>' +
            '<td>' + escapeHtml(r.action || r.description || r.category || '—') + '</td>' +
            '<td>' + escapeHtml(r.device_name || r.device || '—') + '</td>' +
            '<td>' + statusBadge(r.category || 'INFO') + '</td>' +
            '<td class="text-muted small">' + fmt.timeAgo(r.created_at || r.timestamp) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[dashboard] activity failed:', err); setError('activityTableBody', 'Could not load activity'); });
    }

    function loadConnectivity() {
      Api.get('/monitoring/connectivity/').then(function (data) {
        var rows = (data && data.devices) || toArray(data);
        var box = el('deviceConnectivityList');
        if (!box) return;
        if (!rows.length) { box.innerHTML = '<div class="p-4 text-center text-muted small">No devices</div>'; return; }
        box.innerHTML = rows.map(function (d) {
          return '<div class="d-flex align-items-center justify-content-between p-3 border-bottom" style="border-color:var(--border-color)!important;">' +
            '<div class="d-flex align-items-center gap-2">' +
              '<i class="bi bi-cpu text-primary"></i>' +
              '<div>' +
                '<div class="fw-semibold small">' + escapeHtml(d.device_name || d.device_identifier || '—') + '</div>' +
                '<div class="text-muted" style="font-size:.72rem;">' + fmt.timeAgo(d.last_communication) + '</div>' +
              '</div>' +
            '</div>' +
            statusBadge(d.connection_status) +
          '</div>';
        }).join('');
      }).catch(function (err) { console.error('[dashboard] connectivity failed:', err); setError('deviceConnectivityList', 'Could not load devices'); });
    }

    function connectWS() {
      ws = new WSClient('dashboard', {
        onMessage: function (evt) {
          var type = evt.type, data = evt.data || {};
          if (type === 'flow_reading_updated') {
            setText('kpiFlow', fmt.num(data.flow_rate));
            setText('kpiFlowNote', 'Live · ' + new Date().toLocaleTimeString());
          }
          if (type === 'new_notification') {
            var dot = el('topbarUnreadDot'); if (dot) dot.classList.remove('d-none');
          }
        },
      });
    }

    window.addEventListener('themeChanged', function () {
      if (flowChart) loadFlowTrend();
      if (usageChart) loadConsumption();
    });

    loadOverview();
    loadFlowTrend();
    loadConsumption();
    loadActivity();
    loadConnectivity();
    connectWS();

    pollTimer = setInterval(loadOverview, 30000);
    window.addEventListener('beforeunload', function () {
      if (pollTimer) clearInterval(pollTimer);
      if (ws) ws.close();
    });
  });

  /* ============================================================
     12. PAGE: live-monitoring
     ============================================================ */
  register('live-monitoring', function () {
    var liveChart = null, historyChart = null, ws = null, liveTimer = null;
    var liveSamples = [];
    var LIVE_MAX = 60, LIVE_MS = 2000;

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadLive() {
      Api.get('/monitoring/live/').then(function (d) {
        // {pipeline_id, current_flow_rate, consumption_today, unit?, sensors:[{sensor, position, last_reading:{...}}]}
        setText('lm-flow-rate', fmt.num(d.current_flow_rate));
        setText('lm-volume', fmt.num(d.consumption_today));
        setText('lm-volume-unit', d.unit || 'L');
        setText('lm-flow-updated', 'Updated ' + new Date().toLocaleTimeString());
        setText('lm-volume-updated', 'Since midnight');

        var sensors = d.sensors || [];
        var onlineCount = sensors.filter(function (s) { return s.last_reading; }).length;
        setBadge('lm-device-status', onlineCount > 0 ? 'ONLINE' : 'OFFLINE', onlineCount > 0 ? 'success' : 'danger');
        setText('lm-device-detail', sensors.length ? sensors.length + ' sensor(s)' : 'No sensors');

        var sensorStatus = !sensors.length ? 'UNKNOWN' : (onlineCount === sensors.length ? 'ONLINE' : 'DEGRADED');
        setBadge('lm-sensor-status', sensorStatus, sensorStatus === 'ONLINE' ? 'success' : sensorStatus === 'DEGRADED' ? 'warning' : 'secondary');
        setText('lm-sensor-detail', onlineCount + '/' + sensors.length + ' reporting');

        setText('lm-live-indicator', 'Live · ' + new Date().toLocaleTimeString());
        pushLivePoint(d.current_flow_rate);
        renderSensors(sensors);
      }).catch(function (err) { console.error('[live] live failed:', err); setText('lm-live-indicator', 'Live data unavailable'); });
    }

    function ensureLiveChart() {
      var target = el('liveFlowChart');
      if (!target || liveChart) return;
      var c = themeColors();
      liveChart = new ApexCharts(target, {
        chart: { type: 'line', height: 320, animations: { dynamicAnimation: { speed: 300 } }, toolbar: { show: false } },
        series: [{ name: 'Flow', data: [] }],
        stroke: { curve: 'smooth', width: 2 },
        colors: ['#3b82f6'],
        xaxis: { type: 'datetime', labels: { datetimeUTC: false, style: { colors: c.text } } },
        yaxis: { title: { text: 'L/min' }, min: 0, labels: { style: { colors: c.text } } },
        dataLabels: { enabled: false },
        tooltip: { x: { format: 'HH:mm:ss' } },
        grid: { strokeDashArray: 4, borderColor: c.grid },
        theme: { mode: c.mode },
        noData: { text: 'Waiting for readings…' },
      });
      liveChart.render();
    }

    function pushLivePoint(v) {
      if (v == null) return;
      ensureLiveChart();
      if (!liveChart) return;
      liveSamples.push({ x: Date.now(), y: Number(v) });
      if (liveSamples.length > LIVE_MAX) liveSamples.shift();
      liveChart.updateSeries([{ name: 'Flow', data: liveSamples.slice() }]);
    }

    function renderSensors(sensors) {
      var box = el('sensorReadingsList');
      if (!box) return;
      if (!sensors || !sensors.length) {
        box.innerHTML = '<div class="p-4 text-center text-muted small">No sensors reporting</div>';
        return;
      }
      box.innerHTML = sensors.map(function (s) {
        var last = s.last_reading || {};
        var online = !!s.last_reading;
        var variant = online ? 'success' : 'danger';
        return '<div class="d-flex align-items-center justify-content-between p-3 border-bottom" style="border-color:var(--border-color)!important;">' +
          '<div class="d-flex align-items-center gap-2">' +
            '<i class="bi bi-broadcast text-primary"></i>' +
            '<div>' +
              '<div class="fw-semibold small">' + escapeHtml(s.sensor || '—') + '</div>' +
              '<div class="text-muted" style="font-size:.72rem;">' + escapeHtml(s.position || '') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="text-end">' +
            '<div class="fw-semibold small">' + (last.flow_rate != null ? fmt.num(last.flow_rate) + ' L/min' : '—') + '</div>' +
            '<span class="status-badge ' + variant + '">' + (online ? 'ONLINE' : 'OFFLINE') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function loadHistory() {
      var interval = (el('historyRange') && el('historyRange').value) || 'minute';
      var now = new Date();
      var start = new Date(now);
      if (interval === 'minute') start.setHours(now.getHours() - 1);
      else if (interval === 'hour') start.setHours(now.getHours() - 24);
      else start.setDate(now.getDate() - 30);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

      // /monitoring/history/ takes start & end (ISO datetime strings)
      Api.get('/monitoring/history/', {
        query: {
          start: start.toISOString(),
          end: now.toISOString(),
          page_size: 500,
        },
      }).then(function (data) {
        var rows = toArray(data);
        // backend returns FlowReading objects: {flow_rate, volume, reading_timestamp}
        var labels = rows.map(function (r) { return new Date(r.reading_timestamp).toLocaleTimeString(); });
        var values = rows.map(function (r) { return Number(r.flow_rate) || 0; });
        var c = themeColors();
        var options = {
          chart: { type: 'area', height: 300, toolbar: { show: false } },
          series: [{ name: 'Flow', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          yaxis: { title: { text: 'L/min' }, labels: { style: { colors: c.text } } },
          stroke: { curve: 'smooth', width: 2 },
          colors: ['#22c55e'],
          dataLabels: { enabled: false },
          tooltip: { y: { formatter: function (v) { return v + ' L/min'; } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
          noData: { text: 'No data' },
        };
        var target = el('historyFlowChart');
        if (!target) return;
        if (historyChart) { historyChart.updateOptions(options); historyChart.updateSeries(options.series); }
        else { historyChart = new ApexCharts(target, options); historyChart.render(); }
      }).catch(function (err) { console.error('[live] history failed:', err); setError('historyFlowChart', 'Could not load historical flow'); });
    }

    function loadRecentReadings() {
      Api.get('/monitoring/history/', { query: { page_size: 10 } }).then(function (data) {
        var rows = toArray(data);
        var tbody = el('readingsTableBody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No readings yet</td></tr>';
          return;
        }
        rows = rows.slice(0, 10);
        tbody.innerHTML = rows.map(function (r) {
          return '<tr>' +
            '<td class="text-muted small">' + (r.reading_timestamp ? new Date(r.reading_timestamp).toLocaleTimeString() : '—') + '</td>' +
            '<td>' + (r.flow_rate != null ? fmt.num(r.flow_rate) + ' L/min' : '—') + '</td>' +
            '<td>' + (r.volume != null ? fmt.num(r.volume) + ' L' : '—') + '</td>' +
            '<td>' + statusBadge('OK') + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[live] readings failed:', err); setError('readingsTableBody', 'Could not load readings'); });
    }

    function connectWS() {
      ws = new WSClient('monitoring', {
        onMessage: function (evt) {
          var type = evt.type, data = evt.data || {};
          if (type === 'flow_reading_updated') {
            setText('lm-flow-rate', fmt.num(data.flow_rate));
            setText('lm-flow-updated', 'Live · ' + new Date().toLocaleTimeString());
            setText('lm-live-indicator', 'Live · ' + new Date().toLocaleTimeString());
            pushLivePoint(data.flow_rate);
          }
        },
        onStatus: function (s) {
          if (s === 'OPEN') setText('lm-live-indicator', 'Live · connected');
          if (s === 'CLOSED') setText('lm-live-indicator', 'Reconnecting…');
        },
      });
    }

    window.addEventListener('themeChanged', function () { loadHistory(); });

    var refresh = el('refreshBtn');
    if (refresh) refresh.addEventListener('click', function () { loadLive(); loadHistory(); loadRecentReadings(); });
    var range = el('historyRange');
    if (range) range.addEventListener('change', loadHistory);

    ensureLiveChart();
    loadLive();
    loadHistory();
    loadRecentReadings();
    connectWS();

    liveTimer = setInterval(loadLive, LIVE_MS);
    window.addEventListener('beforeunload', function () {
      if (liveTimer) clearInterval(liveTimer);
      if (ws) ws.close();
    });
  });

  /* ============================================================
     13. PAGE: analytics
     ============================================================ */
  register('analytics', function () {
    var trendChart = null, breakdownChart = null, leakChart = null;

    (function initDates() {
      var now = new Date(), start = new Date();
      start.setDate(now.getDate() - 30);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      var s = el('anStartDate'); if (s) s.value = ymd(start);
      var e = el('anEndDate');   if (e) e.value = ymd(now);
    })();

    function filters() {
      var s = el('anStartDate') && el('anStartDate').value;
      var e = el('anEndDate')   && el('anEndDate').value;
      return { start_date: s || undefined, end_date: e || undefined };
    }
    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadSummary() {
      Api.get('/analytics/summary/', { query: filters() }).then(function (d) {
        // backend: {total_consumption, average_daily_usage, leak_events, period:{start,end}}
        setText('an-total', fmt.num(d.total_consumption, 1));
        setText('an-unit', d.unit || 'L');
        setText('an-total-note', 'Across selected range');
        setText('an-avg', fmt.num(d.average_daily_usage, 1));
        setText('an-avg-note', 'Litres per day');
        setText('an-leaks', fmt.int(d.leak_events));
        setText('an-leaks-note', d.leak_events ? 'Review below' : 'No leak events');
      }).catch(function (err) { console.error('[analytics] summary failed:', err); toast.error('Failed to load summary'); });
    }

    function loadTrend() {
      Api.get('/analytics/consumption-trends/', { query: filters() }).then(function (rows) {
        // backend returns [{date, consumption}]
        rows = Array.isArray(rows) ? rows : toArray(rows);
        var labels = rows.map(function (r) { return r.date || ''; });
        var values = rows.map(function (r) { return Number(r.consumption) || 0; });
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 320, toolbar: { show: false } },
          series: [{ name: 'Consumption', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          yaxis: { title: { text: 'L' }, labels: { style: { colors: c.text } } },
          colors: ['#3b82f6'],
          plotOptions: { bar: { columnWidth: '55%', borderRadius: 4 } },
          dataLabels: { enabled: false },
          tooltip: { y: { formatter: function (v) { return v + ' L'; } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
        };
        var target = el('anTrendChart');
        if (target) {
          if (trendChart) { trendChart.updateOptions(options); trendChart.updateSeries(options.series); }
          else { trendChart = new ApexCharts(target, options); trendChart.render(); }
        }
        if (labels.length && values.length) {
          var maxIdx = 0;
          for (var i = 1; i < values.length; i++) if (values[i] > values[maxIdx]) maxIdx = i;
          setBadge('an-peak', String(labels[maxIdx]), 'info');
          setText('an-peak-note', fmt.num(values[maxIdx]) + ' L');
        }
      }).catch(function (err) { console.error('[analytics] trend failed:', err); setError('anTrendChart', 'Could not load consumption trend'); });
    }

    function loadBreakdown() {
      Api.get('/analytics/usage-breakdown/', { query: filters() }).then(function (rows) {
        // backend returns [{pipeline_id, pipeline, consumption}]
        rows = Array.isArray(rows) ? rows : toArray(rows);
        var labels = rows.map(function (r) { return r.pipeline || ('Pipeline ' + r.pipeline_id); });
        var series = rows.map(function (r) { return Number(r.consumption) || 0; });
        var c = themeColors();
        var options = {
          chart: { type: 'donut', height: 320 },
          series: series, labels: labels,
          colors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'],
          legend: { position: 'bottom', labels: { colors: c.text } },
          dataLabels: { enabled: true, formatter: function (v) { return Number(v).toFixed(0) + '%'; } },
          theme: { mode: c.mode },
        };
        var target = el('anBreakdownChart');
        if (target) {
          if (breakdownChart) breakdownChart.updateOptions(options);
          else { breakdownChart = new ApexCharts(target, options); breakdownChart.render(); }
        }
      }).catch(function (err) { console.error('[analytics] breakdown failed:', err); setError('anBreakdownChart', 'Could not load usage breakdown'); });
    }

    function loadLeakChartAndTable() {
      Api.get('/analytics/leak-events/', { query: filters() }).then(function (d) {
        // backend: {total, by_status:{}, by_severity:{}, events:[LeakEvent]}
        var events = (d && d.events) || [];
        // Chart: bucket by date
        var buckets = {};
        events.forEach(function (r) {
          var dt = (r.started_at || r.detected_at || r.created_at || '').slice(0, 10);
          if (dt) buckets[dt] = (buckets[dt] || 0) + 1;
        });
        var labels = Object.keys(buckets).sort();
        var values = labels.map(function (k) { return buckets[k]; });
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 280, toolbar: { show: false } },
          series: [{ name: 'Leak events', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          colors: ['#ef4444'],
          plotOptions: { bar: { columnWidth: '50%', borderRadius: 4 } },
          dataLabels: { enabled: false },
          yaxis: { title: { text: 'events' }, labels: { style: { colors: c.text } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
        };
        var target = el('anLeakChart');
        if (target) {
          if (leakChart) { leakChart.updateOptions(options); leakChart.updateSeries(options.series); }
          else { leakChart = new ApexCharts(target, options); leakChart.render(); }
        }
        // Table
        var tbody = el('anLeakTableBody');
        var countEl = el('anLeakCount');
        if (countEl) countEl.textContent = ((d && d.total) || events.length) + ' event(s)';
        if (!tbody) return;
        if (!events.length) {
          tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No leak events</td></tr>';
          return;
        }
        tbody.innerHTML = events.slice(0, 20).map(function (r) {
          var sev = (r.severity || 'MEDIUM').toUpperCase();
          return '<tr>' +
            '<td><code>#' + escapeHtml(r.id) + '</code></td>' +
            '<td class="text-muted small">' + fmt.datetime(r.started_at || r.created_at) + '</td>' +
            '<td>' + statusBadge(sev) + '</td>' +
            '<td>' + (r.flow_difference != null ? fmt.num(r.flow_difference) + ' L/min' : '—') + '</td>' +
            '<td>' + statusBadge(r.detection_status || 'SUSPECTED') + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) {
        console.error('[analytics] leak-events failed:', err);
        setError('anLeakChart', 'Could not load leak events');
        setError('anLeakTableBody', 'Could not load leak events');
      });
    }

    function refreshAll() { loadSummary(); loadTrend(); loadBreakdown(); loadLeakChartAndTable(); }

    window.addEventListener('themeChanged', refreshAll);
    var apply = el('anApplyBtn'); if (apply) apply.addEventListener('click', refreshAll);
    refreshAll();
  });

  /* ============================================================
     14. PAGE: notifications
     ============================================================ */
  register('notifications', function () {
    var state = { page: 1, pageSize: 20, search: '', severity: '', status: '', type: '', items: [], total: 0 };
    var ws = null, searchTimer = null;

    function loadList() {
      var listEl = el('notifList');
      if (listEl) listEl.innerHTML = '<div class="p-4 text-center text-muted small">Loading notifications…</div>';
      Api.get('/notifications/', {
        query: {
          page: state.page, page_size: state.pageSize,
          search: state.search || undefined,
          severity: state.severity || undefined,
          is_read: state.status === 'READ' ? true : state.status === 'UNREAD' ? false : undefined,
          notification_type: state.type || undefined,
        },
      }).then(function (data) {
        var rows = toArray(data);
        var total = pagedCount(data);
        state.items = rows; state.total = total;
        renderList(rows);
        renderPagination(total);
        updateSummary(rows, total);
      }).catch(function (err) { console.error('[notif] load failed:', err); setError('notifList', 'Could not load notifications'); });
    }

    function updateSummary(rows, total) {
      var unread = rows.filter(function (n) { return !n.is_read; }).length;
      setText('notifSummary', total + ' notification' + (total !== 1 ? 's' : '') + ' · ' + unread + ' unread');
      var dot = el('topbarUnreadDot');
      if (dot) { if (unread > 0) dot.classList.remove('d-none'); else dot.classList.add('d-none'); }
    }

    function severityIcon(sev) {
      var s = (sev || 'INFO').toUpperCase();
      if (s === 'CRITICAL') return { icon: 'bi-shield-exclamation', bg: 'bg-red-light text-red' };
      if (s === 'WARNING')  return { icon: 'bi-exclamation-triangle', bg: 'bg-orange-light text-orange' };
      return { icon: 'bi-info-circle', bg: 'bg-blue-light text-blue' };
    }

    function renderList(rows) {
      var listEl = el('notifList');
      if (!listEl) return;
      if (!rows.length) {
        listEl.innerHTML = '<div class="p-4 text-center text-muted small">No notifications</div>';
        return;
      }
      listEl.innerHTML = rows.map(function (n) {
        var isRead = !!n.is_read;
        var meta = severityIcon(n.severity);
        return '<div class="list-group-item p-4 border-bottom" style="border-color:var(--border-color)!important;' + (isRead ? 'opacity:0.7;' : '') + '">' +
          '<div class="d-flex gap-3">' +
            '<div class="kpi-icon ' + meta.bg + ' flex-shrink-0"><i class="bi ' + meta.icon + '"></i></div>' +
            '<div class="flex-grow-1">' +
              '<div class="d-flex justify-content-between align-items-start mb-1">' +
                '<h6 class="mb-0 fw-bold">' + escapeHtml(n.title || n.notification_type || '—') + '</h6>' +
                '<span class="text-muted small">' + fmt.timeAgo(n.created_at) + '</span>' +
              '</div>' +
              (n.message ? '<p class="text-muted mb-2 small">' + escapeHtml(n.message) + '</p>' : '') +
              (!isRead ? '<div><button class="btn btn-sm btn-outline-secondary" data-action="mark-read" data-id="' + escapeHtml(n.id) + '">Mark Read</button></div>' : '') +
            '</div>' +
            (isRead ? '' : '<div class="ms-2"><span class="badge bg-primary rounded-pill">New</span></div>') +
          '</div>' +
        '</div>';
      }).join('');

      listEl.querySelectorAll('[data-action="mark-read"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          Api.patch('/notifications/' + id + '/read/', {}).then(function () {
            toast.success('Marked as read'); loadList();
          }).catch(function (err) { toast.error(err.message || 'Could not mark as read'); });
        });
      });
    }

    function renderPagination(total) {
      var info = el('notifPageInfo'), pag = el('notifPagination');
      if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + ' to ' + to + ' of ' + total;

      var html = '<li class="page-item ' + (state.page === 1 ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page - 1) + '">Previous</a></li>';
      for (var p = 1; p <= pages; p++) {
        if (pages > 7 && Math.abs(p - state.page) > 2 && p !== 1 && p !== pages) {
          if (p === 2 || p === pages - 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
          continue;
        }
        html += '<li class="page-item ' + (p === state.page ? 'active' : '') + '"><a class="page-link" href="#" data-page="' + p + '">' + p + '</a></li>';
      }
      html += '<li class="page-item ' + (state.page === pages ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page + 1) + '">Next</a></li>';
      pag.innerHTML = html;

      pag.querySelectorAll('[data-page]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var p = Number(a.getAttribute('data-page'));
          if (!p || p === state.page || p < 1 || p > pages) return;
          state.page = p; loadList();
        });
      });
    }

    function markAllRead() {
      var btn = el('markAllReadBtn'); if (btn) btn.disabled = true;
      Api.post('/notifications/mark-all-read/', {}).then(function () {
        toast.success('All marked as read'); loadList();
      }).catch(function (err) { toast.error(err.message || 'Failed'); })
        .finally(function () { if (btn) btn.disabled = false; });
    }

    function connectWS() {
      ws = new WSClient('notifications', {
        onMessage: function (evt) {
          if (evt.type === 'new_notification') {
            toast.info((evt.data && evt.data.title) || 'New notification');
            if (state.page === 1) loadList();
          }
        },
      });
    }

    var search = el('notifSearch');
    if (search) search.addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.search = e.target.value.trim(); state.page = 1; loadList(); }, 350);
    });
    [
      ['notifSeverityFilter', 'severity'],
      ['notifStatusFilter',   'status'],
      ['notifCategoryFilter', 'type'],
    ].forEach(function (pair) {
      var node = el(pair[0]);
      if (node) node.addEventListener('change', function (e) { state[pair[1]] = e.target.value; state.page = 1; loadList(); });
    });
    var mAll = el('markAllReadBtn'); if (mAll) mAll.addEventListener('click', markAllRead);

    loadList();
    connectWS();
  });

  /* ============================================================
     15. PAGE: user-management
     Backend has NO /auth/users/ endpoint. Show informational message.
     If you add the endpoint later, swap ENDPOINT below.
     ============================================================ */
  register('user-management', function () {
    // Backend doesn't expose user CRUD. Offer a read-only view via activity-logs
    // (unique actors from logs) and instruct the operator to use /admin/ for CRUD.
    var tbody = el('umTableBody');
    var pageInfo = el('umPageInfo');
    if (pageInfo) pageInfo.textContent = 'Backend does not expose user CRUD — use Django admin at /admin/';

    var addBtn = el('addUserBtn');
    if (addBtn) {
      addBtn.disabled = true;
      addBtn.title = 'Managed via Django admin (/admin/)';
    }

    if (tbody) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="text-center text-muted py-4">' +
          'User management is handled via the <a href="http://localhost:8000/admin/accounts/user/" target="_blank">Django admin</a>.' +
        '</td></tr>';
    }
    ['umTotal','umActive','umAdmins','umInactive'].forEach(function (id) { setText(id, '—'); });
  });

  /* ============================================================
     16. PAGE: activity-logs
     ============================================================ */
  register('activity-logs', function () {
    var state = { page: 1, pageSize: 20, startDate: '', endDate: '', category: '', userId: '', rows: [], total: 0 };

    (function initDates() {
      var now = new Date(), start = new Date();
      start.setDate(now.getDate() - 7);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      var s = el('alStartDate'); if (s) s.value = ymd(start);
      var e = el('alEndDate');   if (e) e.value = ymd(now);
      state.startDate = ymd(start); state.endDate = ymd(now);
    })();

    function loadUsersForFilter() {
      // Backend has no user list endpoint; populate from /activity-logs/users/
      // which returns activity rows, then dedupe by user/username.
      Api.get('/activity-logs/users/', { query: { page_size: 200 } }).then(function (data) {
        var rows = toArray(data);
        var seen = {};
        var sel = el('alUserFilter'); if (!sel) return;
        rows.forEach(function (r) {
          var uid = r.user;
          var name = r.username || r.user_name || ('User #' + uid);
          if (!uid || seen[uid]) return;
          seen[uid] = true;
          var opt = document.createElement('option');
          opt.value = String(uid);
          opt.textContent = name;
          sel.appendChild(opt);
        });
      }).catch(function () { /* not critical */ });
    }

    function loadLogs() {
      var tbody = el('alTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading activity…</td></tr>';

      // Backend filters: category, user, device via django-filter. Date range via start/end? No —
      // activity-logs uses ordering + category + user + device. Add date via custom query if present.
      var query = {
        page: state.page,
        page_size: state.pageSize,
        category: state.category || undefined,
        user: state.userId || undefined,
        ordering: '-created_at',
      };
      // Try start/end as created_at gte/lte (may be ignored gracefully)
      if (state.startDate) query['created_at__gte'] = state.startDate;
      if (state.endDate)   query['created_at__lte'] = state.endDate + 'T23:59:59Z';

      Api.get('/activity-logs/', { query: query }).then(function (data) {
        var rows = toArray(data);
        var total = pagedCount(data);
        state.rows = rows; state.total = total;
        renderTable(rows);
        renderPagination(total);
        setText('alCount', total + ' event' + (total !== 1 ? 's' : ''));
        setText('alSubtitle', 'Audit trail · ' + total + ' recorded event' + (total !== 1 ? 's' : ''));
      }).catch(function (err) { console.error('[activity] load failed:', err); setError('alTableBody', 'Could not load activity logs'); });
    }

    function renderTable(rows) {
      var tbody = el('alTableBody'); if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No activity</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        var ts = r.created_at || r.timestamp;
        var name = r.username || r.user_name || 'System';
        var category = (r.category || '').toUpperCase();
        var isSystem = !r.user;
        var avatar = isSystem
          ? '<div class="bg-secondary text-white rounded-circle d-flex align-items-center justify-content-center" style="width:24px;height:24px;"><i class="bi bi-cpu" style="font-size:.7rem;"></i></div>'
          : '<div class="bg-primary text-white rounded-circle d-flex align-items-center justify-content-center" style="width:24px;height:24px;font-size:.7rem;font-weight:bold;">' + escapeHtml(fmt.initials(name)) + '</div>';
        return '<tr>' +
          '<td class="text-muted small">' + (ts ? fmt.datetime(ts) : '—') + '</td>' +
          '<td><div class="d-flex align-items-center gap-2">' + avatar + '<span class="fw-semibold">' + escapeHtml(name) + '</span></div></td>' +
          '<td><span class="status-badge secondary">' + escapeHtml(category || '—') + '</span></td>' +
          '<td>' + escapeHtml(r.action || r.description || '—') + '</td>' +
          '<td>' + statusBadge(r.action || 'INFO') + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderPagination(total) {
      var info = el('alPageInfo'), pag = el('alPagination'); if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + ' to ' + to + ' of ' + total + ' entries';

      var html = '<li class="page-item ' + (state.page === 1 ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page - 1) + '">Previous</a></li>';
      for (var p = 1; p <= pages; p++) {
        if (pages > 7 && Math.abs(p - state.page) > 2 && p !== 1 && p !== pages) {
          if (p === 2 || p === pages - 1) html += '<li class="page-item disabled"><span class="page-link">…</span></li>';
          continue;
        }
        html += '<li class="page-item ' + (p === state.page ? 'active' : '') + '"><a class="page-link" href="#" data-page="' + p + '">' + p + '</a></li>';
      }
      html += '<li class="page-item ' + (state.page === pages ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page + 1) + '">Next</a></li>';
      pag.innerHTML = html;

      pag.querySelectorAll('[data-page]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var p = Number(a.getAttribute('data-page'));
          if (!p || p === state.page || p < 1 || p > pages) return;
          state.page = p; loadLogs();
        });
      });
    }

    function applyFilters() {
      state.startDate = (el('alStartDate') && el('alStartDate').value) || '';
      state.endDate   = (el('alEndDate')   && el('alEndDate').value)   || '';
      state.category  = (el('alCategoryFilter') && el('alCategoryFilter').value) || '';
      state.userId    = (el('alUserFilter')     && el('alUserFilter').value)     || '';
      state.page = 1; loadLogs();
    }
    function resetFilters() {
      var now = new Date(), start = new Date();
      start.setDate(now.getDate() - 7);
      var pad = function (n) { return String(n).padStart(2, '0'); };
      var ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
      if (el('alStartDate')) el('alStartDate').value = ymd(start);
      if (el('alEndDate'))   el('alEndDate').value   = ymd(now);
      if (el('alCategoryFilter')) el('alCategoryFilter').value = '';
      if (el('alUserFilter'))     el('alUserFilter').value = '';
      state.startDate = ymd(start); state.endDate = ymd(now);
      state.category = ''; state.userId = ''; state.page = 1;
      loadLogs();
    }

    var ap = el('alApplyBtn'); if (ap) ap.addEventListener('click', applyFilters);
    var rs = el('alResetBtn'); if (rs) rs.addEventListener('click', resetFilters);

    loadUsersForFilter();
    loadLogs();
  });

  /* ============================================================
     17. PAGE: settings
     Backend SystemSettings fields:
       normal_flow_rate_threshold, maximum_flow_rate, sensor_difference_tolerance,
       leak_trigger_flow_difference, leak_trigger_percentage, leak_detection_duration,
       automatic_leak_detection, automatic_valve_shutdown, device_heartbeat_timeout
     ============================================================ */
  register('settings', function () {
    function loadAll() {
      setText('settingsSubtitle', 'Loading settings…');
      Promise.all([
        Api.get('/settings/').catch(function () { return null; }),
        Api.get('/settings/thresholds/').catch(function () { return null; }),
        Api.get('/settings/leak-detection/').catch(function () { return null; }),
        Api.get('/settings/automation/').catch(function () { return null; }),
      ]).then(function (results) {
        var merged = Object.assign({}, results[0] || {}, results[1] || {}, results[2] || {}, results[3] || {});
        fillForm(merged);
        setText('settingsSubtitle', 'Loaded ' + new Date().toLocaleTimeString());
        var api = el('settingsApiUrl'); if (api) api.value = CONFIG.API_BASE;
      }).catch(function (err) { console.error('[settings] load failed:', err); toast.error('Failed to load settings'); });
    }

    function fillForm(obj) {
      var form = el('settingsForm'); if (!form) return;
      Array.prototype.forEach.call(form.elements, function (field) {
        if (!field.name) return;
        if (field.type === 'checkbox') field.checked = !!obj[field.name];
        else if (obj[field.name] != null) field.value = obj[field.name];
      });
    }

    function collectForm() {
      var form = el('settingsForm'); if (!form) return {};
      var out = {};
      Array.prototype.forEach.call(form.elements, function (field) {
        if (!field.name) return;
        if (field.type === 'checkbox') out[field.name] = !!field.checked;
        else if (field.type === 'number') out[field.name] = field.value === '' ? null : Number(field.value);
        else if (field.name === 'settingsApiUrl') return;
        else out[field.name] = field.value;
      });
      return out;
    }

    function saveAll() {
      var btn = el('settingsSaveBtn'), txt = el('settingsSaveText'), sp = el('settingsSaveSpinner');
      var payload = collectForm();

      // Split payload across the three PATCH endpoints based on which keys they accept
      var thresholdKeys = ['normal_flow_rate_threshold', 'maximum_flow_rate', 'sensor_difference_tolerance'];
      var leakKeys = ['leak_trigger_flow_difference', 'leak_trigger_percentage', 'leak_detection_duration', 'automatic_leak_detection'];
      var autoKeys = ['automatic_valve_shutdown', 'device_heartbeat_timeout'];

      var t = {}, l = {}, a = {};
      Object.keys(payload).forEach(function (k) {
        if (thresholdKeys.indexOf(k) >= 0) t[k] = payload[k];
        else if (leakKeys.indexOf(k) >= 0) l[k] = payload[k];
        else if (autoKeys.indexOf(k) >= 0) a[k] = payload[k];
      });

      var calls = [];
      if (Object.keys(t).length) calls.push(Api.patch('/settings/thresholds/', t));
      if (Object.keys(l).length) calls.push(Api.patch('/settings/leak-detection/', l));
      if (Object.keys(a).length) calls.push(Api.patch('/settings/automation/', a));

      if (!calls.length) { toast.info('No changes to save'); return; }

      btn.disabled = true; if (txt) txt.textContent = 'Saving…'; if (sp) sp.classList.remove('d-none');
      Promise.all(calls).then(function () {
        toast.success('Settings saved'); loadAll();
      }).catch(function (err) {
        var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
        toast.error(d || err.message || 'Save failed');
      }).finally(function () {
        btn.disabled = false; if (txt) txt.textContent = 'Save Changes'; if (sp) sp.classList.add('d-none');
      });
    }

    var sv = el('settingsSaveBtn'); if (sv) sv.addEventListener('click', saveAll);
    var rl = el('settingsReloadBtn'); if (rl) rl.addEventListener('click', loadAll);
    loadAll();
  });

  /* ============================================================
     18. PAGE: profile
     ============================================================ */
  register('profile', function () {
    function loadProfile() {
      Api.get('/auth/me/').then(function (u) {
        var name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username || '—';
        setText('profileAvatar', fmt.initials(name));
        setText('profileName', name);
        setText('profileEmail', u.email || '—');

        var role = (u.role || 'VIEWER').toUpperCase();
        var roleLabel = role === 'ADMIN' ? 'Administrator' : role === 'OPERATOR' ? 'Operator' : 'Viewer';
        var roleBadge = el('profileRole');
        if (roleBadge) {
          roleBadge.className = 'status-badge ' + (role === 'ADMIN' ? 'warning' : role === 'OPERATOR' ? 'info' : 'secondary');
          roleBadge.textContent = roleLabel;
        }

        setText('profileMemberSince',
          u.date_joined ? new Date(u.date_joined).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '—');
        setText('profileLastLogin', u.last_login ? fmt.timeAgo(u.last_login) : '—');

        var active = u.is_active !== false;
        var statusEl = el('profileStatus');
        if (statusEl) {
          statusEl.className = 'fw-bold small ' + (active ? 'text-success' : 'text-danger');
          statusEl.textContent = active ? 'Active' : 'Inactive';
        }

        var form = el('profileForm');
        if (form) {
          if (form.first_name) form.first_name.value = u.first_name || '';
          if (form.last_name)  form.last_name.value  = u.last_name  || '';
          if (form.email)      form.email.value      = u.email      || '';
          // The template may not have first_name/last_name; fall back to full_name if present
          if (form.full_name && !form.first_name) {
            form.full_name.value = ((u.first_name || '') + ' ' + (u.last_name || '')).trim();
          }
        }
      }).catch(function (err) { console.error('[profile] load failed:', err); toast.error('Failed to load profile'); });
    }

    function saveProfile(e) {
      e.preventDefault();
      var form = e.target, btn = el('profileSaveBtn'), txt = el('profileSaveText'), sp = el('profileSaveSpinner');
      var payload = {
        first_name: (form.first_name ? form.first_name.value : '').trim(),
        last_name:  (form.last_name  ? form.last_name.value  : '').trim(),
        email:      (form.email      ? form.email.value      : '').trim(),
      };
      // If template only has full_name, split it
      if (!form.first_name && form.full_name) {
        var parts = form.full_name.value.trim().split(/\s+/);
        payload.first_name = parts[0] || '';
        payload.last_name = parts.slice(1).join(' ') || '';
      }
      btn.disabled = true; if (txt) txt.textContent = 'Saving…'; if (sp) sp.classList.remove('d-none');
      Api.patch('/auth/me/', payload).then(function () { toast.success('Profile updated'); loadProfile(); })
        .catch(function (err) {
          var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
          toast.error(d || err.message || 'Could not save profile');
        }).finally(function () {
          btn.disabled = false; if (txt) txt.textContent = 'Save Changes'; if (sp) sp.classList.add('d-none');
        });
    }

    function changePassword(e) {
      e.preventDefault();
      var form = e.target, btn = el('passwordSubmitBtn'), txt = el('passwordSubmitText'), sp = el('passwordSubmitSpinner');
      // Backend expects old_password + new_password
      var oldPwd = form.old_password ? form.old_password.value
                 : form.current_password ? form.current_password.value
                 : '';
      var newPwd = form.new_password.value;
      var confirm = form.confirm_password.value;
      if (!oldPwd || !newPwd || !confirm) { toast.error('Fill in all password fields'); return; }
      if (newPwd.length < 8) { toast.error('New password must be at least 8 characters'); return; }
      if (newPwd !== confirm) { toast.error('New passwords do not match'); return; }

      btn.disabled = true; if (txt) txt.textContent = 'Updating…'; if (sp) sp.classList.remove('d-none');
      Api.post('/auth/password/change/', { old_password: oldPwd, new_password: newPwd })
        .then(function () { toast.success('Password updated'); form.reset(); })
        .catch(function (err) {
          var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
          toast.error(d || err.message || 'Could not update password');
        }).finally(function () {
          btn.disabled = false; if (txt) txt.textContent = 'Update Password'; if (sp) sp.classList.add('d-none');
        });
    }

    var pf = el('profileForm'); if (pf) pf.addEventListener('submit', saveProfile);
    var pw = el('passwordForm'); if (pw) pw.addEventListener('submit', changePassword);
    loadProfile();
  });

  /* ============================================================
     19. PAGE: devices
     ============================================================ */
  register('devices', function () {
    var state = { page: 1, pageSize: 20, search: '', type: '' };

    function loadDevices() {
      var tbody = el('devTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Loading devices…</td></tr>';
      Api.get('/devices/', {
        query: {
          page: state.page, page_size: state.pageSize,
          search: state.search || undefined,
          device_type: state.type || undefined,
        },
      }).then(function (data) {
        var rows = toArray(data);
        var total = pagedCount(data);
        renderTable(rows);
        renderPagination(total);
        updateSummary(rows, total);
      }).catch(function (err) { console.error('[devices] load failed:', err); setError('devTableBody', 'Could not load devices'); });
    }

    function updateSummary(rows, total) {
      var connected = rows.filter(function (d) { return d.connection_status === 'CONNECTED'; }).length;
      setText('devTotal', fmt.int(total));
      setText('devTotalNote', 'registered');
      setText('devConnected', fmt.int(connected));
      setText('devConnectedNote', 'online now');
      var latest = rows.reduce(function (acc, d) {
        if (!d.last_communication) return acc;
        return (!acc || new Date(d.last_communication) > new Date(acc)) ? d.last_communication : acc;
      }, null);
      setText('devLastComm', latest ? fmt.timeAgo(latest) : '—');
      setText('devLastCommNote', latest ? new Date(latest).toLocaleString() : 'No data');
      setText('devWarnings', '—');
      setText('devWarningsNote', 'Warnings via notifications');
    }

    function renderTable(rows) {
      var tbody = el('devTableBody'); if (!tbody) return;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No devices</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (d) {
        var health = d.connection_status === 'CONNECTED' ? 'HEALTHY' : 'OFFLINE';
        return '<tr>' +
          '<td class="fw-semibold">' + escapeHtml(d.device_name) + '</td>' +
          '<td><code>' + escapeHtml(d.device_identifier) + '</code></td>' +
          '<td>' + escapeHtml(d.device_type || '—') + '</td>' +
          '<td>' + statusBadge(d.connection_status) + '</td>' +
          '<td>' + statusBadge(health) + '</td>' +
          '<td class="text-muted small">' + fmt.timeAgo(d.last_communication) + '</td>' +
          '<td><button class="btn btn-sm btn-outline-primary" data-action="view" data-id="' + d.id + '">View</button></td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-action="view"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          Api.get('/devices/' + id + '/health/').then(function (h) {
            toast.info(JSON.stringify(h));
          }).catch(function () { toast.error('Could not load health'); });
        });
      });
    }

    function renderPagination(total) {
      var info = el('devPageInfo'), pag = el('devPagination'); if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + ' to ' + to + ' of ' + total;
      var html = '<li class="page-item ' + (state.page === 1 ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page - 1) + '">Previous</a></li>';
      for (var p = 1; p <= pages; p++) {
        html += '<li class="page-item ' + (p === state.page ? 'active' : '') + '"><a class="page-link" href="#" data-page="' + p + '">' + p + '</a></li>';
      }
      html += '<li class="page-item ' + (state.page === pages ? 'disabled' : '') + '"><a class="page-link" href="#" data-page="' + (state.page + 1) + '">Next</a></li>';
      pag.innerHTML = html;
      pag.querySelectorAll('[data-page]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var p = Number(a.getAttribute('data-page'));
          if (!p || p === state.page || p < 1 || p > pages) return;
          state.page = p; loadDevices();
        });
      });
    }

    function registerDevice() {
      // Backend endpoint: POST /iot/devices/register/
      var form = el('registerDeviceForm'); if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        var payload = {
          device_name: fd.get('device_name'),
          device_identifier: fd.get('device_id'),
          device_type: fd.get('device_type') || 'ARDUINO_ESP',
          location: fd.get('location') || '',
        };
        var btn = el('registerDeviceSubmit'), txt = el('registerDeviceSubmitText'), sp = el('registerDeviceSpinner');
        btn.disabled = true; if (txt) txt.textContent = 'Registering…'; if (sp) sp.classList.remove('d-none');

        Api.post('/iot/devices/register/', payload).then(function (data) {
          // Show api_key once — the user must copy it
          var modal = bootstrap.Modal.getInstance(el('registerDeviceModal'));
          if (modal) modal.hide();
          alert('Device registered!\n\nAPI key (SAVE IT NOW, shown once):\n\n' + data.api_key);
          loadDevices();
        }).catch(function (err) {
          toast.error(err.message || 'Registration failed');
        }).finally(function () {
          btn.disabled = false; if (txt) txt.textContent = 'Register'; if (sp) sp.classList.add('d-none');
        });
      });
    }

    var s = el('devSearch');
    if (s) s.addEventListener('input', function (e) {
      clearTimeout(window._devTimer);
      window._devTimer = setTimeout(function () { state.search = e.target.value.trim(); state.page = 1; loadDevices(); }, 350);
    });
    var t = el('devTypeFilter');
    if (t) t.addEventListener('change', function (e) { state.type = e.target.value; state.page = 1; loadDevices(); });
    var rb = el('registerDeviceBtn');
    if (rb) rb.addEventListener('click', function () {
      new bootstrap.Modal(el('registerDeviceModal')).show();
    });

    registerDevice();
    loadDevices();
  });

  /* ============================================================
     20. PAGE: leak-detection
     ============================================================ */
  register('leak-detection', function () {
    var flowChart = null;

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadOverview() {
      Api.get('/leaks/overview/').then(function (d) {
        // {active_events, confirmed_events, suspected_events, system_status}
        var status = (d.system_status || 'NORMAL').toUpperCase();
        var variant = status === 'NORMAL' ? 'success' : 'danger';
        setBadge('ld-pipeline-status', status, variant);
        setText('ld-pipeline-note', 'Across all pipelines');
        setText('ld-active', d.active_events || 0);
        setText('ld-active-note',
          (d.confirmed_events || 0) + ' confirmed · ' + (d.suspected_events || 0) + ' suspected');
      }).catch(function (err) { console.error('[leaks] overview failed:', err); });
    }

    function loadPipeline() {
      Api.get('/leaks/pipeline/').then(function (d) {
        // {pipeline:{...}, inlet_sensor:{...}, outlet_sensor:{...}, sections:[...], condition}
        var name = d.pipeline ? d.pipeline.name : '—';
        setText('ldPipelineName', name);
        var diag = el('ldPipelineDiagram');
        if (diag) {
          if (!d.pipeline) {
            diag.innerHTML = '<div class="text-center text-muted small py-4">No pipeline configured</div>';
          } else {
            diag.innerHTML =
              '<div class="p-3">' +
                '<div class="d-flex justify-content-between align-items-center">' +
                  '<div class="text-center">' +
                    '<i class="bi bi-broadcast text-primary" style="font-size:1.5rem;"></i>' +
                    '<div class="fw-semibold small mt-1">' + escapeHtml((d.inlet_sensor && d.inlet_sensor.name) || '—') + '</div>' +
                    '<div class="text-muted" style="font-size:.7rem;">INLET</div>' +
                  '</div>' +
                  '<div class="flex-grow-1 text-center text-muted small"><hr></div>' +
                  '<div class="text-center">' +
                    '<i class="bi bi-broadcast text-success" style="font-size:1.5rem;"></i>' +
                    '<div class="fw-semibold small mt-1">' + escapeHtml((d.outlet_sensor && d.outlet_sensor.name) || '—') + '</div>' +
                    '<div class="text-muted" style="font-size:.7rem;">OUTLET</div>' +
                  '</div>' +
                '</div>' +
              '</div>';
          }
        }
      }).catch(function (err) { console.error('[leaks] pipeline failed:', err); });

      Api.get('/leaks/pipeline/comparison/').then(function (d) {
        // {inlet_flow_rate, outlet_flow_rate, flow_difference, difference_percentage, is_leak_candidate}
        setText('ld-diff', fmt.num(d.flow_difference));
        setText('ld-diff-note', 'Inlet ' + fmt.num(d.inlet_flow_rate) + ' · Outlet ' + fmt.num(d.outlet_flow_rate) + ' L/min');

        // Build flow chart from a single point for now; richer chart needs history
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 220, toolbar: { show: false } },
          series: [{ name: 'Flow', data: [Number(d.inlet_flow_rate) || 0, Number(d.outlet_flow_rate) || 0] }],
          xaxis: { categories: ['Inlet', 'Outlet'], labels: { style: { colors: c.text } } },
          colors: ['#3b82f6', '#22c55e'],
          plotOptions: { bar: { columnWidth: '50%', borderRadius: 4 } },
          dataLabels: { enabled: true },
          yaxis: { title: { text: 'L/min' }, labels: { style: { colors: c.text } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
        };
        var target = el('ldFlowChart');
        if (target) {
          if (flowChart) { flowChart.updateOptions(options); flowChart.updateSeries(options.series); }
          else { flowChart = new ApexCharts(target, options); flowChart.render(); }
        }
      }).catch(function (err) { console.error('[leaks] comparison failed:', err); });
    }

    function loadEvents() {
      var severity = (el('ldSeverityFilter') && el('ldSeverityFilter').value) || '';
      var status = (el('ldStatusFilter') && el('ldStatusFilter').value) || '';
      var search = (el('ldSearch') && el('ldSearch').value) || '';
      Api.get('/leaks/events/', { query: { severity: severity || undefined, detection_status: status || undefined, search: search || undefined } })
        .then(function (data) {
          var rows = toArray(data);
          var tbody = el('ldEventsBody'); if (!tbody) return;
          if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">No leak events</td></tr>';
            return;
          }
          tbody.innerHTML = rows.map(function (r) {
            return '<tr>' +
              '<td><code>#' + escapeHtml(r.id) + '</code></td>' +
              '<td class="text-muted small">' + fmt.datetime(r.started_at) + '</td>' +
              '<td>' + fmt.num(r.flow_difference) + ' L/min</td>' +
              '<td>' + statusBadge(r.severity) + '</td>' +
              '<td class="small">' + escapeHtml(r.description || '—') + '</td>' +
              '<td>' + statusBadge(r.detection_status) + '</td>' +
              '<td class="text-end"><button class="btn btn-sm btn-outline-primary" data-action="view" data-id="' + r.id + '">View</button></td>' +
            '</tr>';
          }).join('');
          tbody.querySelectorAll('[data-action="view"]').forEach(function (btn) {
            btn.addEventListener('click', function () {
              var id = btn.getAttribute('data-id');
              Api.get('/leaks/events/' + id + '/').then(function (e) {
                var body = el('ldEventModalBody');
                if (body) {
                  body.innerHTML =
                    '<dl class="row small mb-0">' +
                      '<dt class="col-5">Status</dt><dd class="col-7">' + statusBadge(e.detection_status) + '</dd>' +
                      '<dt class="col-5">Severity</dt><dd class="col-7">' + statusBadge(e.severity) + '</dd>' +
                      '<dt class="col-5">Inlet flow</dt><dd class="col-7">' + fmt.num(e.inlet_flow_rate) + ' L/min</dd>' +
                      '<dt class="col-5">Outlet flow</dt><dd class="col-7">' + fmt.num(e.outlet_flow_rate) + ' L/min</dd>' +
                      '<dt class="col-5">Difference</dt><dd class="col-7">' + fmt.num(e.flow_difference) + ' L/min (' + fmt.num(e.difference_percentage) + '%)</dd>' +
                      '<dt class="col-5">Started</dt><dd class="col-7">' + fmt.datetime(e.started_at) + '</dd>' +
                      '<dt class="col-5">Resolved</dt><dd class="col-7">' + (e.resolved_at ? fmt.datetime(e.resolved_at) : '—') + '</dd>' +
                    '</dl>';
                }
                new bootstrap.Modal(el('ldEventModal')).show();
              }).catch(function () { toast.error('Could not load event'); });
            });
          });
        }).catch(function (err) { console.error('[leaks] events failed:', err); setError('ldEventsBody', 'Could not load leak events'); });
    }

    var rf = el('ldRefreshBtn'); if (rf) rf.addEventListener('click', function () { loadOverview(); loadPipeline(); loadEvents(); });
    ['ldSeverityFilter', 'ldStatusFilter'].forEach(function (id) {
      var n = el(id); if (n) n.addEventListener('change', loadEvents);
    });
    var s = el('ldSearch');
    if (s) s.addEventListener('input', function () {
      clearTimeout(window._ldTimer);
      window._ldTimer = setTimeout(loadEvents, 350);
    });

    loadOverview();
    loadPipeline();
    loadEvents();
  });

  /* ============================================================
     21. PAGE: valve-control
     ============================================================ */
  register('valve-control', function () {
    var currentValve = null;

    function loadValves() {
      Api.get('/valves/').then(function (data) {
        var rows = toArray(data);
        if (!rows.length) { toast.info('No valves configured'); return; }
        currentValve = rows[0];
        renderValve(currentValve);
        loadActivities();
      }).catch(function (err) { console.error('[valves] load failed:', err); });
    }

    function renderValve(v) {
      setBadge('vc-state-badge', v.current_status || 'UNKNOWN',
        v.current_status === 'OPEN' ? 'success' : v.current_status === 'CLOSED' ? 'danger' : 'secondary');
      setText('vc-state-note', 'Last update ' + fmt.timeAgo(v.last_updated));

      setBadge('vc-mode-badge', v.control_mode || 'MANUAL', v.control_mode === 'AUTOMATIC' ? 'success' : 'secondary');
      setText('vc-mode-note', v.control_mode === 'AUTOMATIC' ? 'Rules-driven' : 'Operator-driven');

      // Connection: derive from device if present
      setBadge('vc-conn-badge', '—', 'secondary');
      setText('vc-conn-note', 'Device info via /devices/' + (v.device || '—'));

      var details = el('vcDetailsBody');
      if (details) {
        details.innerHTML =
          '<dl class="row small mb-0">' +
            '<dt class="col-5">Valve name</dt><dd class="col-7">' + escapeHtml(v.valve_name || '—') + '</dd>' +
            '<dt class="col-5">Identifier</dt><dd class="col-7"><code>' + escapeHtml(v.valve_identifier || '—') + '</code></dd>' +
            '<dt class="col-5">State</dt><dd class="col-7">' + statusBadge(v.current_status) + '</dd>' +
            '<dt class="col-5">Mode</dt><dd class="col-7">' + statusBadge(v.control_mode) + '</dd>' +
            '<dt class="col-5">Last update</dt><dd class="col-7">' + fmt.datetime(v.last_updated) + '</dd>' +
          '</dl>';
      }
    }

    function loadActivities() {
      Api.get('/valves/activities/').then(function (data) {
        var rows = toArray(data);
        var tbody = el('vcActivityBody'); if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No valve activity</td></tr>';
          return;
        }
        setText('vcActivityCount', rows.length + ' entries');
        tbody.innerHTML = rows.slice(0, 20).map(function (r) {
          return '<tr>' +
            '<td class="text-muted small">' + fmt.datetime(r.requested_at) + '</td>' +
            '<td>' + escapeHtml(r.command_type) + '</td>' +
            '<td>' + escapeHtml(r.requested_by_username || 'System') + '</td>' +
            '<td>' + statusBadge(r.execution_status) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[valves] activities failed:', err); });
    }

    function sendCommand(type) {
      if (!currentValve) { toast.error('No valve selected'); return; }
      var path = '/valves/' + currentValve.id + '/' + type + '/';
      Api.post(path, {}).then(function (cmd) {
        toast.success('Command submitted — waiting for hardware');
        setBadge('vc-cmd-badge', cmd.execution_status || 'PENDING', 'warning');
        setText('vc-cmd-note', 'Issued ' + fmt.timeAgo(cmd.requested_at));
        loadActivities();
      }).catch(function (err) {
        toast.error(err.message || 'Command failed');
        setBadge('vc-cmd-badge', 'FAILED', 'danger');
      });
    }

    var op = el('vcOpenBtn'); if (op) op.addEventListener('click', function () { sendCommand('open'); });
    var cl = el('vcCloseBtn'); if (cl) cl.addEventListener('click', function () { sendCommand('close'); });
    var au = el('vcAutoBtn'); if (au) au.addEventListener('click', function () { sendCommand('auto'); });
    var mn = el('vcManualBtn'); if (mn) mn.addEventListener('click', function () { sendCommand('manual'); });
    var rf = el('vcRefreshBtn'); if (rf) rf.addEventListener('click', loadValves);

    loadValves();
  });

  /* ============================================================
     22. PAGE: water-usage (simple aggregate view)
     ============================================================ */
  register('water-usage', function () {
    // Not present in main.js previously; a minimal view that reuses analytics
    console.log('[water-usage] page loaded');
  });

  /* ============================================================
     23. BOOTSTRAP
     ============================================================ */
  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initShell();

    var page = currentPage();
    var init = PAGES[page];
    if (typeof init === 'function') {
      try { init(); }
      catch (e) { console.error('[main.js] page init failed for "' + page + '":', e); }
    } else {
      console.warn('[main.js] no controller registered for page:', page);
    }
  });

  /* ============================================================
     24. DEBUG
     ============================================================ */
  window.AP = { Api: Api, fmt: fmt, toast: toast, WSClient: WSClient, CONFIG: CONFIG };
})();