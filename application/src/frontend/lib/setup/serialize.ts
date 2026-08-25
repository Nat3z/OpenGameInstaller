/** Remove reactive proxies before addon data crosses the RPC boundary. */
export function toSerializable<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}
