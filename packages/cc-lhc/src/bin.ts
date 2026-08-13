#!/usr/bin/env node

import { installNodeSqliteWarningFilter } from "./startup-warnings.js";

// Node 24.3 supports every node:sqlite API used by cc-lhc, but it emits one
// experimental-status warning when the module loads. Install the exact filter
// before importing the CLI graph, which loads node:sqlite through LHC.
installNodeSqliteWarningFilter();
await import("./cli.js");
