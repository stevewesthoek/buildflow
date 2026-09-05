export type StrictSchema = Record<string, unknown>

export type SchemaViolation = Readonly<{ class: string; path: string; expected: string }>
export type SchemaInspection = Readonly<{
  nodes: number
  properties: number
  consts: string[]
  strictObjects: number
  arraysWithItems: number
  nullable: string[]
  anyOf: number
  oneOf: number
  allOf: number
  violations: SchemaViolation[]
}>

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array'])

function isRecord(value: unknown): value is StrictSchema {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function inspectCodexStrictSchema(value: unknown, at = '$'): SchemaInspection {
  if (!isRecord(value)) return { nodes: 0, properties: 0, consts: [], strictObjects: 0, arraysWithItems: 0, nullable: [], anyOf: 0, oneOf: 0, allOf: 0, violations: [{ class: 'SCHEMA_NODE_NOT_OBJECT', path: at, expected: 'a schema object' }] }
  let nodes = 1
  let properties = 0
  const consts = Object.prototype.hasOwnProperty.call(value, 'const') ? [at] : []
  const violations: SchemaViolation[] = []
  const nullable: string[] = []
  const declaredTypes = typeof value.type === 'string' ? [value.type] : Array.isArray(value.type) && value.type.every(type => typeof type === 'string') ? value.type as string[] : []
  if (Object.prototype.hasOwnProperty.call(value, 'const')) violations.push({ class: 'CONST_UNSUPPORTED', path: `${at}.const`, expected: 'typed schema with enum for fixed values' })
  if (declaredTypes.length === 0 && !Object.prototype.hasOwnProperty.call(value, 'anyOf')) violations.push({ class: 'TYPE_MISSING_OR_INVALID', path: `${at}.type`, expected: 'one supported type or a supported anyOf schema' })
  for (const type of declaredTypes) if (!SUPPORTED_TYPES.has(type)) violations.push({ class: 'TYPE_UNSUPPORTED', path: `${at}.type`, expected: 'string, number, integer, boolean, null, object, or array' })
  if (Array.isArray(value.type)) {
    if (value.type.length !== 2 || !value.type.includes('null') || value.type.filter(type => type !== 'null').length !== 1 || value.type.some(type => typeof type !== 'string')) violations.push({ class: 'UNION_UNSUPPORTED', path: `${at}.type`, expected: '[primitive, "null"]' })
    else nullable.push(at)
  }
  if (Object.prototype.hasOwnProperty.call(value, 'oneOf')) violations.push({ class: 'ONEOF_UNSUPPORTED', path: `${at}.oneOf`, expected: 'type union or supported anyOf' })
  if (Object.prototype.hasOwnProperty.call(value, 'allOf')) violations.push({ class: 'ALLOF_UNSUPPORTED', path: `${at}.allOf`, expected: 'direct supported schema keywords' })
  if (Object.prototype.hasOwnProperty.call(value, 'anyOf')) {
    if (!Array.isArray(value.anyOf)) violations.push({ class: 'ANYOF_INVALID', path: `${at}.anyOf`, expected: 'array of schema objects' })
    else value.anyOf.forEach((branch, index) => { const nested = inspectCodexStrictSchema(branch, `${at}.anyOf[${index}]`); nodes += nested.nodes; properties += nested.properties; consts.push(...nested.consts); violations.push(...nested.violations); nullable.push(...nested.nullable) })
  }
  let strictObjects = 0
  let arraysWithItems = 0
  let anyOf = Object.prototype.hasOwnProperty.call(value, 'anyOf') ? 1 : 0
  let oneOf = Object.prototype.hasOwnProperty.call(value, 'oneOf') ? 1 : 0
  let allOf = Object.prototype.hasOwnProperty.call(value, 'allOf') ? 1 : 0
  if (declaredTypes.includes('object')) {
    if (value.additionalProperties !== false) violations.push({ class: 'ADDITIONAL_PROPERTIES_NOT_FALSE', path: `${at}.additionalProperties`, expected: 'false' })
    else strictObjects += 1
    if (!isRecord(value.properties)) violations.push({ class: 'OBJECT_PROPERTIES_MISSING', path: `${at}.properties`, expected: 'object' })
    if (!Array.isArray(value.required)) violations.push({ class: 'OBJECT_REQUIRED_MISSING', path: `${at}.required`, expected: 'array containing every property key' })
    if (isRecord(value.properties)) {
      properties += Object.keys(value.properties).length
      const required = Array.isArray(value.required) ? value.required : []
      for (const key of Object.keys(value.properties)) if (!required.includes(key)) violations.push({ class: 'MISSING_REQUIRED_PROPERTY', path: `${at}.required`, expected: `include ${key}` })
      for (const key of required) if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(value.properties, key)) violations.push({ class: 'REQUIRED_PROPERTY_UNKNOWN', path: `${at}.required`, expected: 'contain only declared property keys' })
      for (const [key, child] of Object.entries(value.properties)) { const nested = inspectCodexStrictSchema(child, `${at}.properties.${key}`); nodes += nested.nodes; properties += nested.properties; consts.push(...nested.consts); strictObjects += nested.strictObjects; arraysWithItems += nested.arraysWithItems; anyOf += nested.anyOf; oneOf += nested.oneOf; allOf += nested.allOf; violations.push(...nested.violations); nullable.push(...nested.nullable) }
    }
  }
  if (declaredTypes.includes('array')) {
    if (!isRecord(value.items)) violations.push({ class: 'ARRAY_ITEMS_MISSING', path: `${at}.items`, expected: 'a bounded supported item schema' })
    else { arraysWithItems += 1; const nested = inspectCodexStrictSchema(value.items, `${at}.items`); nodes += nested.nodes; properties += nested.properties; consts.push(...nested.consts); strictObjects += nested.strictObjects; arraysWithItems += nested.arraysWithItems; anyOf += nested.anyOf; oneOf += nested.oneOf; allOf += nested.allOf; violations.push(...nested.violations); nullable.push(...nested.nullable) }
  }
  return { nodes, properties, consts, strictObjects, arraysWithItems, nullable, anyOf, oneOf, allOf, violations }
}

