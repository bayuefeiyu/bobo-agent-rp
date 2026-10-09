#!/usr/bin/env node
// The extension check intentionally shares the repository's strict typecheck.
// Keeping one implementation prevents a diagnostics-only check from drifting
// away from the real tsconfig and accidentally returning success.
import "./typecheck.mjs";
