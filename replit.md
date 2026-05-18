# Baccarat AI

A real-time baccarat prediction tool powered by a 50-AI ensemble voting system with full casino scoreboard rendering and statistical analysis.

## Run & Operate

- `pnpm --filter @workspace/baccarat-ai run dev` — run the frontend (auto-started via workflow)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite 7 + TailwindCSS 4
- State: localStorage persistence (`baccarat_ai_v6` key)
- No backend required — pure client-side logic

## Where things live

- `artifacts/baccarat-ai/src/App.tsx` — full app UI (~125KB, single-file component)
- `artifacts/baccarat-ai/src/lib/ai-engine.ts` — 50-agent voter system, pressure encoding, state-key memory
- `artifacts/baccarat-ai/src/lib/analysis.ts` — stochastic analysis engine, entropy, trap detection
- `artifacts/baccarat-ai/src/lib/scoreboards.ts` — Bead Road, Big Road, Big Eye Boy, Small Road, Cockroach Pig
- `artifacts/baccarat-ai/src/lib/types.ts` — all shared TypeScript types

## Architecture decisions

- All game state lives in `localStorage` — no database or server needed
- 50 AI voters each have independent state-key memory to track pattern accuracy
- The Big Road uses WoO-standard dragon-tail algorithm for overflow columns
- Derived roads (Big Eye Boy / Small Road / Cockroach Pig) use offset-based algorithm
- Trigger system fires alerts on configurable pattern conditions with cooldown hands

## Product

Users enter baccarat hand results (Banker/Player/Tie with final card numbers) and the AI ensemble votes on the next hand recommendation. The app tracks performance statistics, archives completed shoes, and renders casino-standard scoreboards in real time.

## User preferences

_Populate as you build._

## Gotchas

- The app is entirely frontend-only — do not add a backend dependency for game logic
- `baccarat_ai_v6` is the localStorage key; changing it resets all user data
- The AI engine uses pressure bands (LOW / HIGH / STRONG_HIGH / KILL_SHOT) based on final card numbers

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
