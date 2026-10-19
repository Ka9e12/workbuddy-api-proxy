/**
 * RSA 4096 密钥对管理
 * 用于管理后台登录密码的加密传输
 * 客户端使用公钥加密密码，服务端使用私钥解密验证
 * @module services/gateway/rsa-keys
 */

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import {generateKeyPairSync, publicEncrypt, privateDecrypt, constants} from 'crypto';
import logger from '../../utils/logger.js';

const GATEWAY_DIR = '.gateway';
const PRIVATE_KEY_FILE = 'private_key.pem';
const PUBLIC_KEY_FILE = 'public_key.pem';

class RsaKeyManager {
    constructor() {
        this.baseDir = join(process.cwd(), GATEWAY_DIR);
        this.privateKeyFile = join(this.baseDir, PRIVATE_KEY_FILE);
        this.publicKeyFile = join(this.baseDir, PUBLIC_KEY_FILE);
        this.privateKey = null;
        this.publicKey = null;
        this._initialized = false;
    }

    /**
     * 初始化密钥对（加载已有或生成新的）
     */
    init() {
        if (this._initialized) return;

        if (!existsSync(this.baseDir)) {
            mkdirSync(this.baseDir, {recursive: true});
        }

        if (existsSync(this.privateKeyFile) && existsSync(this.publicKeyFile)) {
            this._loadKeys();
        } else {
            this._generateKeys();
        }

        this._initialized = true;
    }

    /**
     * 加载已有密钥对
     */
    _loadKeys() {
        try {
            this.privateKey = readFileSync(this.privateKeyFile, 'utf8');
            this.publicKey = readFileSync(this.publicKeyFile, 'utf8');
            logger.info('RSA key pair loaded from disk');
        } catch (err) {
            logger.error('Failed to load RSA key pair, regenerating:', err.message);
            this._generateKeys();
        }
    }

    /**
     * 生成新的 RSA 4096 密钥对
     */
    _generateKeys() {
        logger.info('Generating RSA 4096 key pair...');
        const {publicKey, privateKey} = generateKeyPairSync('rsa', {
            modulusLength: 4096,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem'
            }
        });

        this.privateKey = privateKey;
        this.publicKey = publicKey;

        writeFileSync(this.privateKeyFile, privateKey, 'utf8');
        writeFileSync(this.publicKeyFile, publicKey, 'utf8');

        logger.info('RSA 4096 key pair generated and saved to disk');
    }

    /**
     * 获取私钥 PEM
     * @returns {string} PEM 格式私钥
     */
    getPrivateKey() {
        if (!this._initialized) this.init();
        return this.privateKey;
    }

    /**
     * 获取公钥 PEM
     * @returns {string} PEM 格式公钥
     */
    getPublicKey() {
        if (!this._initialized) this.init();
        return this.publicKey;
    }

    /**
     * 使用私钥解密 RSA-OAEP 加密的数据
     * @param {string} encryptedBase64 - Base64 编码的加密数据
     * @returns {string|null} 解密后的明文，失败返回 null
     */
    decrypt(encryptedBase64) {
        try {
            const encrypted = Buffer.from(encryptedBase64, 'base64');
            const decrypted = privateDecrypt(
                {
                    key: this.privateKey,
                    padding: constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256'
                },
                encrypted
            );
            return decrypted.toString('utf8');
        } catch (err) {
            logger.warn('RSA decryption failed:', err.message);
            return null;
        }
    }

    /**
     * 使用公钥加密数据（主要用于测试）
     * @param {string} plaintext - 明文
     * @returns {string} Base64 编码的加密数据
     */
    encrypt(plaintext) {
        const encrypted = publicEncrypt(
            {
                key: this.publicKey,
                padding: constants.RSA_PKCS1_OAEP_PADDING,
                oaepHash: 'sha256'
            },
            Buffer.from(plaintext, 'utf8')
        );
        return encrypted.toString('base64');
    }
}

// 单例
export const rsaKeyManager = new RsaKeyManager();
