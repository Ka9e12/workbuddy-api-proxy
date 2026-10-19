const WORKER_COUNT = 4;
const BASE_PORT = 3081;
const HOST = '127.0.0.1';
const LOG_LEVEL = 'info';
const MAX_MEMORY_RESTART = '768M';

// 生成所有 worker 端口列表（用于集群内部广播通信）
const ALL_PORTS = Array.from({length: WORKER_COUNT}, (_, i) => BASE_PORT + i).join(',');

function createWorker(index) {
    const port = BASE_PORT + index;
    return {
        name: `WorkBuddyApiProxy-${port}`,
        script: 'src/index.js',
        cwd: __dirname,
        interpreter: 'node',
        // node_args: '--use-system-ca', // 已移除：Node.js v22 不支持此选项
        exec_mode: 'fork',
        instances: 1,
        autorestart: true,
        max_restarts: 10,
        min_uptime: '10s',
        restart_delay: 3000,
        max_memory_restart: MAX_MEMORY_RESTART,
        kill_timeout: 30000,
        env: {
            NODE_ENV: 'production',
            LOG_LEVEL,
            HOST,
            PORT: String(port),
            CLUSTER_PORTS: ALL_PORTS
        }
    };
}

module.exports = {
    apps: Array.from({length: WORKER_COUNT}, (_, index) => createWorker(index))
};
