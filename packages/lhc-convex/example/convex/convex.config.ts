import { defineApp } from "convex/server";
import lhc from "@liminal/lhc-convex/convex.config.js";

const app = defineApp();
app.use(lhc);

export default app;
