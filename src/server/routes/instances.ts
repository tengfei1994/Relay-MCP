import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { discoverSampleManagerInstances } from "../../shared/samplemanager-discovery.js";
import { db } from "../db/index.js";
import { limsInstances, servers } from "../db/schema.js";
import { createManagedServerRunner } from "../remote-runner-factory.js";

const nullableText = z.string().nullish().transform((value) => value ?? "");
const arrayOf = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (value) => value == null ? [] : Array.isArray(value) ? value : [value],
    z.array(item)
  );

const ServiceSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const service = value as Record<string, unknown>;
  return {
    ...service,
    name: service.name ?? service.Name,
    displayName: service.displayName ?? service.DisplayName,
    state: service.state ?? service.State,
    startMode: service.startMode ?? service.StartMode,
    pathName: service.pathName ?? service.PathName,
  };
}, z.object({
  name: z.string().min(1),
  displayName: nullableText.default(""),
  state: nullableText.default(""),
  startMode: nullableText.default(""),
  pathName: nullableText.default(""),
}));

const BuildProfileSchema = z.object({
  kind: z.enum(["msbuild", "dotnet", "unknown"]).default("unknown"),
  selectedPath: z.string().optional().nullable(),
  selectedVersion: z.string().optional().nullable(),
  targetFramework: z.string().optional().nullable(),
  candidates: arrayOf(z.object({
    kind: z.enum(["msbuild", "dotnet"]),
    path: z.string(),
    version: nullableText,
  })).default([]),
});

const InstanceInputSchema = z.object({
  name: z.string().min(1).max(120),
  version: nullableText.pipe(z.string().max(120)).default(""),
  runtimeKind: z.enum(["framework", "dotnet", "unknown"]).default("unknown"),
  rootPath: z.string().min(1),
  exePath: z.string().min(1),
  formsPath: z.string().min(1),
  formsBinPath: z.string().min(1),
  solutionAssembliesPath: z.string().min(1),
  logfilePath: z.string().min(1),
  dataPath: z.string().min(1),
  databaseHost: nullableText.default(""),
  databaseName: nullableText.default(""),
  databaseAuthType: nullableText.default("unknown"),
  databaseConfigSource: nullableText.default(""),
  databaseProbe: z.object({
    status: z.enum(["verified", "unavailable", "failed"]),
    tableCount: z.number().int().nonnegative().optional(),
    columnCount: z.number().int().nonnegative().optional(),
    sampleManagerTableCount: z.number().int().nonnegative().optional(),
    score: z.number().optional().nullable(),
    schemaFingerprint: nullableText.optional(),
    error: nullableText.optional(),
    candidates: arrayOf(z.object({
      host: nullableText,
      name: nullableText,
      authType: nullableText,
      source: nullableText,
      sourceKind: z.enum(["instance-registry", "instance-config", "machine-inventory", "inferred-instance-name"]).optional(),
      associationRank: z.number().optional(),
      auxiliary: z.boolean().optional(),
      auxiliaryReason: nullableText.optional(),
      probeStatus: nullableText,
      tableCount: z.number().int().nonnegative().optional().nullable(),
      sampleManagerTableCount: z.number().int().nonnegative().optional(),
      score: z.number().optional(),
      error: nullableText.optional(),
    })).optional(),
  }).optional(),
  services: arrayOf(ServiceSchema).default([]),
  buildProfile: BuildProfileSchema.default({ kind: "unknown", candidates: [] }),
  confidence: z.number().min(0).max(100).optional(),
  warnings: arrayOf(z.string()).optional(),
  status: z.enum(["ready", "needs-review", "unavailable"]).optional(),
});

