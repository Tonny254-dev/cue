/* ============================================================
   AQUAPULSE — main.js
   Single-file runtime. No imports. No auth (deferred).
   - All page logic lives inside ONE IIFE
   - Page router based on <body data-page="...">
   - Dark/light theme persisted in localStorage
   ============================================================ */
(function () {
  'use strict';

  /* ============================================================
     1. CONFIG
     ============================================================ */
  var CONFIG = {
    API_BASE: 'http://localhost:8000/api/v1',   // ← change to real backend URL when ready
    WS_BASE:  (location.protocol === 'https:' ? 'wss://' : 'ws://') + (location.hostname || 'localhost') + ':8000/ws',
    THEME_KEY: 'ap_theme',
    REQUEST_TIMEOUT: 15000,
  };

  /* ============================================================
     2. THEME STORE
     ============================================================ */
  var ThemeStore = {
    get: function () {
      try { return localStorage.getItem(CONFIG.THEME_KEY) || 'light'; }
      catch (e) { return 'light'; }
    },
    set: function (v) {
      try { localStorage.setItem(CONFIG.THEME_KEY, v); } catch (e) {}
    },
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
      return name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    },
  };

  /* ============================================================
     4. DOM HELPERS
     ============================================================ */
  function el(id) { return document.getElementById(id); }
  function setText(id, v) { var e = el(id); if (e) e.textContent = (v == null ? '—' : v); }
  function setBadge(id, text, variant) {
    var e = el(id); if (!e) return;
    e.className = 'status-badge ' + (variant || 'secondary');
    e.textContent = (text == null ? '—' : text);
  }
  function setError(id, msg) {
    var e = el(id);
    if (e) e.innerHTML = '<div class="text-center text-danger small py-4">' + escapeHtml(msg || 'Failed to load') + '</div>';
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toArray(x) {
    if (!x) return [];
    if (Array.isArray(x)) return x;
    return x.results || x.items || x.data || x.notifications || x.sensors || x.events || [];
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
      d.className = 'alert alert-' + (colors[type] || 'primary') + ' shadow mb-0';
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
     6. API CLIENT (no auth header — add later)
     ============================================================ */
  var Api = (function () {
    function buildUrl(path, query) {
      var base = CONFIG.API_BASE.replace(/\/$/, '');
      var url = base + path;
      if (query) {
        var qs = [];
        Object.keys(query).forEach(function (k) {
          var v = query[k];
          if (v !== undefined && v !== null && v !== '') qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
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

    function request(method, path, opts) {
      opts = opts || {};
      var url = buildUrl(path, opts.query);
      var headers = { 'Content-Type': 'application/json' };

      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, CONFIG.REQUEST_TIMEOUT);

      return fetch(url, {
        method: method,
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      }).then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (text) {
          var json = {};
          try { json = text ? JSON.parse(text) : {}; } catch (e) { json = {}; }
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
      get:   function (p, o) { return request('GET', p, o); },
      post:  function (p, b, o) { o = o || {}; o.body = b; return request('POST', p, o); },
      patch: function (p, b, o) { o = o || {}; o.body = b; return request('PATCH', p, o); },
      del:   function (p, o) { return request('DELETE', p, o); },
    };
  })();

  /* ============================================================
     7. WS CLIENT
     ============================================================ */
  function WSClient(path, options) {
    options = options || {};
    this.path = path;
    this.onMessage = options.onMessage || function () {};
    this.onStatus  = options.onStatus  || function () {};
    this.reconnect = options.reconnect !== false;
    this.attempts = 0;
    this.maxDelay = 30000;
    this.closedByUser = false;
    this.connect();
  }
  WSClient.prototype.connect = function () {
    var self = this;
    var url = CONFIG.WS_BASE + this.path;
    try { this.ws = new WebSocket(url); }
    catch (e) { self.onStatus('ERROR'); return; }

    this.ws.onopen = function () { self.attempts = 0; self.onStatus('OPEN'); };
    this.ws.onmessage = function (e) {
      var data;
      try { data = JSON.parse(e.data); } catch (_) { return; }
      self.onMessage(data);
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
     8. SHARED SHELL (theme + sidebar)
     ============================================================ */
  function currentPage() {
    return document.body.getAttribute('data-page')
        || (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var icon = el('themeIcon');
    if (icon) icon.className = theme === 'dark' ? 'bi bi-sun-fill' : 'bi bi-moon-fill';

    // Update ApexCharts theme (if any are on the page)
    if (window.ApexCharts) {
      document.querySelectorAll('.apexcharts-canvas').forEach(function (c) {
        // Best-effort: dispatch a custom event so page scripts can re-render
      });
    }
  }

  function initTheme() {
    applyTheme(ThemeStore.get());
  }

  function initShell() {
    // Theme toggle
    var toggle = el('themeToggle');
    if (toggle) toggle.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      ThemeStore.set(next);
      // Let pages re-render charts with the new theme
      window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: next } }));
    });

    // Sidebar
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
  }

  /* ============================================================
     9. PAGE ROUTER
     ============================================================ */
  var PAGES = {};
  function register(page, initFn) { PAGES[page] = initFn; }

  /* ============================================================
     10. PAGE: dashboard
     ============================================================ */
  register('dashboard', function () {
    var flowChart = null, usageChart = null, ws = null, pollTimer = null;

    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadOverview() {
      Api.get('/dashboard/overview/').then(function (d) {
        var flow = d.current_water_flow || {};
        setText('kpiFlow', fmt.num(flow.value));
        setText('kpiFlowUnit', flow.unit || 'L/min');
        setText('kpiFlowNote', 'Live reading');

        var cons = d.todays_consumption || {};
        setText('kpiConsumption', fmt.num(cons.value));
        setText('kpiConsumptionUnit', cons.unit || 'L');
        setText('kpiConsumptionNote', 'Since midnight');

        var health = d.system_health || {};
        var hv = health.status === 'HEALTHY' ? 'success'
               : health.status === 'DEGRADED' ? 'warning'
               : health.status === 'CRITICAL' ? 'danger' : 'secondary';
        setBadge('kpiHealthBadge', health.status || '—', hv);
        setText('kpiHealthNote', health.percentage != null ? health.percentage + '% uptime' : '');

        var alerts = d.active_alerts || {};
        setText('kpiAlerts', alerts.count != null ? alerts.count : 0);
        setText('kpiAlertsNote', (alerts.critical || 0) + ' critical · ' + (alerts.warning || 0) + ' warning');

        setText('dashboardSubtitle',
          'System ' + (health.status ? health.status.toLowerCase() : 'status') +
          ' · ' + (alerts.count != null ? alerts.count : 0) + ' active alerts');
        setText('dashboardLastUpdated', 'Updated ' + new Date().toLocaleTimeString());
      }).catch(function (err) {
        console.error('[dashboard] overview failed:', err);
        toast.error('Failed to load dashboard overview');
      });
    }

    function renderFlowChart(d) {
      var labels = d.labels || d.categories || [];
      var values = d.values || d.series || d.data || [];
      var unit   = d.unit || 'L/min';
      var c = themeColors();
      setText('flowTrendRange', d.range_label || '—');

      var options = {
        chart: { type: 'area', height: 320, toolbar: { show: false }, animations: { speed: 400 } },
        series: [{ name: 'Flow', data: values }],
        xaxis: { categories: labels, labels: { style: { colors: c.text } } },
        yaxis: { title: { text: unit }, labels: { style: { colors: c.text } } },
        stroke: { curve: 'smooth', width: 2 },
        colors: ['#3b82f6'],
        dataLabels: { enabled: false },
        tooltip: { y: { formatter: function (v) { return v + ' ' + unit; } } },
        grid: { borderColor: c.grid },
        theme: { mode: c.mode },
        noData: { text: 'No data' },
      };

      var target = el('flowChart');
      if (!target) return;
      if (flowChart) {
        flowChart.updateOptions(options);
        flowChart.updateSeries(options.series);
      } else {
        flowChart = new ApexCharts(target, options);
        flowChart.render();
      }
    }

    function loadFlowTrend() {
      Api.get('/dashboard/flow-trend/').then(renderFlowChart)
        .catch(function (err) { console.error('[dashboard] flow-trend failed:', err); setError('flowChart', 'Could not load flow trend'); });
    }

    function renderUsage(d) {
      var series = d.series || d.values || d.data || [];
      var labels = d.labels || d.categories || [];
      var c = themeColors();
      var options = {
        chart: { type: 'donut', height: 320 },
        series: series,
        labels: labels,
        colors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444'],
        legend: { position: 'bottom', labels: { colors: c.text } },
        dataLabels: { enabled: true, formatter: function (v) { return Number(v).toFixed(0) + '%'; } },
        theme: { mode: c.mode },
        noData: { text: 'No data' },
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
        if (!rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No recent activity</td></tr>'; return; }
        tbody.innerHTML = rows.slice(0, 5).map(function (r) {
          return '<tr>' +
            '<td>' + escapeHtml(r.event || r.description || r.category || '—') + '</td>' +
            '<td>' + escapeHtml(r.device || r.device_id || '—') + '</td>' +
            '<td>' + statusBadge(r.status) + '</td>' +
            '<td class="text-muted small">' + fmt.timeAgo(r.timestamp || r.created_at) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[dashboard] activity failed:', err); setError('activityTableBody', 'Could not load activity'); });
    }

    function loadConnectivity() {
      Api.get('/monitoring/connectivity/').then(function (data) {
        var rows = toArray(data);
        var box = el('deviceConnectivityList');
        if (!box) return;
        if (!rows.length) { box.innerHTML = '<div class="p-4 text-center text-muted small">No devices</div>'; return; }
        box.innerHTML = rows.map(function (d) {
          return '<div class="d-flex align-items-center justify-content-between p-3 border-bottom" style="border-color:var(--border-color)!important;">' +
            '<div class="d-flex align-items-center gap-2">' +
              '<i class="bi bi-cpu text-primary"></i>' +
              '<div>' +
                '<div class="fw-semibold small">' + escapeHtml(d.name || d.device_name || d.device_id) + '</div>' +
                '<div class="text-muted" style="font-size:.72rem;">' + fmt.timeAgo(d.last_communication || d.last_seen) + '</div>' +
              '</div>' +
            '</div>' +
            statusBadge(d.connection_status || d.status) +
          '</div>';
        }).join('');
      }).catch(function (err) { console.error('[dashboard] connectivity failed:', err); setError('deviceConnectivityList', 'Could not load devices'); });
    }

    function connectWS() {
      ws = new WSClient('/dashboard/', {
        onMessage: function (evt) {
          var type = evt.type, data = evt.data || {};
          if (type === 'flow_reading_updated') {
            setText('kpiFlow', fmt.num(data.flow_rate));
            setText('kpiFlowNote', 'Live · ' + new Date().toLocaleTimeString());
          }
          if (type === 'consumption_updated') setText('kpiConsumption', fmt.num(data.total_volume));
          if (type === 'system_health_updated') {
            var hv = data.status === 'HEALTHY' ? 'success' : data.status === 'DEGRADED' ? 'warning' : 'danger';
            setBadge('kpiHealthBadge', data.status, hv);
            setText('kpiHealthNote', data.percentage != null ? data.percentage + '% uptime' : '');
          }
          if (type === 'leak_detected') toast.warn('Leak detected: ' + (data.severity || 'unknown'));
          if (type === 'new_notification') { var dot = el('topbarUnreadDot'); if (dot) dot.classList.remove('d-none'); }
        },
      });
    }

    // Re-render charts on theme change
    window.addEventListener('themeChanged', function () {
      loadFlowTrend();
      loadConsumption();
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
     11. PAGE: live-monitoring
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
        setText('lm-flow-rate', fmt.num(d.live_flow_rate));
        setText('lm-volume', fmt.num(d.total_volume_today));
        setText('lm-volume-unit', d.unit || 'L');

        var updated = d.last_updated || new Date().toISOString();
        setText('lm-flow-updated', 'Updated ' + fmt.timeAgo(updated));
        setText('lm-volume-updated', 'Since midnight');

        var sensors = d.sensors || [];
        setBadge('lm-device-status', 'ONLINE', 'success');
        setText('lm-device-detail', sensors.length ? sensors.length + ' device(s) reporting' : 'No devices');

        var anyOffline = sensors.some(function (s) { return (s.status || '').toUpperCase() !== 'ONLINE'; });
        var anyOnline  = sensors.some(function (s) { return (s.status || '').toUpperCase() === 'ONLINE'; });
        var sv = !sensors.length ? 'secondary' : (anyOffline ? 'warning' : (anyOnline ? 'success' : 'danger'));
        var sl = !sensors.length ? '—' : (anyOffline ? 'DEGRADED' : 'ONLINE');
        setBadge('lm-sensor-status', sl, sv);
        setText('lm-sensor-detail', sensors.length ? sensors.length + ' sensor(s) · ' +
          sensors.filter(function (s) { return (s.status || '').toUpperCase() === 'ONLINE'; }).length + ' online' : 'No sensors');

        setText('lm-live-indicator', 'Live · ' + fmt.timeAgo(updated));
        pushLivePoint(d.live_flow_rate);
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
      if (!sensors || !sensors.length) { box.innerHTML = '<div class="p-4 text-center text-muted small">No sensors reporting</div>'; return; }
      box.innerHTML = sensors.map(function (s) {
        var st = (s.status || '').toUpperCase();
        var variant = st === 'ONLINE' ? 'success' : st === 'OFFLINE' ? 'danger' : 'warning';
        return '<div class="d-flex align-items-center justify-content-between p-3 border-bottom" style="border-color:var(--border-color)!important;">' +
          '<div class="d-flex align-items-center gap-2">' +
            '<i class="bi bi-broadcast text-primary"></i>' +
            '<div>' +
              '<div class="fw-semibold small">' + escapeHtml(s.name || s.position || s.sensor_id) + '</div>' +
              '<div class="text-muted" style="font-size:.72rem;">' +
                escapeHtml(s.sensor_id || '') + (s.position ? ' · ' + escapeHtml(s.position) : '') +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="text-end">' +
            '<div class="fw-semibold small">' + (s.flow_rate != null ? fmt.num(s.flow_rate) + ' L/min' : '—') + '</div>' +
            '<span class="status-badge ' + variant + '">' + escapeHtml(st || '—') + '</span>' +
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

      Api.get('/monitoring/history/', {
        query: { start_date: ymd(start), end_date: ymd(now), interval: interval },
      }).then(function (d) {
        var labels = d.labels || d.timestamps || d.categories || [];
        var values = d.values || d.readings || d.data || [];
        if (!labels.length && Array.isArray(d)) {
          labels = d.map(function (r) { return r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : ''; });
          values = d.map(function (r) { return r.flow_rate != null ? r.flow_rate : 0; });
        }
        var unit = d.unit || 'L/min';
        var c = themeColors();
        var options = {
          chart: { type: 'area', height: 300, toolbar: { show: false } },
          series: [{ name: 'Flow', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          yaxis: { title: { text: unit }, labels: { style: { colors: c.text } } },
          stroke: { curve: 'smooth', width: 2 },
          colors: ['#22c55e'],
          dataLabels: { enabled: false },
          tooltip: { y: { formatter: function (v) { return v + ' ' + unit; } } },
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
      Api.get('/monitoring/history/', { query: { interval: 'minute', page_size: 10 } }).then(function (d) {
        var rows = Array.isArray(d) ? d : toArray(d);
        var tbody = el('readingsTableBody');
        if (!tbody) return;
        if (!rows.length) { tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-4">No readings yet</td></tr>'; return; }
        rows = rows.slice(-10).reverse();
        tbody.innerHTML = rows.map(function (r) {
          var ts = r.timestamp || r.created_at || r.time;
          var flow = r.flow_rate != null ? r.flow_rate : r.value;
          var volume = r.volume != null ? r.volume : r.consumption;
          return '<tr>' +
            '<td class="text-muted small">' + (ts ? new Date(ts).toLocaleTimeString() : '—') + '</td>' +
            '<td>' + (flow != null ? fmt.num(flow) + ' L/min' : '—') + '</td>' +
            '<td>' + (volume != null ? fmt.num(volume) + ' L' : '—') + '</td>' +
            '<td>' + statusBadge(r.status || (flow != null ? 'OK' : '—')) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[live] readings failed:', err); setError('readingsTableBody', 'Could not load readings'); });
    }

    function connectWS() {
      ws = new WSClient('/monitoring/', {
        onMessage: function (evt) {
          var type = evt.type, data = evt.data || {};
          if (type === 'flow_reading_updated') {
            setText('lm-flow-rate', fmt.num(data.flow_rate));
            setText('lm-flow-updated', 'Live · ' + new Date().toLocaleTimeString());
            setText('lm-live-indicator', 'Live · ' + new Date().toLocaleTimeString());
            pushLivePoint(data.flow_rate);
            if (Array.isArray(data.sensors)) renderSensors(data.sensors);
          }
          if (type === 'consumption_updated') {
            setText('lm-volume', fmt.num(data.total_volume));
            setText('lm-volume-updated', 'Live · ' + new Date().toLocaleTimeString());
          }
          if (type === 'sensor_status_changed' && Array.isArray(data.sensors)) renderSensors(data.sensors);
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
     12. PAGE: analytics
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
      var i = el('anInterval')  && el('anInterval').value;
      return { start_date: s || undefined, end_date: e || undefined, interval: i || 'day' };
    }
    function themeColors() {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      return { text: dark ? '#94a3b8' : '#5a6a85', grid: dark ? '#334155' : '#e5eaef', mode: dark ? 'dark' : 'light' };
    }

    function loadSummary() {
      Api.get('/analytics/summary/', { query: filters() }).then(function (d) {
        setText('an-total', fmt.num(d.total_consumption, 1));
        setText('an-unit', d.unit || 'L');
        setText('an-total-note', 'Across selected range');
        setText('an-avg', fmt.num(d.average_daily_usage, 1));
        setText('an-avg-note', 'Litres per day');
        setText('an-leaks', fmt.int(d.total_leak_events));
        setText('an-leaks-note', d.total_leak_events ? 'Review below' : 'No leak events');
        if (d.peak_period) {
          setBadge('an-peak', d.peak_period, 'info');
          setText('an-peak-note', d.peak_period_note || 'Highest usage window');
        }
      }).catch(function (err) { console.error('[analytics] summary failed:', err); toast.error('Failed to load summary'); });
    }

    function loadTrend() {
      Api.get('/analytics/consumption-trends/', { query: filters() }).then(function (d) {
        var labels = d.labels || d.categories || d.periods || [];
        var values = d.values || d.data || d.consumption || [];
        if (!labels.length && Array.isArray(d)) {
          labels = d.map(function (r) { return r.date || ''; });
          values = d.map(function (r) { return r.volume != null ? r.volume : 0; });
        }
        var unit = d.unit || 'L';
        var c = themeColors();
        var options = {
          chart: { type: 'bar', height: 320, toolbar: { show: false } },
          series: [{ name: 'Consumption', data: values }],
          xaxis: { categories: labels, labels: { style: { colors: c.text } } },
          yaxis: { title: { text: unit }, labels: { style: { colors: c.text } } },
          colors: ['#3b82f6'],
          plotOptions: { bar: { columnWidth: '55%', borderRadius: 4 } },
          dataLabels: { enabled: false },
          tooltip: { y: { formatter: function (v) { return v + ' ' + unit; } } },
          grid: { borderColor: c.grid },
          theme: { mode: c.mode },
          noData: { text: 'No data' },
        };
        var target = el('anTrendChart');
        if (target) {
          if (trendChart) { trendChart.updateOptions(options); trendChart.updateSeries(options.series); }
          else { trendChart = new ApexCharts(target, options); trendChart.render(); }
        }
        if (labels.length && values.length) {
          var maxIdx = 0;
          for (var i = 1; i < values.length; i++) if (values[i] > values[maxIdx]) maxIdx = i;
          var curr = (el('an-peak') && el('an-peak').textContent) || '—';
          if (curr === '—' || curr === '') {
            setBadge('an-peak', String(labels[maxIdx]), 'info');
            setText('an-peak-note', fmt.num(values[maxIdx]) + ' ' + unit);
          }
        }
      }).catch(function (err) { console.error('[analytics] trend failed:', err); setError('anTrendChart', 'Could not load consumption trend'); });
    }

    function loadBreakdown() {
      Api.get('/analytics/usage-breakdown/', { query: filters() }).then(function (d) {
        var labels = d.labels || d.categories || [];
        var series = d.series || d.values || d.data || [];
        if (!labels.length && Array.isArray(d)) {
          labels = d.map(function (r) { return r.label || r.category || ''; });
          series = d.map(function (r) { return r.value != null ? r.value : 0; });
        }
        var c = themeColors();
        var options = {
          chart: { type: 'donut', height: 320 },
          series: series, labels: labels,
          colors: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'],
          legend: { position: 'bottom', labels: { colors: c.text } },
          dataLabels: { enabled: true, formatter: function (v) { return Number(v).toFixed(0) + '%'; } },
          theme: { mode: c.mode },
          noData: { text: 'No data' },
        };
        var target = el('anBreakdownChart');
        if (target) {
          if (breakdownChart) breakdownChart.updateOptions(options);
          else { breakdownChart = new ApexCharts(target, options); breakdownChart.render(); }
        }
      }).catch(function (err) { console.error('[analytics] breakdown failed:', err); setError('anBreakdownChart', 'Could not load usage breakdown'); });
    }

    function loadLeakChart() {
      Api.get('/analytics/leak-events/', { query: filters() }).then(function (d) {
        var labels, values;
        if (d && (d.labels || d.categories) && (d.values || d.data)) {
          labels = d.labels || d.categories;
          values = d.values || d.data;
        } else {
          var rows = Array.isArray(d) ? d : toArray(d);
          var buckets = {};
          rows.forEach(function (r) {
            var dt = (r.detected_at || r.timestamp || r.created_at || '').slice(0, 10);
            if (dt) buckets[dt] = (buckets[dt] || 0) + 1;
          });
          labels = Object.keys(buckets).sort();
          values = labels.map(function (k) { return buckets[k]; });
        }
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
          noData: { text: 'No events' },
        };
        var target = el('anLeakChart');
        if (target) {
          if (leakChart) { leakChart.updateOptions(options); leakChart.updateSeries(options.series); }
          else { leakChart = new ApexCharts(target, options); leakChart.render(); }
        }
      }).catch(function (err) { console.error('[analytics] leak chart failed:', err); setError('anLeakChart', 'Could not load leak events'); });
    }

    function loadLeakTable() {
      Api.get('/analytics/leak-events/', { query: filters() }).then(function (d) {
        var rows = Array.isArray(d) ? d : toArray(d);
        var tbody = el('anLeakTableBody');
        var countEl = el('anLeakCount');
        if (!tbody) return;
        if (countEl) countEl.textContent = rows.length + ' event' + (rows.length !== 1 ? 's' : '');
        if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No leak events</td></tr>'; return; }
        tbody.innerHTML = rows.slice(0, 20).map(function (r) {
          var id = r.id != null ? '#' + r.id : (r.event_id || '—');
          var ts = r.detected_at || r.timestamp || r.created_at;
          var sev = (r.severity || r.level || '—').toString().toUpperCase();
          var diff = r.flow_difference != null ? r.flow_difference : (r.difference != null ? r.difference : null);
          var unit = r.unit || 'L/min';
          var status = r.status || 'DETECTED';
          return '<tr>' +
            '<td><code>' + escapeHtml(id) + '</code></td>' +
            '<td class="text-muted small">' + (ts ? fmt.datetime(ts) : '—') + '</td>' +
            '<td>' + severityBadge(sev) + '</td>' +
            '<td>' + (diff != null ? fmt.num(diff) + ' ' + unit : '—') + '</td>' +
            '<td>' + statusBadge(status) + '</td>' +
          '</tr>';
        }).join('');
      }).catch(function (err) { console.error('[analytics] leak table failed:', err); setError('anLeakTableBody', 'Could not load leak events'); });
    }

    function severityBadge(sev) {
      var v = 'secondary';
      if (sev === 'CRITICAL' || sev === 'HIGH') v = 'danger';
      else if (sev === 'MEDIUM') v = 'warning';
      else if (sev === 'LOW') v = 'info';
      return '<span class="status-badge ' + v + '">' + escapeHtml(sev || '—') + '</span>';
    }

    function refreshAll() { loadSummary(); loadTrend(); loadBreakdown(); loadLeakChart(); loadLeakTable(); }

    window.addEventListener('themeChanged', refreshAll);
    var apply = el('anApplyBtn'); if (apply) apply.addEventListener('click', refreshAll);
    refreshAll();
  });

  /* ============================================================
     13. PAGE: notifications
     ============================================================ */
  register('notifications', function () {
    var state = { page: 1, pageSize: 20, search: '', severity: '', status: '', category: '', items: [], total: 0 };
    var ws = null, searchTimer = null;

    function loadList() {
      var listEl = el('notifList');
      if (listEl) listEl.innerHTML = '<div class="p-4 text-center text-muted small">Loading notifications…</div>';
      Api.get('/notifications/', {
        query: {
          page: state.page, page_size: state.pageSize,
          search: state.search || undefined,
          severity: state.severity || undefined,
          status: state.status || undefined,
          category: state.category || undefined,
        },
      }).then(function (data) {
        var rows  = toArray(data);
        var total = (data && data.count != null) ? data.count : rows.length;
        state.items = rows; state.total = total;
        renderList(rows);
        renderPagination(total);
        updateSummary(rows, total);
      }).catch(function (err) { console.error('[notif] load failed:', err); setError('notifList', 'Could not load notifications'); });
    }

    function updateSummary(rows, total) {
      var unread = rows.filter(function (n) {
        return !n.is_read && !n.read_at && (n.status || '').toUpperCase() !== 'READ';
      }).length;
      setText('notifSummary', total + ' notification' + (total !== 1 ? 's' : '') + ' · ' + unread + ' unread');
      var dot = el('topbarUnreadDot');
      if (dot) { if (unread > 0) dot.classList.remove('d-none'); else dot.classList.add('d-none'); }
    }

    function renderList(rows) {
      var listEl = el('notifList');
      if (!listEl) return;
      if (!rows.length) { listEl.innerHTML = '<div class="p-4 text-center text-muted small">No notifications</div>'; return; }
      listEl.innerHTML = rows.map(function (n) {
        var isRead = n.is_read || n.read_at || (n.status || '').toUpperCase() === 'READ';
        var sev = (n.severity || n.level || 'INFO').toString().toUpperCase();
        var meta = severityMeta(sev);
        var title = n.title || n.subject || meta.label;
        var body  = n.message || n.body || n.description || '';
        var time  = n.created_at || n.timestamp || n.sent_at;
        var cat   = (n.category || n.type || '').toUpperCase();
        var actions = '';
        if (!isRead) {
          if (cat === 'LEAK_DETECTION') actions = '<button class="btn btn-sm btn-danger" data-action="view-event" data-id="' + escapeHtml(n.id) + '">View Event</button><button class="btn btn-sm btn-outline-secondary" data-action="mark-read" data-id="' + escapeHtml(n.id) + '">Mark Read</button>';
          else if (cat === 'ABNORMAL_FLOW') actions = '<button class="btn btn-sm btn-primary" data-action="investigate" data-id="' + escapeHtml(n.id) + '">Investigate</button><button class="btn btn-sm btn-outline-secondary" data-action="mark-read" data-id="' + escapeHtml(n.id) + '">Mark Read</button>';
          else actions = '<button class="btn btn-sm btn-outline-secondary" data-action="mark-read" data-id="' + escapeHtml(n.id) + '">Mark Read</button>';
        }
        return '<div class="list-group-item p-4 border-bottom" style="border-color:var(--border-color)!important;' + (isRead ? 'opacity:0.7;' : '') + '">' +
          '<div class="d-flex gap-3">' +
            '<div class="kpi-icon ' + meta.bg + ' flex-shrink-0"><i class="bi ' + meta.icon + '"></i></div>' +
            '<div class="flex-grow-1">' +
              '<div class="d-flex justify-content-between align-items-start mb-1">' +
                '<h6 class="mb-0 fw-bold">' + escapeHtml(title) + '</h6>' +
                '<span class="text-muted small">' + fmt.timeAgo(time) + '</span>' +
              '</div>' +
              (body ? '<p class="text-muted mb-2 small">' + escapeHtml(body) + '</p>' : '') +
              (actions ? '<div class="d-flex gap-2">' + actions + '</div>' : '') +
            '</div>' +
            (isRead ? '' : '<div class="ms-2"><span class="badge bg-primary rounded-pill">New</span></div>') +
          '</div>' +
        '</div>';
      }).join('');

      listEl.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var a = btn.getAttribute('data-action'), id = btn.getAttribute('data-id');
          if (a === 'mark-read') markRead(id);
          else if (a === 'view-event' || a === 'investigate') openLeakEvent(id);
        });
      });
    }

    function severityMeta(sev) {
      if (sev === 'CRITICAL') return { icon: 'bi-shield-exclamation', bg: 'bg-red-light text-red', label: 'Critical' };
      if (sev === 'WARNING')  return { icon: 'bi-exclamation-triangle', bg: 'bg-orange-light text-orange', label: 'Warning' };
      if (sev === 'SUCCESS')  return { icon: 'bi-check-circle', bg: 'bg-green-light text-green', label: 'Success' };
      return { icon: 'bi-info-circle', bg: 'bg-blue-light text-blue', label: 'Info' };
    }

    function renderPagination(total) {
      var info = el('notifPageInfo'), pag = el('notifPagination');
      if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + ' to ' + to + ' of ' + total + ' notifications';

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

    function markRead(id) {
      Api.patch('/notifications/' + encodeURIComponent(id) + '/read/', {}).then(function () {
        toast.success('Marked as read'); loadList();
      }).catch(function (err) { toast.error(err.message || 'Could not mark as read'); });
    }
    function markAllRead() {
      var btn = el('markAllReadBtn'); if (btn) btn.disabled = true;
      Api.post('/notifications/mark-all-read/', {}).then(function () {
        toast.success('All marked as read'); loadList();
      }).catch(function (err) { toast.error(err.message || 'Failed'); })
        .finally(function () { if (btn) btn.disabled = false; });
    }
    function openLeakEvent(notifId) {
      Api.get('/notifications/' + encodeURIComponent(notifId) + '/').then(function (n) {
        var eventId = n.leak_event_id || n.related_object_id || n.event_id;
        if (!eventId) { toast.info('No linked leak event'); return; }
        location.href = 'leak-detection.html?event=' + encodeURIComponent(eventId);
      }).catch(function (err) { toast.error(err.message || 'Could not open event'); });
    }

    function connectWS() {
      ws = new WSClient('/notifications/', {
        onMessage: function (evt) {
          if (evt.type === 'new_notification') {
            toast.info((evt.data && evt.data.title) || 'New notification');
            if (state.page === 1) loadList();
            else { var dot = el('topbarUnreadDot'); if (dot) dot.classList.remove('d-none'); }
          }
        },
      });
    }

    var search = el('notifSearch');
    if (search) search.addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.search = e.target.value.trim(); state.page = 1; loadList(); }, 350);
    });
    ['notifSeverityFilter:severity', 'notifStatusFilter:status', 'notifCategoryFilter:category'].forEach(function (pair) {
      var p = pair.split(':'), node = el(p[0]);
      if (node) node.addEventListener('change', function (e) { state[p[1]] = e.target.value; state.page = 1; loadList(); });
    });
    var mAll = el('markAllReadBtn'); if (mAll) mAll.addEventListener('click', markAllRead);

    loadList();
    connectWS();
  });

  /* ============================================================
     14. PAGE: user-management
     ============================================================ */
  register('user-management', function () {
    var USERS_PATH = '/auth/users/';
    var state = { page: 1, pageSize: 20, search: '', role: '', status: '', users: [], total: 0 };
    var searchTimer = null;

    function loadUsers() {
      Api.get(USERS_PATH, {
        query: { page: state.page, page_size: state.pageSize, search: state.search || undefined, role: state.role || undefined, status: state.status || undefined },
      }).then(function (data) {
        var rows = toArray(data);
        var total = (data && data.count != null) ? data.count : rows.length;
        state.users = rows; state.total = total;
        renderTable(rows); renderPagination(total); updateSummary(rows, total);
      }).catch(function (err) {
        console.error('[user-mgmt] load failed:', err);
        setError('umTableBody', err.status === 404 ? 'User management endpoint not yet available on the backend' : 'Could not load users');
      });
    }

    function updateSummary(rows, total) {
      var active = rows.filter(function (u) { return (u.status || (u.is_active ? 'ACTIVE' : 'INACTIVE')).toUpperCase() === 'ACTIVE'; }).length;
      var admins = rows.filter(function (u) { return (u.role || '').toUpperCase() === 'ADMIN'; }).length;
      var inactive = rows.length - active;
      setText('umTotal', fmt.int(total));
      setText('umActive', fmt.int(active));
      setText('umAdmins', fmt.int(admins));
      setText('umInactive', fmt.int(inactive));
    }

    function renderTable(rows) {
      var tbody = el('umTableBody'); if (!tbody) return;
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No users found</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (u) {
        var name = u.full_name || u.name || u.username || '—';
        var email = u.email || '';
        var role = (u.role || '').toUpperCase();
        var status = (u.status || (u.is_active ? 'ACTIVE' : 'INACTIVE')).toUpperCase();
        var login = u.last_login || u.last_login_at;
        var ini = fmt.initials(name);
        var bg = status === 'INACTIVE' ? 'bg-secondary' : (role === 'ADMIN' ? 'bg-primary' : 'bg-dark');
        var op = status === 'INACTIVE' ? ';opacity:0.5;' : '';
        return '<tr' + (status === 'INACTIVE' ? ' style="opacity:0.7;"' : '') + '>' +
          '<td><div class="d-flex align-items-center gap-3">' +
            '<div class="' + bg + ' text-white rounded-circle d-flex align-items-center justify-content-center" style="width:40px;height:40px;font-weight:bold;' + op + '">' + escapeHtml(ini) + '</div>' +
            '<div><div class="fw-bold">' + escapeHtml(name) + '</div>' + (email ? '<div class="text-muted small">' + escapeHtml(email) + '</div>' : '') + '</div>' +
          '</div></td>' +
          '<td>' + roleBadge(role) + '</td>' +
          '<td>' + umStatusBadge(status) + '</td>' +
          '<td class="text-muted small">' + (login ? fmt.timeAgo(login) : '—') + '</td>' +
          '<td>' +
            '<button class="btn btn-sm btn-outline-primary me-1" title="Edit" data-action="edit" data-id="' + escapeHtml(u.id) + '"><i class="bi bi-pencil"></i></button>' +
            '<button class="btn btn-sm btn-outline-danger" title="Delete" data-action="delete" data-id="' + escapeHtml(u.id) + '"><i class="bi bi-trash"></i></button>' +
          '</td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-id');
          var act = btn.getAttribute('data-action');
          if (act === 'edit') openEditModal(id);
          if (act === 'delete') confirmDelete(id);
        });
      });
    }

    function renderPagination(total) {
      var info = el('umPageInfo'), pag = el('umPagination'); if (!info || !pag) return;
      var pages = Math.max(1, Math.ceil(total / state.pageSize));
      var from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
      var to = Math.min(state.page * state.pageSize, total);
      info.textContent = 'Showing ' + from + ' to ' + to + ' of ' + total + ' users';

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
          state.page = p; loadUsers();
        });
      });
    }

    function openCreateModal() {
      el('userFormTitle').textContent = 'Add New User';
      el('userForm').reset();
      el('userFormId').value = '';
      el('passwordFieldGroup').style.display = '';
      el('passwordHelp').textContent = 'Required for a new user.';
      new bootstrap.Modal(el('userFormModal')).show();
    }
    function openEditModal(id) {
      Api.get(USERS_PATH + encodeURIComponent(id) + '/').then(function (u) {
        el('userFormTitle').textContent = 'Edit User';
        el('userFormId').value = u.id;
        var f = el('userForm');
        f.full_name.value = u.full_name || u.name || '';
        f.username.value  = u.username || '';
        f.email.value     = u.email || '';
        f.role.value      = (u.role || 'VIEWER').toUpperCase();
        f.password.value  = '';
        el('passwordFieldGroup').style.display = '';
        el('passwordHelp').textContent = 'Leave blank to keep the current password.';
        new bootstrap.Modal(el('userFormModal')).show();
      }).catch(function (err) { toast.error(err.message || 'Could not load user'); });
    }
    function submitForm(e) {
      e.preventDefault();
      var form = e.target, id = el('userFormId').value;
      var btn = el('userFormSubmit'), txt = el('userFormSubmitText'), sp = el('userFormSpinner');
      var payload = {};
      new FormData(form).forEach(function (v, k) {
        if (k === 'id') return;
        if (k === 'password' && !v) return;
        payload[k] = v;
      });
      btn.disabled = true; txt.textContent = 'Saving…'; sp.classList.remove('d-none');
      var req = id ? Api.patch(USERS_PATH + encodeURIComponent(id) + '/', payload) : Api.post(USERS_PATH, payload);
      req.then(function () {
        bootstrap.Modal.getInstance(el('userFormModal')).hide();
        toast.success(id ? 'User updated' : 'User created');
        loadUsers();
      }).catch(function (err) {
        var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
        toast.error(d || err.message || 'Save failed');
      }).finally(function () { btn.disabled = false; txt.textContent = 'Save'; sp.classList.add('d-none'); });
    }
    function confirmDelete(id) {
      var u = state.users.find(function (x) { return String(x.id) === String(id); });
      var name = u ? (u.full_name || u.username || ('user #' + id)) : ('user #' + id);
      if (!confirm('Delete ' + name + '? This cannot be undone.')) return;
      Api.del(USERS_PATH + encodeURIComponent(id) + '/').then(function () {
        toast.success('User deleted'); loadUsers();
      }).catch(function (err) { toast.error(err.message || 'Delete failed'); });
    }

    function roleBadge(role) {
      var r = (role || '').toUpperCase();
      var v = r === 'ADMIN' ? 'warning' : r === 'OPERATOR' ? 'info' : 'secondary';
      var label = r === 'ADMIN' ? 'Administrator' : (r.charAt(0) + r.slice(1).toLowerCase());
      return '<span class="status-badge ' + v + '">' + escapeHtml(label || '—') + '</span>';
    }
    function umStatusBadge(status) {
      var s = (status || '').toUpperCase();
      var v = s === 'ACTIVE' ? 'success' : s === 'INACTIVE' ? 'danger' : 'secondary';
      return '<span class="status-badge ' + v + '">' + escapeHtml(s.charAt(0) + s.slice(1).toLowerCase()) + '</span>';
    }

    var search = el('umSearch');
    if (search) search.addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.search = e.target.value.trim(); state.page = 1; loadUsers(); }, 350);
    });
    ['umRoleFilter:role', 'umStatusFilter:status'].forEach(function (pair) {
      var p = pair.split(':'), n = el(p[0]);
      if (n) n.addEventListener('change', function (e) { state[p[1]] = e.target.value; state.page = 1; loadUsers(); });
    });
    var add = el('addUserBtn'); if (add) add.addEventListener('click', openCreateModal);
    var form = el('userForm'); if (form) form.addEventListener('submit', submitForm);

    loadUsers();
  });

  /* ============================================================
     15. PAGE: activity-logs
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

    function loadUsers() {
      Api.get('/activity-logs/users/').then(function (data) {
        var users = toArray(data), sel = el('alUserFilter'); if (!sel) return;
        users.forEach(function (u) {
          var opt = document.createElement('option');
          var id = u.id != null ? u.id : u.user_id;
          var label = u.full_name || u.username || u.name || ('User #' + id);
          if (u.role) label += ' (' + String(u.role).toLowerCase() + ')';
          opt.value = String(id); opt.textContent = label; sel.appendChild(opt);
        });
      }).catch(function (err) { console.warn('[activity] user filter load failed:', err); });
    }

    function loadLogs() {
      var tbody = el('alTableBody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">Loading activity…</td></tr>';
      Api.get('/activity-logs/', {
        query: {
          page: state.page, page_size: state.pageSize,
          start_date: state.startDate || undefined, end_date: state.endDate || undefined,
          category: state.category || undefined, user: state.userId || undefined,
        },
      }).then(function (data) {
        var rows = toArray(data);
        var total = (data && data.count != null) ? data.count : rows.length;
        state.rows = rows; state.total = total;
        renderTable(rows); renderPagination(total);
        setText('alCount', total + ' event' + (total !== 1 ? 's' : ''));
        setText('alSubtitle', 'Audit trail · ' + total + ' recorded event' + (total !== 1 ? 's' : ''));
      }).catch(function (err) { console.error('[activity] load failed:', err); setError('alTableBody', 'Could not load activity logs'); });
    }

    function renderTable(rows) {
      var tbody = el('alTableBody'); if (!tbody) return;
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-4">No activity</td></tr>'; return; }
      tbody.innerHTML = rows.map(function (r) {
        var ts = r.timestamp || r.created_at || r.time;
        var user = r.user || r.actor || {};
        var name = user.full_name || user.username || r.user_name || r.actor_name || 'System';
        var role = (user.role || r.user_role || '').toUpperCase();
        var isSystem = !user.id && !r.user_id && /system|automated|backend/i.test(name);
        var ini = isSystem ? null : fmt.initials(name);
        var category = (r.category || r.event_type || r.type || '').toUpperCase();
        var desc = r.description || r.message || r.detail || '';
        var status = r.status || r.outcome || '';
        var avatar = isSystem
          ? '<div class="bg-secondary text-white rounded-circle d-flex align-items-center justify-content-center" style="width:24px;height:24px;"><i class="bi bi-cpu" style="font-size:.7rem;"></i></div>'
          : '<div class="' + (role === 'ADMIN' ? 'bg-primary' : 'bg-secondary') + ' text-white rounded-circle d-flex align-items-center justify-content-center" style="width:24px;height:24px;font-size:.7rem;font-weight:bold;">' + escapeHtml(ini) + '</div>';
        return '<tr>' +
          '<td class="text-muted small">' + (ts ? fmt.datetime(ts) : '—') + '</td>' +
          '<td><div class="d-flex align-items-center gap-2">' + avatar + '<span class="fw-semibold">' + escapeHtml(name) + '</span></div></td>' +
          '<td>' + categoryBadge(category) + '</td>' +
          '<td>' + escapeHtml(desc || '—') + '</td>' +
          '<td>' + alStatusBadge(status) + '</td>' +
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

    function exportLogs() {
      var params = new URLSearchParams();
      if (state.startDate) params.set('start_date', state.startDate);
      if (state.endDate)   params.set('end_date', state.endDate);
      if (state.category)  params.set('category', state.category);
      if (state.userId)    params.set('user', state.userId);
      params.set('export', 'csv');
      fetch(CONFIG.API_BASE + '/activity-logs/?' + params.toString())
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); })
        .then(function (blob) {
          var a = document.createElement('a');
          var u = URL.createObjectURL(blob);
          a.href = u; a.download = 'activity-logs-' + Date.now() + '.csv';
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          URL.revokeObjectURL(u);
          toast.success('Export started');
        }).catch(function (err) { console.error('[activity] export failed:', err); toast.error('Export failed'); });
    }

    function categoryBadge(c) {
      var v = 'secondary';
      if (c === 'VALVE_CONTROL') v = 'info';
      else if (c === 'LEAK_DETECTION') v = 'danger';
      else if (c === 'DEVICE_MANAGEMENT') v = 'warning';
      else if (c === 'SENSOR_ACTIVITY') v = 'info';
      else if (c === 'SYSTEM_CONFIGURATION') v = 'primary';
      else if (c === 'AUTOMATION') v = 'success';
      return '<span class="status-badge ' + v + '">' + escapeHtml(c ? c.split('_').map(function (w) { return w.charAt(0) + w.slice(1).toLowerCase(); }).join(' ') : '—') + '</span>';
    }
    function alStatusBadge(status) {
      var s = (status || '').toUpperCase();
      var v = 'secondary';
      if (s === 'SUCCESS' || s === 'OK' || s === 'COMPLETED') v = 'success';
      else if (s === 'WARNING' || s === 'PENDING') v = 'warning';
      else if (s === 'FAILED' || s === 'ERROR' || s === 'CRITICAL') v = 'danger';
      return '<span class="status-badge ' + v + '">' + escapeHtml(s ? s.charAt(0) + s.slice(1).toLowerCase() : '—') + '</span>';
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
      state.startDate = ymd(start); state.endDate = ymd(now); state.category = ''; state.userId = ''; state.page = 1;
      loadLogs();
    }

    var ap = el('alApplyBtn'); if (ap) ap.addEventListener('click', applyFilters);
    var rs = el('alResetBtn'); if (rs) rs.addEventListener('click', resetFilters);
    var ex = el('alExportBtn'); if (ex) ex.addEventListener('click', exportLogs);

    loadUsers();
    loadLogs();
  });

  /* ============================================================
     16. PAGE: settings
     ============================================================ */
  register('settings', function () {
    function loadAll() {
      setText('settingsSubtitle', 'Loading settings…');
      Promise.all([
        Api.get('/settings/thresholds/').catch(function () { return null; }),
        Api.get('/settings/leak-detection/').catch(function () { return null; }),
        Api.get('/settings/automation/').catch(function () { return null; }),
        Api.get('/notifications/preferences/').catch(function () { return null; }),
        Api.get('/settings/').catch(function () { return null; }),
      ]).then(function (results) {
        var merged = Object.assign({}, results[4] || {}, results[0] || {}, results[1] || {}, results[2] || {}, results[3] || {});
        fillForm(merged);
        setText('settingsSubtitle', 'Loaded ' + new Date().toLocaleTimeString());
        setText('settingsApiUrl', CONFIG.API_BASE);
      }).catch(function (err) { console.error('[settings] load failed:', err); setText('settingsSubtitle', 'Could not load settings'); toast.error('Failed to load settings'); });
    }

    function fillForm(obj) {
      var form = el('settingsForm'); if (!form) return;
      Array.prototype.forEach.call(form.elements, function (field) {
        if (!field.name) return;
        if (field.type === 'checkbox') field.checked = !!obj[field.name];
        else if (obj[field.name] !== undefined && obj[field.name] !== null) field.value = obj[field.name];
      });
    }

    function collectForm() {
      var form = el('settingsForm'); if (!form) return {};
      var out = {};
      Array.prototype.forEach.call(form.elements, function (field) {
        if (!field.name) return;
        if (field.type === 'checkbox') out[field.name] = !!field.checked;
        else if (field.type === 'number') out[field.name] = field.value === '' ? null : Number(field.value);
        else out[field.name] = field.value;
      });
      return out;
    }

    function saveAll() {
      var btn = el('settingsSaveBtn'), txt = el('settingsSaveText'), sp = el('settingsSaveSpinner');
      var payload = collectForm();
      btn.disabled = true; txt.textContent = 'Saving…'; sp.classList.remove('d-none');

      var groups = [
        { path: '/settings/thresholds/', keys: ['normal_flow_rate_threshold','daily_consumption_limit','abnormal_consumption_period_minutes','maximum_flow_rate'] },
        { path: '/settings/leak-detection/', keys: ['flow_difference_threshold','difference_percentage_threshold','detection_duration_seconds','sensor_difference_tolerance','automatic_valve_shutdown','automatic_leak_detection'] },
        { path: '/settings/automation/', keys: ['device_heartbeat_timeout','timezone','maintenance_mode'] },
        { path: '/notifications/preferences/', keys: ['notify_leak_detection','notify_abnormal_flow','notify_device_disconnected','notify_sensor_warning','notify_valve_operation','notify_system_warning'] },
      ];

      var calls = groups.map(function (g) {
        var body = {};
        g.keys.forEach(function (k) { if (payload[k] !== undefined) body[k] = payload[k]; });
        return Object.keys(body).length ? Api.patch(g.path, body) : Promise.resolve(null);
      });

      Promise.all(calls).then(function () {
        toast.success('Settings saved'); loadAll();
      }).catch(function (err) {
        var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
        toast.error(d || err.message || 'Save failed');
      }).finally(function () { btn.disabled = false; txt.textContent = 'Save Changes'; sp.classList.add('d-none'); });
    }

    var sv = el('settingsSaveBtn'); if (sv) sv.addEventListener('click', saveAll);
    var rl = el('settingsReloadBtn'); if (rl) rl.addEventListener('click', loadAll);
    loadAll();
  });

  /* ============================================================
     17. PAGE: profile
     ============================================================ */
  register('profile', function () {
    function loadProfile() {
      Api.get('/auth/me/').then(function (u) {
        var name = u.full_name || u.name || u.username || '—';
        setText('profileAvatar', fmt.initials(name));
        setText('profileName', name);
        setText('profileEmail', u.email || '—');

        var role = (u.role || '').toUpperCase();
        var roleLabel = role === 'ADMIN' ? 'Administrator' : role === 'OPERATOR' ? 'Operator' : role === 'VIEWER' ? 'Viewer' : (role || '—');
        var roleBadge = el('profileRole');
        if (roleBadge) { roleBadge.className = 'status-badge ' + (role === 'ADMIN' ? 'warning' : role === 'OPERATOR' ? 'info' : 'secondary'); roleBadge.textContent = roleLabel; }

        setText('profileMemberSince', u.date_joined || u.created_at ? new Date(u.date_joined || u.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }) : '—');
        setText('profileLastLogin', u.last_login ? fmt.timeAgo(u.last_login) : '—');

        var status = (u.status || (u.is_active ? 'ACTIVE' : 'INACTIVE')).toUpperCase();
        var statusEl = el('profileStatus');
        if (statusEl) { statusEl.className = 'fw-bold small ' + (status === 'ACTIVE' ? 'text-success' : 'text-danger'); statusEl.textContent = status.charAt(0) + status.slice(1).toLowerCase(); }

        var form = el('profileForm');
        if (form) {
          if (form.full_name) form.full_name.value = u.full_name || u.name || '';
          if (form.username)  form.username.value  = u.username || '';
          if (form.email)     form.email.value     = u.email || '';
          if (form.phone)     form.phone.value     = u.phone || u.phone_number || '';
        }
      }).catch(function (err) { console.error('[profile] load failed:', err); toast.error('Failed to load profile'); });
    }

    function saveProfile(e) {
      e.preventDefault();
      var form = e.target, btn = el('profileSaveBtn'), txt = el('profileSaveText'), sp = el('profileSaveSpinner');
      var payload = {
        full_name: form.full_name.value.trim(),
        username:  form.username.value.trim(),
        email:     form.email.value.trim(),
        phone:     form.phone.value.trim(),
      };
      if (!payload.full_name || !payload.username || !payload.email) { toast.error('Name, username and email are required'); return; }
      btn.disabled = true; txt.textContent = 'Saving…'; sp.classList.remove('d-none');
      Api.patch('/auth/me/', payload).then(function () { toast.success('Profile updated'); loadProfile(); })
        .catch(function (err) {
          var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
          toast.error(d || err.message || 'Could not save profile');
        }).finally(function () { btn.disabled = false; txt.textContent = 'Save Changes'; sp.classList.add('d-none'); });
    }

    function changePassword(e) {
      e.preventDefault();
      var form = e.target, btn = el('passwordSubmitBtn'), txt = el('passwordSubmitText'), sp = el('passwordSubmitSpinner');
      var current = form.current_password.value, next = form.new_password.value, confirm = form.confirm_password.value;
      if (!current || !next || !confirm) { toast.error('Fill in all password fields'); return; }
      if (next.length < 8) { toast.error('New password must be at least 8 characters'); return; }
      if (next !== confirm) { toast.error('New passwords do not match'); return; }
      btn.disabled = true; txt.textContent = 'Updating…'; sp.classList.remove('d-none');
      Api.post('/auth/password/change/', { current_password: current, new_password: next })
        .then(function () { toast.success('Password updated'); form.reset(); })
        .catch(function (err) {
          var d = err.errors ? Object.values(err.errors).flat().join(' ') : '';
          toast.error(d || err.message || 'Could not update password');
        }).finally(function () { btn.disabled = false; txt.textContent = 'Update Password'; sp.classList.add('d-none'); });
    }

    var pf = el('profileForm'); if (pf) pf.addEventListener('submit', saveProfile);
    var pw = el('passwordForm'); if (pw) pw.addEventListener('submit', changePassword);
    loadProfile();
  });

  /* ============================================================
     18. Shared statusBadge used by dashboard activity + connectivity
     ============================================================ */
  function statusBadge(status) {
    var s = (status || '').toUpperCase();
    var v = 'secondary';
    if (s === 'SUCCESS' || s === 'ONLINE' || s === 'CONNECTED' || s === 'RESOLVED' || s === 'HEALTHY' || s === 'OK' || s === 'NORMAL') v = 'success';
    else if (s === 'WARNING' || s === 'DEGRADED' || s === 'PENDING') v = 'warning';
    else if (s === 'FAILED' || s === 'CRITICAL' || s === 'OFFLINE' || s === 'DISCONNECTED' || s === 'ERROR') v = 'danger';
    return '<span class="status-badge ' + v + '">' + escapeHtml(s || '—') + '</span>';
  }

  /* ============================================================
     BOOTSTRAP
     ============================================================ */
  document.addEventListener('DOMContentLoaded', function () {
    initTheme();
    initShell();

    var page = currentPage();
    var init = PAGES[page];
    if (typeof init === 'function') {
      try { init(); }
      catch (e) { console.error('[main.js] page init failed for "' + page + '":', e); }
    }
  });

  // Expose debug helpers
  window.AP = { Api: Api, fmt: fmt, toast: toast, WSClient: WSClient, CONFIG: CONFIG };
})();