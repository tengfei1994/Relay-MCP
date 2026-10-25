require('dotenv').config({ path: require('node:path').join(__dirname, '.env'), quiet: true });
module.exports = {
  apps: [
    ...(process.env.KNOWLEDGE_ENGINE_ENABLED === "false" ? [] : [{
      name: "remote-ops-knowledge-engine",
      script: "scripts/knowledge-engine.mjs",
      args: "run",
      cwd: __dirname,
      interpreter: "node",
      env: { NODE_ENV: "production", KNOWLEDGE_ENGINE_HOME: process.env.KNOWLEDGE_ENGINE_HOME || require("node:path").join(__dirname, "runtime", "knowledge-engine") },
      restart_delay: 3000,
      max_restarts: 10,
      kill_timeout: 50000,
      watch: false,
      error_file: require("node:path").join(process.env.KNOWLEDGE_ENGINE_HOME || require("node:path").join(__dirname, "runtime", "knowledge-engine"), "logs", "pm2-error.log"),
      out_file: require("node:path").join(process.env.KNOWLEDGE_ENGINE_HOME || require("node:path").join(__dirname, "runtime", "knowledge-engine"), "logs", "pm2-out.log"),
    }]),
    {
      name: "remote-ops-web",
      script: "dist/server/index.js",
      cwd: __dirname,
      interpreter: "node",
      interpreter_args: "--experimental-vm-modules",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      error_file: "logs/web-error.log",
      out_file: "logs/web-out.log",
    },
    {
      name: "remote-ops-mcp",
      script: "dist/mcp/index.js",
      cwd: __dirname,
      interpreter: "node",
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      error_file: "logs/mcp-error.log",
      out_file: "logs/mcp-out.log",
    },
  ],
};