export function validateCodexSchemaInstance(schema: StrictSchema, value: unknown, at = '$'): string | undefined {
  if (Array.isArray(schema.enum) && !schema.enum.some(candidate => JSON.stringify(candidate) === JSON.stringify(value))) return `${at}: enum mismatch`
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  if (value === null && types.includes('null')) return undefined
  if (types.includes('object') && (!value || typeof value !== 'object' || Array.isArray(value))) return `${at}: expected object`
  if (types.includes('array') && !Array.isArray(value)) return `${at}: expected array`
  if (types.includes('string') && typeof value !== 'string' && !types.includes('object') && !types.includes('array')) return `${at}: expected string`
  if (types.includes('integer') && (typeof value !== 'number' || !Number.isInteger(value)) && !types.includes('string')) return `${at}: expected integer`
  if (types.includes('number') && (typeof value !== 'number' || !Number.isFinite(value)) && !types.includes('integer')) return `${at}: expected finite number`
  if (types.length === 1 && types[0] === 'boolean' && typeof value !== 'boolean') return `${at}: expected boolean`
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${at}: below minimum`
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${at}: above maximum`
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) return `${at}: below minLength`
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `${at}: above maxLength`
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) return `${at}: pattern mismatch`
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${at}: below minItems`
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${at}: above maxItems`
    if (schema.uniqueItems === true && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return `${at}: duplicate items`
    if (isRecord(schema.items)) for (let index = 0; index < value.length; index += 1) {
      const failure = validateCodexSchemaInstance(schema.items, value[index], `${at}[${index}]`)
      if (failure) return failure
    }
  }
  if (isRecord(value) && types.includes('object')) {
    const properties = isRecord(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) for (const key of schema.required) if (!Object.prototype.hasOwnProperty.call(value, key)) return `${at}: missing ${String(key)}`
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) return `${at}: unknown property ${key}`
    for (const [key, child] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key) && isRecord(child)) {
      const failure = validateCodexSchemaInstance(child, value[key], `${at}.${key}`)
      if (failure) return failure
    }
  }
  return undefined
}
