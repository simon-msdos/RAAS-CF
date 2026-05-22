export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.slice(1);

      if (!env.REDIRECTS || !env.ADMIN_PASS) {
        return new Response(SETUP_WIZARD_HTML(!env.REDIRECTS, !env.ADMIN_PASS), { headers: { 'Content-Type': 'text/html' } });
      }

      const getAuth = async () => {
        const user = await env.REDIRECTS.get('__ADMIN_USER') || env.ADMIN_USER;
        const pass = await env.REDIRECTS.get('__ADMIN_PASS') || env.ADMIN_PASS;
        return { user, pass };
      };

      const isAuthorized = async (req) => {
        const cookie = req.headers.get('Cookie');
        if (cookie && cookie.includes('raas_session=')) {
          const session = cookie.split('raas_session=')[1].split(';')[0];
          const storedSession = await env.REDIRECTS.get('__GOOGLE_SESSION');
          if (session && session === storedSession) return true;
        }
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) return false;
        const [scheme, encoded] = authHeader.split(' ');
        if (!encoded || scheme !== 'Basic') return false;
        const decoded = atob(encoded);
        const { user, pass } = await getAuth();
        return decoded === `${user}:${pass}`;
      };

      if (url.pathname === '/admin/login/google') {
        const state = crypto.randomUUID();
        await env.REDIRECTS.put('__OAUTH_STATE', state, { expirationTtl: 600 });
        return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=https://${env.BASE_DOMAIN}/admin/callback/google&response_type=code&scope=email%20profile&state=${state}`, 302);
      }

      if (url.pathname === '/admin/callback/google') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const savedState = await env.REDIRECTS.get('__OAUTH_STATE');
        if (state !== savedState) return new Response('Invalid state', { status: 403 });
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `https://${env.BASE_DOMAIN}/admin/callback/google`, grant_type: 'authorization_code' })
        });
        const tokens = await tokenRes.json();
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        const userInfo = await userRes.json();
        if (userInfo.email !== env.GOOGLE_ALLOWED_EMAIL) return new Response('Unauthorized email', { status: 403 });
        const session = crypto.randomUUID();
        await env.REDIRECTS.put('__GOOGLE_SESSION', session, { expirationTtl: 86400 });
        return new Response(null, { status: 302, headers: { 'Location': '/admin', 'Set-Cookie': `raas_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400` } });
      }

      if (path.startsWith('admin') || path.startsWith('api')) {
        if (!await isAuthorized(request)) {
          return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin"' } });
        }

        if (url.pathname === '/api/links' && request.method === 'GET') {
          const list = await env.REDIRECTS.list();
          const manual = await Promise.all(list.keys.filter(k => !k.name.startsWith('__')).map(async k => {
            const val = await env.REDIRECTS.get(k.name);
            let data = { target: val, type: 'script' };
            try { if(val && val.startsWith('{')) data = JSON.parse(val); } catch(e) {}
            const stats = await env.REDIRECTS.get(`__stats:${k.name}`);
            return { slug: k.name, ...data, hits: stats ? JSON.parse(stats).count : 0 };
          }));
          const gitMapRaw = await env.REDIRECTS.get('__github_map');
          const autoMap = gitMapRaw ? JSON.parse(gitMapRaw) : {};
          const auto = await Promise.all(Object.entries(autoMap).map(async ([slug, target]) => {
            const stats = await env.REDIRECTS.get(`__stats:${slug}`);
            return { slug, target, type: 'script', hits: stats ? JSON.parse(stats).count : 0 };
          }));
          return Response.json({ manual, auto });
        }

        if (url.pathname.startsWith('/api/stats/') && request.method === 'GET') {
          const slug = url.pathname.split('/').pop();
          const stats = await env.REDIRECTS.get(`__stats:${slug}`);
          return Response.json(stats ? JSON.parse(stats) : { count: 0, logs: [] });
        }

        if (url.pathname === '/api/links' && request.method === 'POST') {
          const { slug, target, type } = await request.json();
          await env.REDIRECTS.put(slug, JSON.stringify({ target, type: type || 'script' }));
          return Response.json({ success: true });
        }

        if (url.pathname.startsWith('/api/links/') && request.method === 'DELETE') {
          const slug = url.pathname.split('/').pop();
          await env.REDIRECTS.delete(slug);
          await env.REDIRECTS.delete(`__stats:${slug}`);
          return Response.json({ success: true });
        }

        if (url.pathname === '/api/config' && request.method === 'POST') {
          const { github_token, admin_pass, current_pass } = await request.json();
          if (github_token) await env.REDIRECTS.put('__GITHUB_TOKEN', github_token);
          if (admin_pass) {
            const { pass } = await getAuth();
            if (current_pass !== pass) return Response.json({ success: false, error: 'Password incorrect' }, { status: 403 });
            await env.REDIRECTS.put('__ADMIN_PASS', admin_pass);
          }
          return Response.json({ success: true });
        }

        if (url.pathname === '/api/sync' && request.method === 'POST') {
          const token = await env.REDIRECTS.get('__GITHUB_TOKEN') || env.GITHUB_TOKEN;
          if (!token) return Response.json({ success: false, error: 'No token' }, { status: 400 });
          const res = await fetch(`https://api.github.com/user/repos?per_page=100&type=owner`, { headers: { 'Authorization': `token ${token}`, 'User-Agent': 'RAAS' } });
          const repos = await res.json();
          const map = {};
          await Promise.all(repos.map(async (repo) => {
            try {
              const cRes = await fetch(`https://api.github.com/repos/${repo.full_name}/contents`, { headers: { 'Authorization': `token ${token}`, 'User-Agent': 'RAAS' } });
              if (cRes.ok) {
                const contents = await cRes.json();
                const sh = contents.find(f => f.name.endsWith('.sh'));
                if (sh) map[repo.name] = sh.download_url;
              }
            } catch(e) {}
          }));
          await env.REDIRECTS.put('__github_map', JSON.stringify(map));
          return Response.json({ success: true, count: Object.keys(map).length });
        }

        if (path === 'admin') return new Response(ADMIN_HTML(env.BASE_DOMAIN, !!env.GOOGLE_CLIENT_ID), { headers: { 'Content-Type': 'text/html' } });
      }

      if (path === "") return Response.redirect(`https://${env.MAIN_SITE}`, 302);

      let target = "";
      let val = await env.REDIRECTS.get(path);
      if (val) {
        try { if (val.startsWith('{')) target = JSON.parse(val).target; else target = val; } catch(e) { target = val; }
      } else {
        const gitMapRaw = await env.REDIRECTS.get('__github_map');
        if (gitMapRaw) {
          const gitMap = JSON.parse(gitMapRaw);
          target = gitMap[path];
        }
      }
      
      if (!target) {
        const rawUrl = `https://raw.githubusercontent.com/${env.GITHUB_USER}/${path}/master/${path}.sh`;
        const check = await fetch(rawUrl, { method: 'HEAD' });
        if (check.ok) target = rawUrl;
      }

      if (!target) {
        return new Response(ERROR_PAGE_HTML('404 Not Found', `The path "/${path}" does not match any redirects.`, env.GITHUB_USER), { 
          status: 404, headers: { 'Content-Type': 'text/html' } 
        });
      }

      try {
        const raw = await env.REDIRECTS.get(`__stats:${path}`);
        const stats = raw ? JSON.parse(raw) : { count: 0, logs: [] };
        stats.count++;
        stats.logs.unshift({ t: new Date().toISOString(), ip: request.headers.get('cf-connecting-ip') || 'unknown' });
        stats.logs = stats.logs.slice(0, 10);
        await env.REDIRECTS.put(`__stats:${path}`, JSON.stringify(stats));
      } catch(e) {}

      if (!target.startsWith('http')) target = 'https://' + target;
      return Response.redirect(target, 302);

    } catch (err) {
      return new Response(ERROR_PAGE_HTML('Worker Exception', err.message, env.GITHUB_USER), { 
        status: 500, headers: { 'Content-Type': 'text/html' } 
      });
    }
  }
};

