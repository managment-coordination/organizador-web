// Every interpolation is JSON data, never executable Python source.
export function pythonScript(strings, ...values) {
  return strings.reduce((source, part, index) => {
    if (index === values.length) return source + part;
    const value = values[index];
    if (value === "True" || value === "False") return source + part + value;
    JSON.parse(value);
    return source + part + `json.loads(${JSON.stringify(value)})`;
  }, "");
}
