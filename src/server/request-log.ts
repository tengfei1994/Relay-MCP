import type { FastifyReply, FastifyRequest } from "fastify";
import type { LoggerOptions } from "pino";

/** Log request metadata without copying URL queries, headers or request bodies. */
export function requestLogSerializer(request: FastifyRequest) {
  const source = request.routeOptions?.url ?? request.url;
  let path = "/unknown";
  try { path = new URL(source, "http://request.invalid").pathname; } catch { /* do not echo malformed input */ }
  return { method: request.method, path, remoteAddress: request.ip, remotePort: request.raw?.socket?.remotePort };
}
function errorLogSerializer(error: unknown) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const type = typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(value.name) ? value.name : "Error";
  return { type, ...(typeof value.code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(value.code) ? { code: value.code } : {}), ...(typeof value.statusCode === "number" ? { statusCode: value.statusCode } : {}) };
}
// Pino permits custom shapes; Fastify's default-error shape requires message/stack.
export const safeRequestLogSerializers: NonNullable<LoggerOptions["serializers"]> = { req: requestLogSerializer, err: errorLogSerializer };
export const safeRequestLogHooks: NonNullable<LoggerOptions["hooks"]> = {
  logMethod(args, method) {
    const first = args[0];
    if (first instanceof Error || (first && typeof first === "object" && Object.hasOwn(first, "err"))) {
      // Fastify also copies err.message into msg, outside the err serializer.
      // Change only the log arguments; the original Error/response is untouched.
      method.apply(this, [first instanceof Error ? { err: first } : first, "Request failed"]);
    } else method.apply(this, args);
  },
};

/** Fastify's built-in 404 message logs the original URL including its query. */
export function sendSafeNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Not found" });
}
