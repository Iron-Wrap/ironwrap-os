import { config } from "zod";

/**
 * Production serves the app under `script-src 'self'` (public/_headers), which forbids the
 * `new Function` zod uses to compile a fast parser for each object schema, so the deployed app
 * has only ever parsed through zod's interpreted path. Saying so here keeps every environment on
 * that path: zod stops probing `new Function` (a strict CSP reports the caught probe as a
 * violation), and a page served without the CSP stops generating and compiling a parser for
 * every schema it reads once while the paired phone boots.
 *
 * zod fixes the choice per schema when the schema is built, so this has to run before any
 * contract module is evaluated: main.tsx imports it first, and vite.config.ts puts it in the
 * chunk that carries zod itself.
 */
config({ jitless: true });