const ERROR_PAGE_HTML = (title, msg, user) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title><style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e293b;padding:40px;border-radius:16px;max-width:500px;text-align:center}.btn{display:inline-block;background:#3b82f6;color:white;padding:12px 24px;border-radius:8px;text-decoration:none}</style></head><body><div class="card"><h1>${title}</h1><p>${msg}</p><a href="https://github.com/${user}/RAAS-CF" class="btn">View Docs</a></div></body></html>`;

const SETUP_WIZARD_HTML = (mKV, mS) => `<!DOCTYPE html><html><body><h1>Setup Required</h1><p>KV: ${mKV?'NO':'OK'}</p><p>Pass: ${mS?'NO':'OK'}</p><button onclick="location.reload()">Refresh</button></body></html>`;

const ADMIN_HTML = (domain, hasGoogle) => `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <title>RAAS Admin | \${domain}</title>
    <style>
        :root[data-theme="light"] { --bg: #f9fafb; --card: #ffffff; --text: #111827; --border: #e5e7eb; --primary: #2563eb; --git: #059669; --web: #7c3aed; }
        :root[data-theme="dark"] { --bg: #111827; --card: #1f2937; --text: #f9fafb; --border: #374151; --primary: #3b82f6; --git: #10b981; --web: #a78bfa; }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; margin: 0; }
        .navbar { background: var(--card); border-bottom: 1px solid var(--border); padding: 12px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
        .container { max-width: 1100px; margin: 24px auto; padding: 0 20px; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .btn { padding: 8px 14px; border-radius: 6px; border: none; font-weight: 500; cursor: pointer; transition: 0.2s; font-size: 13px; display: inline-flex; align-items: center; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
        .btn-danger { background: #ef4444; color: white; }
        input, select { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font-size: 13px; }
        .link-row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 12px; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); }
        .badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: var(--border); font-weight: bold; }
        .curl-box { background: #000; color: #00ff41; padding: 6px 10px; border-radius: 4px; font-family: monospace; font-size: 11px; max-width: 300px; overflow-x: auto; }
        #toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: white; transform: translateY(100px); transition: 0.3s; z-index: 100; }
        #toast.show { transform: translateY(0); }
        .stats-panel { display:none; background:rgba(0,0,0,0.05); padding:10px; margin-top:10px; border-radius:8px; font-size:11px; }
    </style>
</head>
<body>
    <div class="navbar">
        <div style="font-weight:bold;">RAAS Console</div>
        <div style="display:flex; gap:10px;">
            <button class="btn btn-outline" onclick="toggleTheme()">Theme</button>
            <button class="btn btn-primary" onclick="syncGitHub()">Sync GitHub</button>
        </div>
    </div>
    <div class="container">
        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap:20px;">
            <div class="card">
                <h3>New Redirect</h3>
                <input id="slug" placeholder="Slug" style="width:100%; margin-bottom:8px;">
                <div style="display:flex; gap:8px; margin-bottom:8px;">
                    <select id="type" style="flex:1"><option value="web">Web</option><option value="script">Script</option></select>
                    <input id="target" style="flex:2" placeholder="https://...">
                </div>
                <button class="btn btn-primary" style="width:100%" onclick="addLink()">Create</button>
            </div>
            <div class="card">
                <h3>Security</h3>
                <input id="curr_pass" type="password" placeholder="Current Password" style="width:100%; margin-bottom:8px;">
                <div style="display:flex; gap:8px;">
                    <input id="admin_pass" type="password" placeholder="New Password" style="flex:1">
                    <button class="btn btn-outline" onclick="updatePassword()">Update</button>
                </div>
                <div id="google-auth-section"></div>
            </div>
            <div class="card">
                <h3>Discovery</h3>
                <div class="flex"><input id="github_token" type="password" placeholder="GitHub Token" style="flex:1"><button class="btn btn-outline" onclick="saveConfig({github_token: document.getElementById('github_token').value})">Save</button></div>
                <p style="font-size:11px; margin-top:8px;"><a href="https://github.com/settings/tokens/new?description=RAAS-CF&scopes=repo,read:user" target="_blank" style="color:var(--primary)">Generate Token →</a></p>
            </div>
        </div>
        <div class="card">
            <h3 id="list-title">Active Redirects</h3>
            <div id="link-list"></div>
        </div>
    </div>
    <div id="toast"></div>
    <script>
        const DOMAIN = "\${domain}";
        const hasGoogle = \${hasGoogle};
        if (hasGoogle) {
            document.getElementById('google-auth-section').innerHTML = \`
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
                    <a href="/admin/login/google" class="btn btn-outline" style="width: 100%;">Connect Google Account</a>
                </div>\`;
        }
        const showToast = (m, t='success') => {
            const el = document.getElementById('toast');
            el.innerText = m; el.style.background = t==='success'?'#059669':'#ef4444';
            el.classList.add('show'); setTimeout(()=>el.classList.remove('show'), 3000);
        };
        const toggleTheme = () => {
            const t = document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
            document.documentElement.setAttribute('data-theme', t); localStorage.setItem('theme', t);
        };
        const loadLinks = async () => {
            const r = await fetch('/api/links');
            const d = await r.json();
            const list = document.getElementById('link-list');
            let h = '';
            const row = (s, u, t, isA, hits) => {
                const isW = t==='web';
                const cmd = \\\`curl -L \${DOMAIN}/\${s} | bash\\\`;
                return \`
                    <div style="border-bottom:1px solid var(--border); padding:10px 0;">
                        <div class="link-row">
                            <div>
                                <span class="badge \${isA?'badge-git':(isW?'badge-web':'')}" style="color:\${isA?'var(--git)':(isW?'var(--web)':'#888')}">\${isA?'GitHub':(isW?'Web':'Script')}</span>
                                <span style="font-weight:bold; margin-left:8px;">/\${s}</span>
                                <div style="font-size:10px; color:#888;">Hits: \${hits}</div>
                            </div>
                            \${isW ? \\\`<a href="https://\${DOMAIN}/\${s}" target="_blank" style="font-size:11px;">Open ↗</a>\\\` : \\\`<div class="curl-box">\${cmd}</div>\\\`}
                            <div style="display:flex; gap:5px;">
                                <button class="btn btn-outline btn-sm" onclick="showStats('\${s}')">Stats</button>
                                <button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText('\${isW?'https://'+DOMAIN+'/'+s:cmd}').then(()=>showToast('Copied!'))">Copy</button>
                                \${!isA ? \\\`<button class="btn btn-danger btn-sm" onclick="deleteLink('\${s}')">Del</button>\` : ''}
                            </div>
                        </div>
                        <div id="stats-\${s}" class="stats-panel"></div>
                    </div>\`;
            };
            d.manual.forEach(l => h += row(l.slug, l.target, l.type, false, l.hits));
            d.auto.forEach(l => h += row(l.slug, l.target, l.type, true, l.hits));
            list.innerHTML = h || '<p style="text-align:center;color:#888;">No links.</p>';
            document.getElementById('list-title').innerText = \\\`Active Redirects (\${d.manual.length + d.auto.length})\\\`;
        };
        const showStats = async (s) => {
            const el = document.getElementById('stats-'+s);
            if(el.style.display==='block') { el.style.display='none'; return; }
            const r = await fetch('/api/stats/'+s);
            const d = await r.json();
            el.innerHTML = '<strong>Recent Activity:</strong>' + d.logs.map(l => \\\`<div style="margin-top:4px;">\${l.t.split('T')[0]} \${l.t.split('T')[1].slice(0,5)} - IP: \${l.ip}</div>\\\`).join('') || 'No data.';
            el.style.display='block';
        };
        const addLink = async () => {
            const slug=document.getElementById('slug').value, target=document.getElementById('target').value, type=document.getElementById('type').value;
            if(!slug || !target) return showToast('Fill all fields', 'error');
            await fetch('/api/links', { method:'POST', body:JSON.stringify({slug,target,type}) });
            loadLinks(); showToast('Created');
            document.getElementById('slug').value=''; document.getElementById('target').value='';
        };
        const deleteLink = async (s) => {
            if(!confirm('Delete?')) return;
            await fetch('/api/links/'+s, { method:'DELETE' });
            await loadLinks(); showToast('Deleted');
        };
        const syncGitHub = async () => {
            showToast('Syncing...');
            const r = await fetch('/api/sync', { method:'POST' });
            loadLinks(); showToast('Synced');
        };
        const updatePassword = async () => {
            const current_pass=document.getElementById('curr_pass').value, admin_pass=document.getElementById('admin_pass').value;
            const r = await fetch('/api/config', { method:'POST', body:JSON.stringify({current_pass, admin_pass}) });
            const d = await r.json();
            if(d.success) showToast('Updated'); else showToast(d.error, 'error');
        };
        const saveConfig = async (data) => {
            const res = await fetch('/api/config', { method: 'POST', body: JSON.stringify(data) });
            if(res.ok) showToast('Config saved');
        };
        document.documentElement.setAttribute('data-theme', localStorage.getItem('theme')||'dark');
        loadLinks();
    </script>
</body>
</html>
`;
