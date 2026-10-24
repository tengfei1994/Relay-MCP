import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KnowledgeStore } from "./store.js";
import type { SecretResolver } from "./provider-secret.js";

/** Credentials never appear in provider metadata or audit. The key is stored separately from SQLite. */
export class ProviderCredentialStore implements SecretResolver {
  private readonly keyFile: string;
  constructor(private readonly store: KnowledgeStore, keyFile = process.env.PROVIDER_SECRET_KEY_FILE) {
    this.keyFile = keyFile ?? join(dirname(store.db.name), ".provider-credentials.key");
  }

  private key(create = false): Buffer {
    try {
      if (!existsSync(this.keyFile) && create) {
        const existing = this.store.db.prepare("SELECT 1 FROM knowledge_provider_secrets LIMIT 1").get();
        if (existing) throw new Error("missing key");
        mkdirSync(dirname(this.keyFile), { recursive: true, mode: 0o700 });
        const temporary = this.keyFile + "." + randomUUID() + ".tmp";
        try {
          writeFileSync(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
          // Publish only a complete key; another Web/MCP process may win the race.
          try { linkSync(temporary, this.keyFile); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
      const key = readFileSync(this.keyFile);
      if (key.length !== 32) throw new Error("invalid key");
      return key;
    } catch {
      throw new Error("Provider credential key is unavailable; restore the original key file");
    }
  }

  save(token: string): string {
    if (!token.trim() || token.length > 8192 || /[\r\n\0]/.test(token)) throw new Error("Invalid provider token");
    const ref = "managed://" + randomUUID();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(true), nonce);
    cipher.setAAD(Buffer.from(ref));
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    this.store.db.prepare("INSERT INTO knowledge_provider_secrets(ref,ciphertext,nonce,tag) VALUES (?,?,?,?)")
      .run(ref, ciphertext, nonce, cipher.getAuthTag());
    return ref;
  }

  async resolve(ref: string): Promise<string | undefined> {
    if (!ref.startsWith("managed://")) return undefined;
    const row = this.store.db.prepare("SELECT ciphertext,nonce,tag FROM knowledge_provider_secrets WHERE ref=?").get(ref) as
      { ciphertext: Buffer; nonce: Buffer; tag: Buffer } | undefined;
    if (!row) throw new Error("Provider credential is unavailable");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(), row.nonce);
      decipher.setAAD(Buffer.from(ref));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Provider credential could not be decrypted; check the original key file");
    }
  }

  remove(ref: string | undefined): void {
    if (ref?.startsWith("managed://")) this.store.db.prepare("DELETE FROM knowledge_provider_secrets WHERE ref=?").run(ref);
  }
}
