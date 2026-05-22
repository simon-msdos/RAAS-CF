export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.slice(1);

    const isAuthorized = (req) => {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return false;
      const [scheme, encoded] = authHeader.split(' ');
      if (!encoded || scheme !== 'Basic') return false;
      const decoded = atob(encoded);
      return decoded === `${env.ADMIN_USER}:${env.ADMIN_PASS}`;
    };

    if (path.startsWith('admin') || path.startsWith('api')) {
      if (!isAuthorized(request)) {
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

      if (url.pathname === '/api/sync' && request.method === 'POST') {
        const reposResponse = await fetch(`https://api.github.com/user/repos?per_page=100`, {
          headers: {
            'Authorization': `token ${env.GITHUB_TOKEN}`,
            'User-Agent': 'RAAS-CF-Worker'
          }
        });
        const repos = await reposResponse.json();
        const map = {};

        for (const repo of repos) {
          const contentsResponse = await fetch(`https://api.github.com/repos/${repo.full_name}/contents`, {
            headers: { 'Authorization': `token ${env.GITHUB_TOKEN}`, 'User-Agent': 'RAAS-CF-Worker' }
          });
          if (contentsResponse.ok) {
            const contents = await contentsResponse.json();
            const shFile = contents.find(f => f.name.endsWith('.sh'));
            if (shFile) {
              map[repo.name] = shFile.download_url;
            }
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
        body { background: #0a0a0a; color: #00ff41; font-family: 'Courier New', Courier, monospace; padding: 40px; line-height: 1.6; }
        .container { max-width: 800px; margin: 0 auto; border: 1px solid #00ff41; padding: 20px; box-shadow: 0 0 15px rgba(0, 255, 65, 0.2); }
        h1 { border-bottom: 1px solid #00ff41; padding-bottom: 10px; text-transform: uppercase; letter-spacing: 2px; }
        input { background: #1a1a1a; border: 1px solid #00ff41; color: #00ff41; padding: 8px; margin-right: 10px; width: 200px; }
        button { background: #00ff41; color: #000; border: none; padding: 8px 20px; cursor: pointer; font-weight: bold; text-transform: uppercase; }
        button:hover { background: #00cc33; }
        .sync-btn { background: #008cff; color: white; margin-left: 10px; }
        .link-list { margin-top: 30px; }
        .link-item { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #333; }
        .link-item:hover { background: #111; }
        .delete-btn { background: #ff4141; color: white; padding: 4px 10px; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>[ RAAS-CF Admin ]</h1>
        <p>Domain: ${domain}</p>
        
        <div style="margin-top: 20px;">
            <input id="slug" placeholder="SLUG">
            <input id="target" placeholder="TARGET URL" style="width: 300px;">
            <button onclick="addLink()">CREATE</button>
            <button class="sync-btn" onclick="syncGitHub()">GITHUB SYNC</button>
        </div>

        <div class="link-list" id="link-list">
            <div>Loading active redirects...</div>
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
                    <button class="delete-btn" onclick="deleteLink('\${l.slug}')">DEL</button>
                </div>
            \`).join('') || 'No custom redirects found.';
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
            const btn = document.querySelector('.sync-btn');
            btn.innerText = 'SYNCING...';
            const r = await fetch('/api/sync', { method: 'POST' });
            const data = await r.json();
            alert('Synced ' + data.count + ' scripts from GitHub!');
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
