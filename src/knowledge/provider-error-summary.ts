/** Derive bounded, fixed diagnostics; never return upstream message text. */
export const providerFailureReasons = {
  channel_unavailable: "Gateway reports no available channel for this model",
  quota_exceeded: "Gateway reports insufficient quota or balance",
  authentication_failed: "Gateway reports an authentication failure",
  model_unavailable: "Gateway reports the model is unavailable",
  rate_limited: "Gateway reports a rate limit",
  upstream_connection_failed: "Gateway reports a connection failure to its upstream",
  upstream_http_error: "Gateway reports an HTTP error from its upstream",
  invalid_request: "Gateway reports an invalid request",
  upstream_error: "Gateway reports an upstream error",
} as const;

const codes = {
  no_available_channel: "channel_unavailable", channel_not_found: "channel_unavailable", channel_no_available_key: "channel_unavailable",
  insufficient_quota: "quota_exceeded", quota_exceeded: "quota_exceeded", insufficient_user_quota: "quota_exceeded",
  invalid_api_key: "authentication_failed", invalid_token: "authentication_failed", token_expired: "authentication_failed",
  model_not_found: "model_unavailable", model_not_supported: "model_unavailable", invalid_model: "model_unavailable",
  rate_limit_exceeded: "rate_limited", rate_limit_error: "rate_limited",
  do_request_failed: "upstream_connection_failed", upstream_connection_failed: "upstream_connection_failed",
  bad_response_status_code: "upstream_http_error",
  invalid_request_error: "invalid_request", invalid_request: "invalid_request",
  upstream_error: "upstream_error", server_error: "upstream_error",
} as const;

/** Reuse the exact diagnostic code allowlist at persistence boundaries. */
export function isProviderErrorCode(value: unknown): value is keyof typeof codes {
  return typeof value === "string" && Object.hasOwn(codes, value);
}

export interface UpstreamErrorSummary {
  upstreamErrorCode?: keyof typeof codes;
  upstreamReportedStatus?: number;
  reason?: keyof typeof providerFailureReasons;
  upstreamRequestId?: string;
}

export function safeProviderRequestId(value: unknown, token?: string, requestBody?: string): string | undefined {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)) return undefined;
  if (requestBody?.includes(value)) return undefined;
  const secrets = token ? [token, encodeURIComponent(token), Buffer.from(token).toString("base64"), Buffer.from(token).toString("base64url")] : [];
  return secrets.some((secret) => value.includes(secret)) ? undefined : value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function summarize(body: unknown, token?: string, requestBody?: string): UpstreamErrorSummary {
  const root = record(body);
  const error = record(root?.error) ?? root;
  if (!error) return {};
  const result: UpstreamErrorSummary = {};
  for (const value of [error.code, error.type]) {
    if (typeof value === "string" && Object.hasOwn(codes, value) && safeProviderRequestId(value, token)) {
      result.upstreamErrorCode = value as keyof typeof codes;
      result.reason = codes[result.upstreamErrorCode];
      break;
    }
  }
  const message = typeof error.message === "string" ? error.message : "";
  if (!result.reason || result.reason === "upstream_http_error" || result.reason === "upstream_error") {
    const patterns: Array<[RegExp, keyof typeof providerFailureReasons]> = [
      [/no available channel|no eligible channel|无可用渠道|没有可用.*渠道/i, "channel_unavailable"],
      [/insufficient.{0,20}(quota|balance)|quota.{0,20}exceeded|余额不足|额度不足/i, "quota_exceeded"],
      [/invalid.{0,10}(api.key|token)|incorrect api key|令牌无效|无效.*令牌/i, "authentication_failed"],
      [/model.{0,30}(not found|not supported|does not exist)/i, "model_unavailable"],
      [/rate.limit|too many requests/i, "rate_limited"],
      [/connection refused|dial tcp|proxyconnect|tls handshake|certificate verify failed|no such host/i, "upstream_connection_failed"],
    ];
    const matched = patterns.find(([pattern]) => pattern.test(message))?.[1];
    if (matched) result.reason = matched;
  }
  if (result.upstreamErrorCode === "bad_response_status_code" && /^[45]\d{2}$/.test(String(error.param ?? ""))) result.upstreamReportedStatus = Number(error.param);
  const embeddedIds = [...message.matchAll(/request[ _-]?id\s*[:=]\s*([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127})(?=$|[\s)\],;])/gi)];
  for (const value of [root?.request_id, root?.requestId, error.request_id, error.requestId, embeddedIds.at(-1)?.[1]]) {
    const id = safeProviderRequestId(value, token, requestBody);
    if (id) { result.upstreamRequestId = id; break; }
  }
  return result;
}

export async function readProviderErrorSummary(response: Response, token?: string, requestBody?: string): Promise<UpstreamErrorSummary> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("diagnostic deadline")), 1000); });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) return {};
      chunks.push(value);
    }
    return summarize(JSON.parse(Buffer.concat(chunks).toString("utf8")), token, requestBody);
  } catch {
    // Diagnostics are best effort: preserve the original HTTP error.
    return {};
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
