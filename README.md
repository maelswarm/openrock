# Open Rock

<img width="2560" height="1540" alt="image" src="https://github.com/user-attachments/assets/02b1006c-6a43-4ecb-9938-49543af013ab" />

One chat app for every AWS Bedrock model and your own Gemma servers. It runs as a website or as a desktop app (Tauri), and both use the same interface.

- **Variable**: Amazon Bedrock, billed per token. Sign in with a Bedrock API key and the model dropdown lists every chat model Bedrock offers in your region, including legacy ones such as Gemma 3 until AWS retires them, plus any provisioned throughput, custom model deployments, imported models and Bedrock Marketplace endpoints (where most Gemma variants live) you've set up. Cross-region inference profiles are picked automatically. You can also add your own model IDs or ARNs.
- **Dedicated**: your own Gemma servers, always over HTTPS. Add as many as you like in Settings → Dedicated, each with a hostname or IP address, an HTTPS port (443 by default) and its own token. In a chat, the menu at the top picks which server it goes to.

Settings are per model. In Settings → Variable, pick a model to see only the settings it takes, within its limits: max output, temperature, Top P and Top K where the model has them, stop sequences, and the kind of thinking it does (a thinking budget for Claude 3.7 to 4.5, thinking and effort for Claude 4.6 to 5, effort alone for models that always think, reasoning effort for gpt-oss). Models without their own settings use the ones for all models. In Settings → Dedicated, each server has its own context size, max output, history trimming, sampling (temperature, top-p/k, min-p, penalties, seed, stop), system prompt handling, streaming, Ollama options and extra request JSON, next to what the server reports about its model. The sliders button next to the model menu opens the current model's settings.

You switch between the two with the Variable/Dedicated switch at the top of the sidebar.

Both modes accept file uploads. What gets sent depends on the model:

| | Bedrock models | Gemma |
|---|---|---|
| Images (PNG, JPEG, GIF, WebP; others are converted) | Vision models only | When "Images" is on |
| PDF, Word, Excel | Sent as files to models that accept them; otherwise sent as extracted text | Extracted text |
| PowerPoint, code, text, CSV, JSON, Markdown… | Inlined as text | Inlined as text |
| Video | Nova models | Not supported |

Large photos are shrunk before upload. The paperclip picker only offers file types the selected model can use.

The **Usage** page shows Bedrock usage per model: requests, input, output and cached tokens, latency, errors, and estimated cost. You can view the last 24 hours or the last 7, 30 or 90 days. Costs come from an editable price table in Settings; it starts with list prices for common models.

## Layout

```
shared/     types and helpers used by both sides
server/     API server (Node + Hono): Bedrock, Gemma, files, chats, usage
web/        React interface (Vite)
src-tauri/  desktop shell; runs the server as a bundled sidecar
scripts/    build-sidecar.mjs compiles the server into one executable for the desktop app
```

The browser never sees your Bedrock API key or the Gemma token. Both stay in the server process. On the desktop, that server is a private sidecar on a random localhost port, protected by a random access token.

## Setup

Requires Node 20 or newer.

```bash
npm install
```

Everything is set up in Settings:

- **Settings → Variable**: your Amazon Bedrock API key.
- **Settings → Dedicated**: **Add server** for each Gemma server, with its hostname or IP address, HTTPS port and token.

Keys and tokens are stored by the Open Rock server and never shown again in the browser. If you prefer environment files, copy `.env.example` to `.env`. It can hold `AWS_BEARER_TOKEN_BEDROCK`, used when the Settings field is empty, and one Gemma server (`OPEN_ROCK_DEDICATED_HOST` and `OPEN_ROCK_DEDICATED_TOKEN`) that starts the server list on first run. That token is only ever sent to that host. `.env` is git-ignored and only the server reads it.

## Website

Development (API on :8787, interface on :5173 with hot reload):

```bash
npm run dev
```

Open http://localhost:5173.

Production:

```bash
npm run build
npm start                     # serves the site and API on http://127.0.0.1:8787
```

To make the site reachable from other machines, set `OPEN_ROCK_HOST=0.0.0.0` **and** `OPEN_ROCK_AUTH_TOKEN=<long random string>`. With a token set, the site asks for it before showing anything. Put it behind HTTPS (for example Caddy or an AWS load balancer).

Docker:

```bash
docker build -t open-rock .
docker run -p 8787:8787 --env-file .env -e OPEN_ROCK_AUTH_TOKEN=change-me -v open-rock-data:/data open-rock
```

Chats, uploads, settings and usage are stored in `~/.open-rock` (or `OPEN_ROCK_DATA_DIR`).

