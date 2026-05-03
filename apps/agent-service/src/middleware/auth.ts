import { defineEventHandler } from "h3";
import { attachAuth } from "../lib/auth.js";

// Nitro `middleware/` runs before every route. `attachAuth` skips public
// routes (only /health for now) and verifies + attaches `event.context.auth`
// for everything else.
export default defineEventHandler(attachAuth);
