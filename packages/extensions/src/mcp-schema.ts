import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** Compile locally; never resolve remote schema URLs or coerce tool arguments. */
export function compileMcpInput(schema: Record<string, unknown>): (input: unknown) => boolean {
  try {
    const options = { strict: false, validateSchema: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, logger: false as const };
    const validator = typeof schema.$schema === "string" && schema.$schema.includes("2020-12") ? new Ajv2020(options) : new Ajv(options);
    addFormats(validator);
    const validate = validator.compile(schema);
    return input => validate(input) === true;
  } catch { throw new Error("Invalid MCP input schema"); }
}
