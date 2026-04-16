module.exports = {
  apps: [
    {
      name: 'cdn-freeze-detect-backend',
      script: './backend/index.js',
      cwd: '/root/cdn-freeze-analyzer',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 5000
      },
      error_file: './logs/backend-error.log',
      out_file: './logs/backend-out.log',
      log_file: './logs/backend-combined.log',
      time: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      node_args: '--max-old-space-size=2048'
    },
    {
      name: 'cdn-freeze-detect-frontend',
      script: 'npx',
      args: 'serve -s build -l tcp://0.0.0.0:3000',
      cwd: '/root/cdn-freeze-analyzer/frontend',
      instances: 1,
      exec_mode: 'fork',
      // Plain HTTP on 3000 (no TLS in `serve`). Use HTTP for the UI so browser pings can hit http:// targets.
      env: {
        NODE_ENV: 'production'
      },
      error_file: '../logs/frontend-error.log',
      out_file: '../logs/frontend-out.log',
      log_file: '../logs/frontend-combined.log',
      time: true,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M'
    }
  ]
};

