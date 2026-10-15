export type ElicitationValue = string | number | boolean | string[];
export type ElicitationValues = Record<string, ElicitationValue>;
export interface ElicitationField {
  name: string; type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string; description?: string; required: boolean; default?: ElicitationValue;
  enum?: string[]; enumNames?: string[]; format?: string; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; minItems?: number; maxItems?: number;
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function strings(value: unknown): string[] | undefined { return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined; }
function namedOptions(value: unknown): { values: string[]; labels: string[] } | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const options = value.map(record);
  if (options.some(option => !option || typeof option.const !== "string")) return undefined;
  return { values: options.map(option => option!.const as string), labels: options.map(option => typeof option!.title === "string" ? option!.title : option!.const as string) };
}
export function elicitationFields(schema: unknown): ElicitationField[] | undefined {
  const value = record(schema); const properties = record(value?.properties);
  if (value?.type !== "object" || !properties) return undefined;
  const required = strings(value.required) ?? [];
  const fields: ElicitationField[] = [];
  for (const [name, entry] of Object.entries(properties)) {
    const property = record(entry);
    if (!property || !["string", "number", "integer", "boolean", "array"].includes(String(property.type))) return undefined;
    const field: ElicitationField = { name, type: property.type as ElicitationField["type"], required: required.includes(name) };
    for (const key of ["title", "description", "format"] as const) if (typeof property[key] === "string") field[key] = property[key];
    for (const key of ["minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"] as const) if (typeof property[key] === "number") field[key] = property[key];
    const optionSchema = field.type === "array" ? record(property.items) : property;
    const named = namedOptions(optionSchema?.oneOf ?? optionSchema?.anyOf);
    const options = strings(optionSchema?.enum) ?? strings(property.enum);
    if (named) { field.enum = named.values; field.enumNames = named.labels; }
    else if (options) { field.enum = options; const names = strings(property.enumNames); if (names) field.enumNames = names; }
    if (field.type === "array" && !field.enum) return undefined;
    const defaultValue = property.default;
    if (typeof defaultValue === "string" || typeof defaultValue === "number" || typeof defaultValue === "boolean" || strings(defaultValue)) field.default = defaultValue as ElicitationValue;
    fields.push(field);
  }
  if (required.some(name => !properties[name])) return undefined;
  return fields;
}
export function elicitationDefaults(fields: ElicitationField[]): ElicitationValues {
  return Object.fromEntries(fields.filter(field => field.default !== undefined).map(field => [field.name, field.default!]));
}
export function elicitationDateTimeInput(value: ElicitationValue | undefined): string {
  if (typeof value !== "string" || !value) return "";
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23) : "";
}
export function elicitationContent(fields: ElicitationField[], values: ElicitationValues): ElicitationValues {
  const content: ElicitationValues = {};
  for (const field of fields) {
    const value = values[field.name]; const title = field.title ?? field.name;
    const empty = value === undefined || value === "" || Array.isArray(value) && value.length === 0;
    if (empty) { if (field.required) throw new Error(`请填写「${title}」`); continue; }
    if (field.type === "boolean") { if (typeof value !== "boolean") throw new Error(`「${title}」需要选择是或否`); content[field.name] = value; }
    else if (field.type === "number" || field.type === "integer") {
      const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
      if (!Number.isFinite(number) || field.type === "integer" && !Number.isInteger(number)) throw new Error(`「${title}」需要填写${field.type === "integer" ? "整数" : "数字"}`);
      if (field.minimum !== undefined && number < field.minimum || field.maximum !== undefined && number > field.maximum) throw new Error(`「${title}」超出允许范围`);
      content[field.name] = number;
    } else if (field.type === "array") {
      if (!Array.isArray(value) || value.some(option => !field.enum?.includes(option))) throw new Error(`「${title}」包含无效选项`);
      if (field.minItems !== undefined && value.length < field.minItems || field.maxItems !== undefined && value.length > field.maxItems) throw new Error(`「${title}」选择数量不符合要求`);
      content[field.name] = [...new Set(value)];
    } else {
      if (typeof value !== "string" || field.enum && !field.enum.includes(value)) throw new Error(`「${title}」的值无效`);
      if (field.minLength !== undefined && value.length < field.minLength || field.maxLength !== undefined && value.length > field.maxLength) throw new Error(`「${title}」长度不符合要求`);
      if (field.format === "date-time") {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) throw new Error(`「${title}」需要有效的日期和时间`);
        content[field.name] = date.toISOString();
      } else content[field.name] = value;
    }
  }
  return content;
}