## Desktop (Tauri)

You need:

- Rust (stable) from https://rustup.rs
- On Windows, the "Desktop development with C++" workload from Visual Studio Build Tools. WebView2 ships with Windows 10 and 11.
- On macOS and Linux, the platform packages listed at https://tauri.app/start/prerequisites/

Commands:

```bash
npm run desktop:dev      # run the desktop app with hot reload
npm run desktop:build    # build installers
```

Installers end up in `src-tauri/target/release/bundle/`. On Windows that's an `.msi` and an NSIS `.exe`.

`npm run build:sidecar` compiles the server into `src-tauri/binaries/` with Bun (installed by `npm install`). If `.env` names a Gemma server, it's baked into the binary and starts the server list on first run. Otherwise add servers in Settings → Dedicated; they're saved on that machine. Run the build again after changing server code or `.env`. `desktop:build` does this for you.

The desktop app keeps its data in the OS app-data folder; on Windows that's `%APPDATA%\com.openrock.desktop`. A `.env` placed there overrides the baked-in values.

## Tests

```bash
npm test
```

The tests run the server against local stand-ins for Bedrock and Gemma servers. They cover model listing and inference profiles, streaming, API-key auth, file handling, retries for models that reject system prompts or files, several dedicated servers, context trimming, the Ollama protocol and the usage report.

## Notes and troubleshooting

- **HTTPS for Gemma.** Open Rock only talks to Gemma servers over HTTPS, and it accepts any certificate: self-signed, expired or not yet valid, issued for another name or by a private CA, weak keys and old signature hashes, and servers that only speak TLS 1.0 or 1.1. Traffic is encrypted, but the certificate isn't used to verify the server's identity; Bedrock connections are checked normally. The one exception is the desktop app, whose TLS library can't use secp256k1 keys at all; no common server or browser uses them. With nginx in front of Ollama, a working server block looks like this:

  ```nginx
  server {
      listen 443 ssl;
      ssl_certificate     /etc/nginx/ssl/gemma.crt;   # self-signed is fine
      ssl_certificate_key /etc/nginx/ssl/gemma.key;

      location / {
          if ($http_authorization != "YOUR_TOKEN") {
              return 401 "Unauthorized\n";
          }
          proxy_pass http://127.0.0.1:11434;
          proxy_http_version 1.1;
          proxy_set_header Host localhost:11434;   # Ollama refuses other Host values
          proxy_read_timeout 600s;
          proxy_buffering off;   # stream replies as they're generated
      }
  }
  ```

  This config expects the bare token in `Authorization`, with no `Bearer` prefix. Open Rock detects that by itself, or you can pin it under **Send the token as → Authorization: <token>**. Without `proxy_buffering off`, nginx holds the whole reply and sends it at the end. Keep `Host localhost:11434`: Ollama listening on 127.0.0.1 answers a bare 403 to any request whose Host isn't localhost or one of the machine's own addresses, and an AWS Elastic IP isn't one of them. This is the setup Ollama's own FAQ shows. To make a certificate: `sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout /etc/nginx/ssl/gemma.key -out /etc/nginx/ssl/gemma.crt -subj "/CN=gemma"` (any name works, since Open Rock doesn't check it). In the security group, open 443 and close the Ollama and old proxy ports to the internet.
- **A Gemma server shows "Offline".** Each server's card in Settings → Dedicated has its own status. The message says what went wrong: a port that doesn't speak HTTPS, a failed handshake, a timeout or a refused token. When the token is refused, open **What the server answered** under the status: it shows each request, the HTTP code, the server software and the response body (with your token blanked out). By default Open Rock sends the token as `Authorization: Bearer`, and if that's refused it also tries `X-API-Key`, `Authorization` without a prefix, and `api-key`. You can pin one under **Send the token as**. A `WWW-Authenticate: Basic` answer means the proxy wants a username and password, not a token. Check that the instance and the proxy are running and that the security group allows inbound TCP 443 (or your port) from your IP. Open Rock detects whether the server speaks the OpenAI-compatible API (vLLM, llama.cpp, TGI) or Ollama's API. You can force one under Settings → Dedicated → Protocol.
- **Context size.** With Ollama, the context size is sent as `num_ctx`. vLLM and llama.cpp fix the context size when the server starts, so set the same number in Settings. The status panel shows the size the server reports when it exposes one.
- **Bedrock "access denied".** Some models need a one-time enablement or use-case form in the Bedrock console. Short-term Bedrock API keys expire after 12 hours or less.
- **Token counts.** Bedrock reports exact counts. For Gemma, the context meter estimates until the server returns real counts.
