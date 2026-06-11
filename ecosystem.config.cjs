module.exports = {
  apps: [
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
