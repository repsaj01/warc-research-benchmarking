// Worker entry used when running under tsx (i.e. before `tsc` build).
// `tsx/esm/api`'s `register()` is the supported way to enable .ts imports
// inside a worker thread; using `node:module`'s register("tsx/esm", ...)
// trips tsx's --loader deprecation guard in tsx 4.x.

import { register } from "tsx/esm/api";

register();
await import("./worker-thread.ts");
