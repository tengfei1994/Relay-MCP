/** Keep useful source citations without disclosing local server filesystem paths. */
export function publicSourceLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const source=value.trim();
  if (/^https?:\/\//i.test(source)) {
    try {
      const url=new URL(source);
      url.username="";url.password="";url.search="";
      return url.toString();
    } catch { return undefined; }
  }
  const prefix=source.startsWith("product-doc:") ? "product-doc:" : "";
  let path=prefix ? source.slice(prefix.length) : source;
  const fileUri=/^file:/i.test(path);
  if (fileUri) path=path.replace(/^file:\/\/*/i, "");
  const match=path.match(/^([^#?]*)(#[^?]*)?/), pathname=match?.[1] ?? "", fragment=match?.[2] ?? "";
  if (/^(?:[a-z]:[\\/]|[\\/]|\.\.[\\/])/i.test(pathname) || fileUri) {
    const name=pathname.split(/[\\/]+/).filter(Boolean).at(-1);
    return name ? `${prefix}${name}${fragment}` : undefined;
  }
  return prefix+pathname+fragment;
}
