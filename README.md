# PageFrame

Free, public website screenshot tool. Paste any URL, pick devices, get full-page
screenshots of every page, download them all as a ZIP. No sign-up, nothing stored.

**Stack:** Next.js 16 · React 19 · TypeScript · Tailwind CSS 4 · Puppeteer + @sparticuz/chromium · fflate
**Hosting:** Vercel (free Hobby plan works)

## Deploy to Vercel (free, no card)

1. Push this folder to a GitHub repository.
2. Go to vercel.com → sign in with GitHub → **Add New → Project** → pick the repository.
3. Click **Deploy**. No settings to change.
4. Done. Your tool is live at `your-project.vercel.app`. Add your own domain under
   **Settings → Domains** if you like.

Every `git push` redeploys automatically.

## Run on your own computer

    npm install
    npm run dev

Open http://localhost:3000. It uses the Chrome or Edge already installed on your computer.
If it can't find it, set `CHROME_PATH` in `.env.local` to your browser's .exe path.

## How it works

```
Browser (your visitor)                      Vercel
─────────────────────                       ──────
1. Lists the pages to capture  ──────────►  /api/discover  (WordPress mode only)
2. Asks for screenshots, 3 at a time ────►  /api/shot      one screenshot per request
3. Keeps the images in memory  ◄─ JPEG ───  (Chromium, reused while the server is warm)
4. Builds the ZIP itself
```

Each screenshot is one short request (about 4 to 10 seconds), so it fits comfortably inside
Vercel's function limits. The server keeps nothing: no database, no files, no accounts.

## Settings (optional environment variables)

| Variable | Default | What it does |
|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | PageFrame | Name in the header and browser tab |
| `NEXT_PUBLIC_MAX_SITES` | 20 | Websites per run |
| `NEXT_PUBLIC_MAX_SHOTS` | 150 | Screenshots per run |
| `SHOTS_PER_IP_PER_10_MIN` | 120 | Speed bump per visitor (per server instance) |
| `MAX_PAGE_HEIGHT` | 16000 | Longest page height captured, in pixels |
| `CHROME_PATH` | auto | Local Chrome path, for `npm run dev` only |

Set them in Vercel under **Settings → Environment Variables**, then redeploy.

## Free plan limits to know about

Vercel's free Hobby plan includes 4 hours of active CPU per month. A screenshot uses
roughly 3 to 6 seconds of CPU, so expect around **2,000 to 4,000 screenshots a month** for free.
If the free usage runs out, Vercel pauses the functions until the next month; you are never
charged on Hobby. The Hobby plan is for non-commercial use; move to Pro if you start charging.

For a stricter limit per visitor, add a rate-limit rule in Vercel under **Firewall**.

## Security

- Every address the page loads is checked, so nobody can screenshot private or internal networks.
- Ads and trackers are blocked by default.
- Each screenshot starts with no cookies from any other visitor.

## Project layout

    src/app/page.tsx                 the page
    src/components/screenshot-app.tsx  form + capture queue (runs in the browser)
    src/components/results.tsx       results grid, viewer, ZIP download
    src/app/api/shot/route.ts        takes one screenshot
    src/app/api/discover/route.ts    finds WordPress key pages
    src/lib/capture.ts               screenshot logic (lazy images, animations, popups)
    src/lib/browser.ts               starts Chromium (serverless or local)
    src/lib/guard.ts                 blocks private network addresses
    src/lib/devices.ts               device profiles
