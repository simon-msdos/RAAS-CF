export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    const isMissingKV = !env.REDIRECTS;
    const isMissingSecrets = !env.ADMIN_PASS;

    if (isMissingKV || isMissingSecrets) {
      return new Response(SETUP_WIZARD_HTML(isMissingKV, isMissingSecrets), {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    const getAuth = async () => {
      const user = await env.REDIRECTS.get('__ADMIN_USER') || env.ADMIN_USER;
      const pass = await env.REDIRECTS.get('__ADMIN_PASS') || env.ADMIN_PASS;
      return { user, pass };
    };

    const isAuthorized = async (req) => {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return false;
      const [scheme, encoded] = authHeader.split(' ');
      if (!encoded || scheme !== 'Basic') return false;
      const decoded = atob(encoded);
      const { user, pass } = await getAuth();
      return decoded === `${user}:${pass}`;
    };

    if (path.startsWith('admin') || path.startsWith('api')) {
      if (!await isAuthorized(request)) {
        return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Admin"' } });
      }

      if (url.pathname === '/api/links' && request.method === 'GET') {
        const list = await env.REDIRECTS.list();
        const manual = await Promise.all(list.keys.filter(k => !k.name.startsWith('__')).map(async k => ({
          slug: k.name,
          url: await env.REDIRECTS.get(k.name)
        })));
        
        const gitMapRaw = await env.REDIRECTS.get('__github_map');
        const auto = gitMapRaw ? JSON.parse(gitMapRaw) : {};
        
        return Response.json({ manual, auto });
      }

      if (url.pathname === '/api/links' && request.method === 'POST') {
        const { slug, target } = await request.json();
        await env.REDIRECTS.put(slug, target);
        return Response.json({ success: true });
      }

      if (url.pathname === '/api/links' && request.method === 'DELETE') {
        const slug = url.pathname.split('/').pop();
        await env.REDIRECTS.delete(slug);
        return Response.json({ success: true });
      }

      if (url.pathname === '/api/config' && request.method === 'POST') {
        const { github_token, admin_pass } = await request.json();
        if (github_token) await env.REDIRECTS.put('__GITHUB_TOKEN', github_token);
        if (admin_pass) await env.REDIRECTS.put('__ADMIN_PASS', admin_pass);
        return Response.json({ success: true });
      }

      if (url.pathname === '/api/sync' && request.method === 'POST') {
        const token = await env.REDIRECTS.get('__GITHUB_TOKEN') || env.GITHUB_TOKEN;
        if (!token) return Response.json({ success: false, error: 'No token configured.' }, { status: 400 });
        
        try {
          const reposResponse = await fetch(`https://api.github.com/user/repos?per_page=100&type=owner`, {
            headers: { 'Authorization': `token ${token}`, 'User-Agent': 'RAAS-CF-Worker' }
          });
          
          if (!reposResponse.ok) throw new Error(`GitHub API Error: ${reposResponse.statusText}`);
          
          const repos = await reposResponse.json();
          const map = {};

          await Promise.all(repos.map(async (repo) => {
            try {
              const contentsResponse = await fetch(`https://api.github.com/repos/${repo.full_name}/contents`, {
                headers: { 'Authorization': `token ${token}`, 'User-Agent': 'RAAS-CF-Worker' }
              });
              if (contentsResponse.ok) {
                const contents = await contentsResponse.json();
                const shFile = contents.find(f => f.name.endsWith('.sh'));
                if (shFile) map[repo.name] = shFile.download_url;
              }
            } catch (e) { }
          }));

          await env.REDIRECTS.put('__github_map', JSON.stringify(map));
          return Response.json({ success: true, count: Object.keys(map).length });
        } catch (err) {
          return Response.json({ success: false, error: err.message }, { status: 500 });
        }
      }

      if (path === 'admin') {
        return new Response(ADMIN_HTML(env.BASE_DOMAIN), { headers: { 'Content-Type': 'text/html' } });
      }
    }

    if (path === "") return Response.redirect(`https://${env.MAIN_SITE}`, 302);

    let target = await env.REDIRECTS.get(path);
    if (!target) {
      const gitMapRaw = await env.REDIRECTS.get('__github_map');
      if (gitMapRaw) {
        const gitMap = JSON.parse(gitMapRaw);
        target = gitMap[path];
      }
    }
    if (!target) {
      target = `https://raw.githubusercontent.com/${env.GITHUB_USER}/${path}/master/${path}.sh`;
    }

    return Response.redirect(target, 302);
  }
};

const SETUP_WIZARD_HTML = (missingKV, missingSecrets) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Setup Required | RAAS-CF</title>
    <style>
        :root { --bg: #f3f4f6; --text: #111827; --card: #ffffff; --primary: #2563eb; --accent: #dc2626; }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; padding: 40px; }
        .container { max-width: 600px; margin: 0 auto; background: var(--card); padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        h1 { font-size: 24px; margin-bottom: 8px; }
        .step { margin-top: 24px; padding: 16px; border: 1px solid #e5e7eb; border-radius: 8px; }
        .status { font-weight: bold; color: var(--accent); }
        .done { color: #059669; }
        button { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: 500; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Setup Required</h1>
        <p>Deployment successful, but final configuration is needed.</p>
        <div class="step">
            <p>KV Storage: ${missingKV ? '<span class="status">MISSING</span>' : '<span class="done">OK</span>'}</p>
            <p>Admin Secret: ${missingSecrets ? '<span class="status">MISSING</span>' : '<span class="done">OK</span>'}</p>
        </div>
        <div style="margin-top: 24px;"><button onclick="location.reload()">Refresh Page</button></div>
    </div>
</body>
</html>
`;

const ADMIN_HTML = (domain) => `
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RAAS Admin | ${domain}</title>
    <style>
        :root[data-theme="light"] {
            --bg: #f9fafb; --card: #ffffff; --text: #111827; --text-muted: #6b7280; --border: #e5e7eb; --primary: #2563eb; --primary-hover: #1d4ed8; --danger: #ef4444; --git: #059669; --code: #f1f5f9; --code-text: #1e293b;
        }
        :root[data-theme="dark"] {
            --bg: #111827; --card: #1f2937; --text: #f9fafb; --text-muted: #9ca3af; --border: #374151; --primary: #3b82f6; --primary-hover: #60a5fa; --danger: #f87171; --git: #10b981; --code: #111827; --code-text: #f1f5f9;
        }
        body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; transition: background 0.2s; }
        .navbar { background: var(--card); border-bottom: 1px solid var(--border); padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 10; }
        .container { max-width: 1100px; margin: 32px auto; padding: 0 20px; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; }
        h1, h2, h3 { margin-top: 0; }
        .btn { padding: 10px 16px; border-radius: 8px; border: none; font-weight: 500; cursor: pointer; transition: all 0.2s; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
        .btn-danger { background: var(--danger); color: white; }
        .btn-sm { padding: 6px 12px; font-size: 12px; }
        input { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 14px; border-radius: 8px; font-size: 14px; width: 100%; box-sizing: border-box; }
        .flex { display: flex; gap: 12px; align-items: flex-end; }
        .link-row { display: grid; grid-template-columns: 1fr auto auto; gap: 16px; align-items: center; padding: 16px; border-bottom: 1px solid var(--border); }
        .link-row:last-child { border-bottom: none; }
        .badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: var(--border); color: var(--text-muted); font-weight: bold; text-transform: uppercase; }
        .badge-git { background: rgba(16, 185, 129, 0.1); color: var(--git); border: 1px solid var(--git); }
        .curl-box { background: var(--code); color: var(--code-text); padding: 8px 12px; border-radius: 6px; font-family: monospace; font-size: 12px; border: 1px solid var(--border); overflow-x: auto; white-space: nowrap; max-width: 400px; }
        #toast { position: fixed; bottom: 24px; right: 24px; padding: 16px 24px; border-radius: 8px; color: white; font-weight: 500; transform: translateY(100px); transition: transform 0.3s; z-index: 100; }
        #toast.show { transform: translateY(0); }
        .loader { width: 16px; height: 16px; border: 2px solid #FFF; border-bottom-color: transparent; border-radius: 50%; display: inline-block; animation: rotation 1s linear infinite; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="navbar">
        <div style="font-weight: bold; font-size: 20px;">RAAS <span style="font-weight: normal; opacity: 0.7;">Console</span></div>
        <div style="display: flex; gap: 16px;">
            <button class="btn btn-outline" onclick="toggleTheme()" id="theme-toggle">🌙 Dark Mode</button>
            <button class="btn btn-primary" id="sync-btn" onclick="syncGitHub()">Sync GitHub</button>
        </div>
    </div>

    <div class="container">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 24px;">
            <div class="card">
                <h3>Quick Link</h3>
                <div style="margin-bottom: 12px;">
                    <label style="font-size: 12px; color: var(--text-muted);">Slug</label>
                    <input id="slug" placeholder="e.g. autocut">
                </div>
                <div>
                    <label style="font-size: 12px; color: var(--text-muted);">Target URL</label>
                    <div class="flex">
                        <input id="target" placeholder="https://...">
                        <button class="btn btn-primary" onclick="addLink()">Create</button>
                    </div>
                </div>
            </div>

            <div class="card">
                <h3>Settings</h3>
                <div class="flex">
                    <div style="flex:1">
                        <label style="font-size: 12px; color: var(--text-muted);">GitHub Token</label>
                        <input id="github_token" type="password" placeholder="••••••••">
                    </div>
                    <button class="btn btn-outline" onclick="saveConfig('github_token')">Save</button>
                </div>
                <div class="flex" style="margin-top: 12px;">
                    <div style="flex:1">
                        <label style="font-size: 12px; color: var(--text-muted);">Admin Password</label>
                        <input id="admin_pass" type="password" placeholder="New Password">
                    </div>
                    <button class="btn btn-outline" onclick="saveConfig('admin_pass')">Update</button>
                </div>
            </div>
        </div>

        <div class="card" style="margin-top: 24px;">
            <h3 id="list-title">Active Redirects</h3>
            <div id="link-list"></div>
        </div>
    </div>

    <div id="toast"></div>

    <script>
        const DOMAIN = "${domain}";
        const showToast = (msg, type = 'success') => {
            const t = document.getElementById('toast');
            t.innerText = msg;
            t.style.background = type === 'success' ? '#059669' : '#dc2626';
            t.classList.add('show');
            setTimeout(() => t.classList.remove('show'), 3000);
        };

        const toggleTheme = () => {
            const current = document.documentElement.getAttribute('data-theme');
            const target = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', target);
            document.getElementById('theme-toggle').innerText = target === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
            localStorage.setItem('theme', target);
        };

        const copyToClipboard = (text) => {
            navigator.clipboard.writeText(text).then(() => showToast('Command copied!'));
        };

        const loadLinks = async () => {
            const res = await fetch('/api/links');
            const data = await res.json();
            const container = document.getElementById('link-list');
            
            let html = '';
            
            const renderRow = (slug, url, isAuto) => {
                const cmd = \`curl -L \${DOMAIN}/\${slug} | bash\`;
                return \`
                    <div class="link-row">
                        <div>
                            <span class="badge \${isAuto ? 'badge-git' : ''}">\${isAuto ? 'GitHub' : 'Manual'}</span>
                            <span style="font-weight: 500; margin-left: 8px;">/\${slug}</span>
                            <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px; word-break: break-all;">\${url}</div>
                        </div>
                        <div class="curl-box">\${cmd}</div>
                        <div style="display: flex; gap: 8px;">
                            <button class="btn btn-outline btn-sm" onclick="copyToClipboard('\${cmd}')">Copy</button>
                            \${!isAuto ? \`<button class="btn btn-danger btn-sm" onclick="deleteLink('\${slug}')">Del</button>\` : ''}
                        </div>
                    </div>\`;
            };

            data.manual.forEach(l => html += renderRow(l.slug, l.url, false));
            Object.entries(data.auto).forEach(([slug, url]) => html += renderRow(slug, url, true));

            container.innerHTML = html || '<p style="text-align:center; padding: 20px; color: var(--text-muted);">No redirects found.</p>';
            document.getElementById('list-title').innerText = \`Active Redirects (\${data.manual.length + Object.keys(data.auto).length})\`;
        };

        const syncGitHub = async () => {
            const btn = document.getElementById('sync-btn');
            const original = btn.innerHTML;
            btn.innerHTML = '<span class="loader"></span>';
            btn.disabled = true;
            try {
                const r = await fetch('/api/sync', { method: 'POST' });
                const d = await r.json();
                if(d.success) { showToast(\`Found \${d.count} scripts.\`); loadLinks(); }
                else showToast(d.error, 'error');
            } catch(e) { showToast('Sync failed', 'error'); }
            btn.innerHTML = original;
            btn.disabled = false;
        };

        const saveConfig = async (key) => {
            const val = document.getElementById(key).value;
            await fetch('/api/config', { method: 'POST', body: JSON.stringify({ [key]: val }) });
            showToast('Saved');
            document.getElementById(key).value = '';
        };

        const addLink = async () => {
            const slug = document.getElementById('slug').value;
            const target = document.getElementById('target').value;
            if(!slug || !target) return showToast('Fill all fields', 'error');
            await fetch('/api/links', { method: 'POST', body: JSON.stringify({ slug, target }) });
            document.getElementById('slug').value = '';
            document.getElementById('target').value = '';
            loadLinks();
            showToast('Link created');
        };

        const deleteLink = async (slug) => {
            if(!confirm('Delete?')) return;
            await fetch('/api/links/' + slug, { method: 'DELETE' });
            loadLinks();
        };

        const savedTheme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);
        document.getElementById('theme-toggle').innerText = savedTheme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode';
        loadLinks();
    </script>
</body>
</html>
`;
