# [ RAAS-CF ]

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/simon-msdos/RAAS-CF)

**Redirect-as-a-Service on Cloudflare Workers.**

A "pro" blueprint for managing short-links and installation scripts. Built for developers who want a custom vanity domain for their \`curl | bash\` installers and deep control over their redirects.

### ➔ Features
*   **KV-Backed:** Fast, globally distributed redirects.
*   **Admin UI:** Built-in terminal-style management interface.
*   **Management API:** Fully RESTful API for integration.
*   **Pattern Fallback:** Automatically resolves to GitHub raw content if no custom link is found.
*   **Portable:** One file, easy to deploy.

### ➔ Deployment
1.  **Clone & Install:** \`npm install\`
2.  **Create KV:** \`wrangler kv:namespace create REDIRECTS\`
3.  **Update \`wrangler.toml\`:** Paste your KV ID and change the \`GITHUB_USER\`.
4.  **Set Password:** \`wrangler secret put ADMIN_PASS\`
5.  **Deploy:** \`wrangler deploy\`

### ➔ Usage
*   **Redirect:** \`sh.yourdomain.com/my-tool\`
*   **Admin:** \`sh.yourdomain.com/admin\`
*   **API:** \`GET/POST /api/links\`

---
*Built for the physical and digital world.*
