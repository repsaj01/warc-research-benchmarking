// Child-process entry used when running under tsx. Registers tsx's ESM
// loader via its supported programmatic API and then loads runner.ts.
// Avoids `node --import tsx` in the fork's execArgv, which trips tsx's
// --loader deprecation guard in some Node + tsx version combinations.

import { register } from "tsx/esm/api";

register();
await import("./runner.ts");
