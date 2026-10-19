module.exports = {
    apps: [
        {
            name: 'WorkBuddyApiProxy',
            script: 'src/index.js',
            interpreter: 'node',
            // 自动重启策略 — 防止进程异常退出后服务中断
            max_restarts: 10,          // 短时间内最多重启 10 次
            min_uptime: '10s',         // 运行不足 10 秒视为异常重启
            restart_delay: 3000,       // 重启间隔至少 3 秒
            max_memory_restart: '512M', // 内存超过 512MB 自动重启
            env: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info'
            },

            env_production: {
                NODE_ENV: 'production',
                LOG_LEVEL: 'info'
            }
        }
    ]
};
