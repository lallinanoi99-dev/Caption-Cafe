# Caption Café

Tell the café what you're selling. AI brews a deck of four ready-to-post social captions, you serve your favourite on BOT Chain, and the community sips the best ones onto Today's Specials.

*Copy-paste responsibly. Nothing is posted to social media for you. No tokens, no payments, no admin, no personal data.*

## Status

| | |
|---|---|
| Live site | https://captioncafe.my.id (GitHub Pages: https://lallinanoi99-dev.github.io/Caption-Cafe/) |
| AI Worker | _not deployed yet_ |
| Contract (BOT Chain mainnet, chain ID 677) | [`0x9c95425b4EB4a12A3952F5A855382Cdc162cd7e1`](https://scan.botchain.ai/address/0x9c95425b4EB4a12A3952F5A855382Cdc162cd7e1) |
| Contract (testnet, chain ID 968) | _not deployed yet_ |

## Project layout

- `index.html`: the whole frontend (ethers.js v6 from CDN, no build step)
- `contracts/CaptionCafe.sol`: the contract (Solidity ^0.8.20)
- `deploy.html`: one-click deploy from MetaMask, testnet or mainnet
- `build/`: compiled ABI and bytecode, plus the standard JSON input for explorer verification
- `worker/`: the AI proxy (Cloudflare Worker, `POST /captions`)
- `tools/`: scripts that compile and test the contract and check the frontend against it
- `images/`: the BOT Chain logo for the footer

## Run locally

```bash
python3 -m http.server 4607
```

Then open http://localhost:4607. Two things are switched off until you configure them, and the site stays fully usable without either:

- **No contract address** → *preview mode*: Today's Specials is seeded with demo captions, and serving and sipping are saved in this browser's localStorage, so every screen can be reviewed before deploying. Without MetaMask it uses a preview wallet. Add `?reset` to start over.
- **No AI Worker URL** → decks come from the built-in tone templates and carry a "House blend" label. The same templates are the fallback when the AI fails or takes longer than 8 seconds.

Both are set in the `CONFIG` block at the top of the script in `index.html`.

## 1. Deploy the contract

Compiled with Solidity 0.8.20, optimizer 200 runs, EVM `paris`. The constructor takes no arguments.

1. Run the site locally and open http://localhost:4607/deploy.html in a browser with MetaMask.
2. Click **Deploy to Testnet (968)**, confirm in MetaMask, then try the app at http://localhost:4607/?net=testnet. On localhost the app picks up the address you just deployed.
3. Click **Deploy to Mainnet (677)**.
4. Paste each address into the matching `contract: ''` field in `CONFIG.networks` in `index.html`, and into the Status table above. The mainnet `contract` is the one constant that feeds the app, the footer address and the explorer link.

Or use Remix: paste `contracts/CaptionCafe.sol` into https://remix.ethereum.org, compile with 0.8.20 and EVM version `paris`, deploy with *Injected Provider – MetaMask*.

| Network | Chain ID | RPC | Explorer |
|---|---|---|---|
| Testnet | 968 | https://rpc.bohr.life | https://scan.bohr.life |
| Mainnet | 677 | https://rpc.botchain.ai | https://scan.botchain.ai |

To verify the source on the explorer, use "Standard JSON input" with `build/CaptionCafe.standard-input.json` and compiler `v0.8.20+commit.a1b79de6`.

## 2. Deploy the AI Worker

The Worker holds the Anthropic API key as a secret, so it never reaches the browser.

```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Before deploying, edit `worker/wrangler.toml`:

- `ALLOWED_ORIGINS`: your live site origin(s), comma-separated, no trailing slash. Requests from any other origin get a 403.
- `MODEL`: the Claude model that writes the captions. The default is `claude-opus-5-5` at low effort; `claude-haiku-5-5` is the cheapest option.

Then paste the Worker URL plus `/captions` into `CONFIG.aiUrl` in `index.html`.

The Worker limits each IP to 20 brews per hour. By default the count is kept in memory per Worker instance; bind a KV namespace as `RATE_KV` (see `wrangler.toml`) to make it hold across instances. On the larger models it turns on Anthropic's server-side refusal fallback (`fallbacks: "default"`), so a declined request is retried on a fallback model in the same call.

`POST /captions` is self-contained, so the route can also be merged into an existing shared Worker.

## 3. Publish the site

GitHub Pages serves the `gh-pages` branch, so publish with `git push origin main:gh-pages` after pushing `main` (or switch the Pages source to `main` under Settings → Pages). For a custom domain, add it under Settings → Pages, which creates the `CNAME` file. Remember to add the final origin to `ALLOWED_ORIGINS` and redeploy the Worker.

## How it works

- **Brew:** the order (business name, product, audience, 1–5 tones, one platform) goes to the Worker, which asks Claude for four captions as structured JSON `{ captions: [{ text, hashtags, tone }] }`. The Worker strips stray hashtags out of the text, drops trailing hashtags until each caption fits, and rejects anything malformed so the site falls back to the house blend.
- **Limits:** caption text plus hashtags must fit the platform: X 280 characters (up to 3 hashtags), Instagram and TikTok 300 (up to 8). On-chain, business + text + hashtags must fit in 320 bytes and the business name in 40 bytes. Cards are editable; over a limit the counter turns red and Serve is disabled until trimmed.
- **Serve:** `serve(business, text, hashtags, platform, tone)` stores the caption with the sender and a timestamp, a public record of who posted the line first. Platform is 0 Instagram · 1 TikTok · 2 X; tone is 0 Playful · 1 Cosy · 2 Bold · 3 Luxe · 4 Funny.
- **Sip:** `sip(id)` once per wallet per caption; you can sip your own. The board sorts by sips, then newest.
- **Reads:** the site reads through the public RPC without a wallet: `total()`, `getCaptions(from, count)` in pages of 100, `getCaption(id)` for `?caption=ID` share links, and `sippedBy(wallet, from, count)` for the "☕ Sipped" state. My menu filters the board by the connected wallet (`captionsOf(chef)` is also available).
- **Events:** `Served(id, chef, platform)`, `Sipped(id, by, sips)`.

## Tests

```bash
npm --prefix tools install
node tools/compile.mjs
node tools/test-contract.mjs   # every rule in the contract, on an in-memory chain
node tools/check-frontend.mjs  # the ABI in index.html matches the contract; the site's calls work
npm --prefix worker install && npm --prefix worker test   # AI Worker, with the Anthropic API stubbed
```
