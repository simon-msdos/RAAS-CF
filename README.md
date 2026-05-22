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
1.  **Clone & Install:** `npm install`
2.  **Create KV:** `wrangler kv:namespace create REDIRECTS`
3.  **Update \`wrangler.toml\`:** 
    *   Paste your KV ID in the `[[kv_namespaces]]` section.
    *   Set your custom domain in the `routes` section.
    *   Update the `[vars]` with your GitHub username and site.
4.  **Set Secrets (CRITICAL):**
    ```bash
    # Set your admin password for the /admin panel
    wrangler secret put ADMIN_PASS

    # Optional: Set your GitHub token for Auto-Sync
    wrangler secret put GITHUB_TOKEN
    ```
5.  **Deploy:** `wrangler deploy`

### ➔ Security Notes
*   **Never commit your KV ID or secrets to GitHub.** The `wrangler.toml` in this repo uses placeholders.
*   **Basic Auth:** The `/admin` and `/api` routes are protected by Basic Auth using `ADMIN_USER` and `ADMIN_PASS`.
*   **Custom Domain:** Ensure your domain is managed by Cloudflare to use the `custom_domain = true` feature.


### ➔ Usage
*   **Redirect:** \`sh.yourdomain.com/my-tool\`
*   **Admin:** \`sh.yourdomain.com/admin\`
*   **API:** \`GET/POST /api/links\`

---
*Built for the physical and digital world.*
