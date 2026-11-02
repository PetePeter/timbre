# Timbre

AI phone manager: one Node server that connects LLMs (OpenAI-compatible API, or a CLI in a PTY) to real phones via telefony-app (PhAP), and serves one Vue web UI to desktop, LAN and phone browsers. See [README.md](README.md).

## Layout

| Path | What |
|------|------|
| `src/phone/` | Ported from Helm `feat/phapsupport`: PhAP client, PhoneBridge, reception, call agent, telefony process/installer |
| `src/session/` | Ported Helm pieces the phone code needs: agent loop, ChatBridge types |
| `src/config/timbre-config.ts` | Phones + LLMs + web settings; the YAML store in the per-user data dir |
| `src/agents/` | `ApiAgent`, `CliAgent` (node-pty), shared phone tools |
| `src/hub.ts` | One PhoneLineService + agent per phone; sessionId = phone id |
| `src/server/` | HTTP API, auth, static UI, minimal MCP endpoint, entry `main.ts` |
| `web/` | Vue 3 UI (Vite → `dist/web`) |
| `eval/` | Model eval: scripted far-end call scenarios through the real bridge/agents; `npm run eval` writes report + `sft.jsonl` to `dataDir()/eval` |

## Invariants

1. **Never write to the repo.** Config, transcripts and telefony.toml go to `dataDir()`.
2. **Localhost is trusted, LAN needs the token**, and cross-origin writes are refused. Do not add an unauthenticated route.
3. **Each phone is isolated.** It has its own telefony port, data folder and MCP token, and a token only acts on its own phone.
4. **Phone text is untrusted.** Quoted speech and SMS stay data (PhoneBridge `untrusted()`).
5. **PTY errors are logged, never thrown.**
6. **The phone tool list is defined once** in `PHONE_TOOLS`. API agents and MCP both use it.

## Build & test

```bash
npm test        # Vitest
npm run build   # vue-tsc + Vite (web) + tsc (server)
npm start       # build + run on :7790
```

Tests use real classes, with fakes only at the hardware edge (the PhAP fake server and fake phone lines). The PTY test spawns a real shell.
