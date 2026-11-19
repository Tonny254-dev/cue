/* ============================================================
   AQUAPULSE — auth.js
   Login form handler + Auth facade used by main.js

   Layout assumption (this project):
       frontend/
       ├── js/auth.js            ← this file
       ├── js/main.js
       ├── css/aquapulse.css
       └── templates/
           ├── login.html        ← login form
           ├── dashboard.html    ← redirect target (SIBLING of login.html)
           └── *.html            ← all other pages, also siblings

   - Talks to Django /api/v1/auth/login/
   - Stores access/refresh in localStorage as ap_access / ap_refresh
   - Exposes Auth.getAccess(), getRefresh(), setTokens(), clear(),
     isLoggedIn(), requireLogin(), logout()
   ============================================================ */
(function () {
  'use strict';

  var API_BASE    = 'http://localhost:8000/api/v1';
  var TOKEN_KEY   = 'ap_access';
  var REFRESH_KEY = 'ap_refresh';

  /* ---------- URL helpers (flat templates/ layout) ----------
     All HTML files are siblings, so the redirect is always
     "<current-dir>/<target>.html", never "../<target>.html".
     ---------------------------------------------------------- */
  function siblingUrl(name) {
    // /frontend/templates/login.html  ->  /frontend/templates/<name>
    return location.pathname.replace(/\/[^/]*\.html?$/i, '/' + name);
  }
  function dashboardUrl() { return siblingUrl('dashboard.html'); }
  function loginUrl()     { return siblingUrl('login.html'); }

  /* ---------- Auth facade ---------- */
  window.Auth = {
    getAccess:  function () { return localStorage.getItem(TOKEN_KEY); },
    getRefresh: function () { return localStorage.getItem(REFRESH_KEY); },

    setTokens: function (access, refresh) {
      localStorage.setItem(TOKEN_KEY, access);
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    },

    clear: function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
    },

    isLoggedIn: function () { return !!this.getAccess(); },

    requireLogin: function () {
      if (!this.getAccess()) location.replace(loginUrl());
    },

    logout: function () {
      var self    = this;
      var refresh = this.getRefresh();
      var p = refresh
        ? fetch(API_BASE + '/auth/logout/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer ' + self.getAccess(),
            },
            body: JSON.stringify({ refresh: refresh }),
          }).catch(function () {})
        : Promise.resolve();

      p.finally(function () {
        self.clear();
        location.replace(loginUrl());
      });
    },
  };

  /* ---------- Login form handler ---------- */
  var form = document.getElementById('loginForm');
  if (!form) return; // not on the login page

  // If already authenticated, jump straight to dashboard
  if (Auth.isLoggedIn()) {
    location.replace(dashboardUrl());
    return;
  }

  var errBox  = document.getElementById('loginError');
  var btn     = document.getElementById('loginBtn');
  var btnText = document.getElementById('loginBtnText');
  var spinner = document.getElementById('loginSpinner');

  function showError(msg) {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.classList.remove('d-none');
  }
  function clearError() {
    if (!errBox) return;
    errBox.classList.add('d-none');
    errBox.textContent = '';
  }
  function setLoading(on) {
    if (btn) btn.disabled = on;
    if (btnText) btnText.textContent = on ? 'Signing in…' : 'Sign In';
    if (spinner) spinner.classList.toggle('d-none', !on);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();

    var username = form.username.value.trim();
    var password = form.password.value;

    if (!username || !password) {
      showError('Please enter both username and password.');
      return;
    }

    setLoading(true);

    fetch(API_BASE + '/auth/login/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password }),
    })
      .then(function (res) {
        return res.json().then(function (json) {
          return { ok: res.ok, status: res.status, body: json };
        });
      })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.success) {
          var msg = (res.body && res.body.message) || 'Login failed.';
          if (res.status === 401) msg = 'Invalid username or password.';
          throw new Error(msg);
        }

        var data = res.body.data;
        Auth.setTokens(data.access, data.refresh);

        // Redirect to dashboard.html (sibling of login.html)
        location.replace(dashboardUrl());
      })
      .catch(function (err) {
        showError(err.message || 'Login failed.');
        setLoading(false);
      });
  });
})();