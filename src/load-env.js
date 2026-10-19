/**
 * .env 配置文件加载器
 * 必须在所有其他模块之前 import，确保环境变量在 ESM 静态 import 阶段就已就绪
 * @module load-env
 */

import {readFileSync} from 'fs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envFile = join(__dirname, '..', '.env');

try {
    const envContent = readFileSync(envFile, 'utf8');
    envContent.split('\n').forEach((line) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;

        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
            const envKey = key.trim();
            // 不覆盖已存在的环境变量（PM2 等进程管理器会预先设置 PORT 等变量）
            if (process.env[envKey] !== undefined) return;
            let value = valueParts.join('=').trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            process.env[envKey] = value;
        }
    });
} catch {
    // .env 文件不存在时静默忽略
}