function mapInstance(row: typeof limsInstances.$inferSelect) {
  return {
    id: row.id,
    userId: row.userId,
    serverId: row.serverId,
    name: row.name,
    version: row.version ?? "",
    runtimeKind: row.runtimeKind ?? "unknown",
    rootPath: row.rootPath,
    exePath: row.exePath,
    formsPath: row.formsPath,
    formsBinPath: row.formsBinPath,
    solutionAssembliesPath: row.solutionAssembliesPath,
    logfilePath: row.logfilePath,
    dataPath: row.dataPath,
    databaseHost: row.databaseHost ?? "",
    databaseName: row.databaseName ?? "",
    databaseAuthType: row.databaseAuthType ?? "unknown",
    databaseConfigSource: row.databaseConfigSource ?? "",
    services: JSON.parse(row.servicesJson ?? "[]"),
    buildProfile: JSON.parse(row.buildProfileJson ?? "{}"),
    discovery: JSON.parse(row.discoveryJson ?? "{}"),
    status: row.status ?? "ready",
    lastDiscoveredAt: row.lastDiscoveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function valuesForInstance(userId: number, serverId: number, data: z.infer<typeof InstanceInputSchema>) {
  const now = new Date().toISOString();
  return {
    userId,
    serverId,
    name: data.name.trim(),
    version: data.version,
    runtimeKind: data.runtimeKind,
    rootPath: data.rootPath,
    exePath: data.exePath,
    formsPath: data.formsPath,
    formsBinPath: data.formsBinPath,
    solutionAssembliesPath: data.solutionAssembliesPath,
    logfilePath: data.logfilePath,
    dataPath: data.dataPath,
    databaseHost: data.databaseHost,
    databaseName: data.databaseName,
    databaseAuthType: data.databaseAuthType,
    databaseConfigSource: data.databaseConfigSource,
    servicesJson: JSON.stringify(data.services),
    buildProfileJson: JSON.stringify(data.buildProfile),
    discoveryJson: JSON.stringify({
      confidence: data.confidence,
      warnings: data.warnings ?? [],
      databaseProbe: data.databaseProbe,
    }),
    status: data.status ?? ((data.warnings?.length ?? 0) > 0 ? "needs-review" : "ready"),
    lastDiscoveredAt: now,
    updatedAt: now,
  };
}

export async function instanceRoutes(app: FastifyInstance) {
  app.get("/api/servers/:serverId/instances", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const server = db.select().from(servers)
      .where(and(eq(servers.id, Number(serverId)), eq(servers.userId, req.user.id))).get();
    if (!server) return reply.status(404).send({ error: "Server not found" });
    const rows = db.select().from(limsInstances)
      .where(and(eq(limsInstances.serverId, server.id), eq(limsInstances.userId, req.user.id))).all();
    return reply.send({ instances: rows.map(mapInstance) });
  });

  app.post("/api/servers/:serverId/instances/discover", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const body = z.object({ rootHints: z.array(z.string()).max(20).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "Invalid discovery options" });
    const server = db.select().from(servers)
      .where(and(eq(servers.id, Number(serverId)), eq(servers.userId, req.user.id))).get();
    if (!server) return reply.status(404).send({ error: "Server not found" });
    if (server.os !== "windows") return reply.status(400).send({ error: "SampleManager discovery requires a Windows server" });
    try {
      const runner = createManagedServerRunner(server);
      const instances = await discoverSampleManagerInstances(runner, body.data.rootHints ?? []);
      return reply.send({
        serverId: server.id,
        scannedAt: new Date().toISOString(),
        readOnly: true,
        instances,
      });
    } catch (error) {
      return reply.status(502).send({
        error: error instanceof Error ? error.message : "Instance discovery failed",
      });
    }
  });

  app.post("/api/servers/:serverId/instances", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { serverId } = req.params as { serverId: string };
    const body = InstanceInputSchema.safeParse(req.body);
    if (!body.success) {
      const summary = body.error.issues
        .map((issue) => `${issue.path.join(".") || "instance"}: ${issue.message}`)
        .join("; ");
      return reply.status(400).send({ error: `Invalid instance: ${summary}`, details: body.error.issues });
    }
    const server = db.select().from(servers)
      .where(and(eq(servers.id, Number(serverId)), eq(servers.userId, req.user.id))).get();
    if (!server) return reply.status(404).send({ error: "Server not found" });
    const existing = db.select().from(limsInstances)
      .where(and(eq(limsInstances.serverId, server.id), eq(limsInstances.name, body.data.name.trim()))).get();
    const values = valuesForInstance(req.user.id, server.id, body.data);
    const row = existing
      ? db.update(limsInstances).set(values).where(eq(limsInstances.id, existing.id)).returning().get()
      : db.insert(limsInstances).values(values).returning().get();
    return reply.status(existing ? 200 : 201).send({ instance: mapInstance(row) });
  });

  app.put("/api/instances/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = InstanceInputSchema.safeParse(req.body);
    if (!body.success) {
      const summary = body.error.issues
        .map((issue) => `${issue.path.join(".") || "instance"}: ${issue.message}`)
        .join("; ");
      return reply.status(400).send({ error: `Invalid instance: ${summary}`, details: body.error.issues });
    }
    const existing = db.select().from(limsInstances)
      .where(and(eq(limsInstances.id, Number(id)), eq(limsInstances.userId, req.user.id))).get();
    if (!existing) return reply.status(404).send({ error: "Instance not found" });
    const row = db.update(limsInstances)
      .set(valuesForInstance(req.user.id, existing.serverId, body.data))
      .where(eq(limsInstances.id, existing.id)).returning().get();
    return reply.send({ instance: mapInstance(row) });
  });

  app.delete("/api/instances/:id", { onRequest: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = db.select().from(limsInstances)
      .where(and(eq(limsInstances.id, Number(id)), eq(limsInstances.userId, req.user.id))).get();
    if (!existing) return reply.status(404).send({ error: "Instance not found" });
    db.delete(limsInstances).where(eq(limsInstances.id, existing.id)).run();
    return reply.send({ ok: true });
  });
}
