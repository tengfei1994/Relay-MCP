import { join } from 'node:path';

export function managedEngineEnv(config, home, inherited = process.env) {
  const port = new URL(config.baseUrl).port;
  // Deliberate allowlist: Relay provider keys and unrelated deployment secrets are not inherited.
  const env = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (inherited[name]) env[name] = inherited[name];
  return { ...env, HOME: join(home, 'data', 'home'), GIN_MODE: 'release', LOG_LEVEL: 'warn', LLM_DEBUG_LOG: 'false', WEKNORA_LLM_STREAM_RAW_DUMP: 'false', SERVER_HOST: '127.0.0.1', SERVER_PORT: port,
    JIEBA_DICT_DIR: join(config.releasePath, 'dict'), DUCKDB_SKIP_EXTENSION_LOAD: '1',
    DB_DRIVER: 'sqlite', DB_PATH: join(home, 'data', 'weknora.db'), RETRIEVE_DRIVER: 'sqlite',
    STORAGE_TYPE: 'local', LOCAL_STORAGE_BASE_DIR: join(home, 'data', 'files'), STREAM_MANAGER_TYPE: 'memory',
    SYSTEM_AES_KEY: config.systemAesKey, JWT_SECRET: config.jwtSecret, AUTO_MIGRATE: 'true',
    RELAY_MANAGED_DOCUMENT_PROCESS_NO_RETRY: 'true',
    CONCURRENCY_POOL_SIZE: '2', GOMAXPROCS: '2', GOMEMLIMIT: inherited.KNOWLEDGE_ENGINE_MEMORY_LIMIT || '600MiB',
    NEO4J_ENABLE: 'false', ENABLE_GRAPH_RAG: 'false', WEKNORA_SANDBOX_MODE: 'disabled',
    WEKNORA_SANDBOX_DOCKER_ENABLED: 'false', DISABLE_REGISTRATION: 'false',
    WEKNORA_TRUSTED_PROXIES: '', SSRF_WHITELIST_EXTRA: '127.0.0.1', DOCREADER_ADDR: '', OLLAMA_OPTIONAL: 'true',
  };
}
