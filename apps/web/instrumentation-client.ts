// Runs in the browser before the app's own code (Next.js `instrumentation-client`).
//
// zod probes once whether it may compile parsers with `new Function`. Under the pages' strict
// CSP (no 'unsafe-eval', plan §10.2) the probe is blocked and the browser reports a CSP
// violation, even though zod catches the error. `jitless` skips the probe: zod could never use
// eval under this CSP anyway, so nothing else changes.
import { config } from 'zod';

config({ jitless: true });
