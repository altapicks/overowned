[README.md](https://github.com/user-attachments/files/26848555/README.md)
# OverOwned Landing Page

Static single-page marketing site for OverOwned (https://overowned.io). Built as plain HTML/CSS/JS for fast loads and easy hosting.

## Structure

```
overowned-landing/
├── index.html              # The entire landing page
├── forms.html              # Hidden page for Netlify Forms detection
├── netlify.toml            # Netlify deploy config
├── logo.png                # Header logo (128×128)
├── favicon.ico             # Browser tab icon
├── apple-touch-icon.png    # iOS home screen icon
└── og-image.png            # Social share preview
```

## Deploying to Netlify

1. Create a new GitHub repo and push these files
2. On Netlify, click **"Add new site" → "Import an existing project"**
3. Connect to GitHub and pick this repo
4. Build command: leave blank. Publish directory: `.` (root)
5. Deploy — live on a `*.netlify.app` URL within a minute

## Connecting the domain (overowned.io)

Once your DNS has propagated:

1. Netlify → **Domain settings → Add a custom domain** → `overowned.io`
2. Follow Netlify's DNS instructions (either point nameservers to Netlify, or add an `ALIAS`/`A` record at your current DNS provider)
3. Netlify auto-provisions an SSL certificate

## Waitlist form (Netlify Forms)

The waitlist uses Netlify's built-in form handler — no external service needed.

- Submissions appear in **Netlify → Forms → waitlist**
- To get email notifications to `overowneddfs@gmail.com`:
  - Netlify → Forms → waitlist → Settings & usage → Form notifications → Add notification → Email notification

The hidden `forms.html` file is required so Netlify's build detects the form (since our live form submits via JavaScript, Netlify can't see it without this static reference).

## Making edits

Just edit `index.html` and push to GitHub. Netlify auto-deploys on every commit. Most changes (copy tweaks, price updates, new featured partners) are one-line edits — search for the text and replace it.

## Important sections to know

- **Hero headline** — lines ~430-435 of `index.html`
- **Featured by logos** — lines ~455-460
- **Feature cards** — lines ~471-520 (6 cards total)
- **Pricing** — lines ~530-580
- **Waitlist form** — lines ~620-640
- **Footer links** — lines ~650-660

## When the app is ready

The landing page links to `#features`, `#pricing`, and `#waitlist` (same-page anchors). When `app.overowned.io` goes live and you start taking payments, replace the "Join Waitlist" buttons' `href="#waitlist"` with `href="https://app.overowned.io"` (or a Stripe checkout link). Search for `#waitlist` in index.html.
