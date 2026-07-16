/// <reference types="vite/client" />
import type { GenericSchema, SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
import schema from "../convex/schema.js";

const modules = import.meta.glob("../convex/**/*.ts");

export function register(test: TestConvex<SchemaDefinition<GenericSchema, boolean>>, name = "lhc"): void {
  test.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
