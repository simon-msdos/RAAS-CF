export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

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
        const links = await Promise.all(list.keys.filter(k => !k.name.startsWith('__')).map(async k => ({
          slug: k.name,
          url: await env.REDIRECTS.get(k.name)
        })));
        return Response.json(links);
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
        if (!token) return Response.json({ success: false, error: 'No token' }, { status: 400 });
        
        const reposResponse = await fetch(`https://api.github.com/user/repos?per_page=100`, {
          headers: { 'Authorization': `token ${token}`, 'User-Agent': 'RAAS-CF-Worker' }
        });
        const repos = await reposResponse.json();
        const map = {};

        for (const repo of repos) {
          const contentsResponse = await fetch(`https://api.github.com/repos/${repo.full_name}/contents`, {
            headers: { 'Authorization': `token ${token}`, 'User-Agent': 'RAAS-CF-Worker' }
          });
          if (contentsResponse.ok) {
            const contents = await contentsResponse.json();
            const shFile = contents.find(f => f.name.endsWith('.sh'));
            if (shFile) map[repo.name] = shFile.download_url;
          }
        }
        await env.REDIRECTS.put('__github_map', JSON.stringify(map));
        return Response.json({ success: true, count: Object.keys(map).length });
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

const ADMIN_HTML = (domain) => `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin | ${domain}</title>
    <style>
        body { background: #0a0a0a; color: #00ff41; font-family: 'Courier New', Courier, monospace; padding: 20px; line-height: 1.6; }
        .container { max-width: 900px; margin: 0 auto; border: 1px solid #00ff41; padding: 20px; box-shadow: 0 0 15px rgba(0, 255, 65, 0.2); }
        h1 { border-bottom: 1px solid #00ff41; padding-bottom: 10px; text-transform: uppercase; letter-spacing: 2px; }
        .section { margin-top: 30px; border-top: 1px solid #333; padding-top: 20px; }
        input { background: #1a1a1a; border: 1px solid #00ff41; color: #00ff41; padding: 8px; margin-bottom: 10px; width: 250px; display: inline-block; }
        button { background: #00ff41; color: #000; border: none; padding: 8px 20px; cursor: pointer; font-weight: bold; text-transform: uppercase; }
        button:hover { background: #00cc33; }
        .btn-blue { background: #008cff; color: white; }
        .btn-red { background: #ff4141; color: white; }
        .link-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #333; }
        .wizard-box { background: #111; padding: 15px; border-left: 4px solid #008cff; margin-bottom: 20px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>[ RAAS-CF Admin Console ]</h1>
        
        <div class="section">
            <h3>Step 1: GitHub Discovery Wizard</h3>
            <div class="wizard-box">
                <p>To enable Auto-Sync, generate a token with <b>'repo'</b> and <b>'read:user'</b> scopes.</p>
                <a href="https://github.com/settings/tokens/new?description=RAAS-CF-AutoSync&scopes=repo,read:user" target="_blank">
                    <button class="btn-blue">1. Generate Token on GitHub</button>
                </a>
                <div style="margin-top: 15px;">
                    <input id="github_token" type="password" placeholder="2. Paste Token Here">
                    <button onclick="saveConfig({github_token: document.getElementById('github_token').value})">Save Token</button>
                </div>
            </div>
        </div>

        <div class="section">
            <h3>Step 2: Security</h3>
            <input id="new_pass" type="password" placeholder="New Admin Password">
            <button onclick="saveConfig({admin_pass: document.getElementById('new_pass').value})">Update Password</button>
            <p style="font-size: 11px; color: #888;">* Refresh page after update. Default login: admin / [your secret]</p>
        </div>

        <div class="section">
            <h3>Step 3: Redirect Management</h3>
            <input id="slug" placeholder="SLUG (e.g. autocut)">
            <input id="target" placeholder="TARGET URL" style="width: 350px;">
            <button onclick="addLink()">CREATE LINK</button>
            <button class="btn-blue" onclick="syncGitHub()" style="float: right;">GITHUB SYNC</button>
            
            <div class="link-list" id="link-list" style="margin-top: 20px;">
                <div>Loading active redirects...</div>
            </div>
        </div>
    </div>

    <script>
        async function fetchLinks() {
            const r = await fetch('/api/links');
            const links = await r.json();
            const container = document.getElementById('link-list');
            container.innerHTML = links.map(l => \`
                <div class="link-item">
                    <span><strong>/\${l.slug}</strong> → \${l.url}</span>
                    <button class="btn-red" onclick="deleteLink('\${l.slug}')">DEL</button>
                </div>
            \`).join('') || 'No manual redirects found.';
        }

        async function saveConfig(data) {
            const r = await fetch('/api/config', { method: 'POST', body: JSON.stringify(data) });
            if(r.ok) alert('Configuration Updated!');
        }

        async function addLink() {
            const slug = document.getElementById('slug').value;
            const target = document.getElementById('target').value;
            if(!slug || !target) return;
            await fetch('/api/links', { method: 'POST', body: JSON.stringify({ slug, target }) });
            document.getElementById('slug').value = '';
            document.getElementById('target').value = '';
            fetchLinks();
        }

        async function syncGitHub() {
            const btn = document.querySelector('.btn-blue[onclick="syncGitHub()"]');
            btn.innerText = 'SYNCING...';
            const r = await fetch('/api/sync', { method: 'POST' });
            const data = await r.json();
            if(data.success) alert('Synced ' + data.count + ' scripts from GitHub!');
            else alert('Sync failed: ' + data.error);
            btn.innerText = 'GITHUB SYNC';
        }

        async function deleteLink(slug) {
            if(!confirm('Delete ' + slug + '?')) return;
            await fetch('/api/links/' + slug, { method: 'DELETE' });
            fetchLinks();
        }

        fetchLinks();
    </script>
</body>
</html>
`;
